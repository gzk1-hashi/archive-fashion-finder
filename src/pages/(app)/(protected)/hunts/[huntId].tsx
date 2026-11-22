/**
 * /hunts/:huntId — the live board for one hunt.
 *
 * Two realtime subscriptions drive the whole page:
 *  - `hunts` (own rows) → the header and scan progress,
 *  - `matches` where { huntId } → the cards. The scan job inserts match rows
 *    as it scores; each one arrives here the moment the RecordRoom commits it,
 *    so the board fills in while the scan is still running.
 *
 * Save/dismiss is a plain `put` on the match — the schema lets the owner write
 * `status` and nothing else, so there's no action needed for it.
 */

import { useMemo, useState } from 'react'
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom'
import { useMutations, useQuery } from 'deepspace'
import { Button, ConfirmModal, EmptyState, Tabs, TabsList, TabsTrigger, useToast } from '@/components/ui'
import { MatchCard } from '../../../../components/hunts/MatchCard'
import { ScanStatus } from '../../../../components/hunts/ScanStatus'
import { deleteHunt, startScan } from '../../../../lib/api'
import { isLeaseActive } from '../../../../lib/lease'
import type { HuntData, MatchData, MatchStatus } from '../../../../types'

type Tab = 'new' | 'saved' | 'sold' | 'dismissed'
const VERDICT_RANK: Record<MatchData['verdict'], number> = { exact: 0, likely: 1, possible: 2 }

export default function HuntBoardPage() {
  const { huntId = '' } = useParams<{ huntId: string }>()
  const navigate = useNavigate()
  // Set by the create form: the row is committed, but this page's hunts
  // subscription may not have delivered it yet — show a skeleton, not a 404.
  const justCreated = (useLocation().state as { justCreated?: boolean } | null)?.justCreated === true
  const { error: toastError, success } = useToast()

  const { records: hunts, status: huntsStatus } = useQuery<HuntData>('hunts')
  const hunt = hunts.find((h) => h.recordId === huntId)

  const { records: matchRows, status: matchStatus } = useQuery<MatchData>('matches', { where: { huntId } })
  const { put } = useMutations<MatchData>('matches')

  const [tab, setTab] = useState<Tab>('new')
  const [starting, setStarting] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)

  // Best first: verdict tier, then score, then newest. Sorted here rather than
  // by the query so live inserts land in the right place without a refetch.
  const byTab = useMemo(() => {
    const sorted = [...matchRows].sort(
      (a, b) =>
        VERDICT_RANK[a.data.verdict] - VERDICT_RANK[b.data.verdict] ||
        b.data.score - a.data.score ||
        b.createdAt.localeCompare(a.createdAt),
    )
    // Sold pieces leave New and Saved the moment a rescan finds them gone —
    // they're kept in their own tab rather than deleted, so a saved piece
    // never silently disappears.
    const groups: Record<Tab, typeof sorted> = { new: [], saved: [], sold: [], dismissed: [] }
    for (const m of sorted) {
      const status = m.data.status ?? 'new'
      if (status === 'dismissed') groups.dismissed.push(m)
      else if (m.data.availability === 'sold') groups.sold.push(m)
      else groups[status].push(m)
    }
    return groups
  }, [matchRows])

  if (huntsStatus === 'loading' || (!hunt && justCreated)) return <div className="mx-auto mt-10 h-32 max-w-5xl animate-pulse rounded-lg bg-secondary" aria-busy="true" />
  if (!hunt) {
    return (
      <EmptyState
        className="mt-10"
        title="Hunt not found"
        description="It may have been deleted, or it belongs to another account."
        action={{ label: 'Back to hunts', onClick: () => navigate('/hunts') }}
      />
    )
  }

  const running = isLeaseActive(hunt.data.status, hunt.updatedAt, Date.now())

  async function scan() {
    setStarting(true)
    const res = await startScan(huntId)
    setStarting(false)
    if (!res.success) toastError('Scan not started', res.error)
  }

  async function remove() {
    setDeleting(true)
    const res = await deleteHunt(huntId)
    setDeleting(false)
    setConfirmDelete(false)
    if (!res.success) return toastError('Could not delete', res.error)
    success('Hunt deleted')
    navigate('/hunts')
  }

  const setStatus = (recordId: string) => (status: MatchStatus) => {
    void put(recordId, { status })
  }

  const visible = byTab[tab]

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-8 sm:px-6">
      <Link to="/hunts" className="text-xs text-muted-foreground hover:text-foreground">
        ← All hunts
      </Link>

      <header className="flex flex-col gap-4 rounded-lg border border-border bg-card p-5 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 flex-1 flex-col gap-3">
          <div>
            <h1 className="text-xl font-semibold text-foreground">
              {hunt.data.designer} — {hunt.data.piece}
            </h1>
            <p className="text-sm text-muted-foreground">
              {[hunt.data.season, hunt.data.size && `size ${hunt.data.size}`, hunt.data.maxPriceUsd && `≤ $${hunt.data.maxPriceUsd} landed`]
                .filter(Boolean)
                .join(' · ') || 'Any season, any size, any price'}
            </p>
          </div>
          <ScanStatus hunt={hunt.data} updatedAt={hunt.updatedAt} />
        </div>
        <div className="flex shrink-0 gap-2">
          <Button onClick={scan} loading={starting} disabled={running || starting}>
            {running ? 'Scanning…' : hunt.data.lastScannedAt ? 'Rescan' : 'Scan now'}
          </Button>
          <Button variant="ghost" onClick={() => setConfirmDelete(true)}>
            Delete
          </Button>
        </div>
      </header>

      <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)}>
        <TabsList>
          <TabsTrigger value="new">New ({byTab.new.length})</TabsTrigger>
          <TabsTrigger value="saved">Saved ({byTab.saved.length})</TabsTrigger>
          {byTab.sold.length > 0 && <TabsTrigger value="sold">Sold ({byTab.sold.length})</TabsTrigger>}
          <TabsTrigger value="dismissed">Dismissed ({byTab.dismissed.length})</TabsTrigger>
        </TabsList>
      </Tabs>

      {matchStatus === 'ready' && visible.length === 0 && (
        <EmptyState
          title={tab === 'new' ? (running ? 'Looking…' : 'No new matches') : `Nothing ${tab}`}
          description={
            tab === 'new'
              ? running
                ? 'Matches appear here as soon as each listing is checked.'
                : 'Rescan later — new listings show up every day, and anything already checked is skipped.'
              : undefined
          }
        />
      )}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {visible.map((m) => (
          <MatchCard key={m.recordId} match={m.data} onStatus={setStatus(m.recordId)} />
        ))}
      </div>

      <ConfirmModal
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        onConfirm={remove}
        loading={deleting}
        title="Delete this hunt?"
        description="Its matches and scan history are deleted too. This can't be undone."
        confirmText="Delete hunt"
      />
    </div>
  )
}
