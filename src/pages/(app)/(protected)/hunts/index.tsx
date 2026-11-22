/**
 * /hunts — the user's hunts, newest first, plus the form to start a new one.
 *
 * `useQuery('hunts')` needs no `where`: the schema's `read: 'own'` makes the
 * RecordRoom return only rows this user created, and the subscription is live,
 * so a scan's progress shows up on these cards as the job writes it.
 */

import { Link, useNavigate } from 'react-router-dom'
import { useQuery } from 'deepspace'
import { EmptyState, useToast } from '@/components/ui'
import { HuntForm } from '../../../../components/hunts/HuntForm'
import { ScanStatus } from '../../../../components/hunts/ScanStatus'
import { startScan } from '../../../../lib/api'
import type { HuntData } from '../../../../types'

export default function HuntsPage() {
  const navigate = useNavigate()
  const { warning } = useToast()
  const { records: hunts, status } = useQuery<HuntData>('hunts', { orderBy: 'createdAt', orderDir: 'desc' })

  async function onCreated(huntId: string) {
    navigate(`/hunts/${huntId}`, { state: { justCreated: true } })
    const res = await startScan(huntId)
    if (!res.success) warning('Hunt saved, but the scan did not start', res.error)
  }

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-8 px-4 py-8 sm:px-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold text-foreground">Hunts</h1>
        <p className="text-sm text-muted-foreground">
          Describe a piece once. Each scan searches Grailed and eBay in English and Mercari, Yahoo! Auctions, Rakuma and 2nd Street in
          Japanese, then has a model check every listing against what you asked for.
        </p>
      </header>

      <section className="rounded-lg border border-border bg-card p-5" aria-labelledby="new-hunt">
        <h2 id="new-hunt" className="mb-4 text-sm font-semibold text-foreground">
          New hunt
        </h2>
        <HuntForm onCreated={onCreated} />
      </section>

      <section aria-labelledby="your-hunts" className="flex flex-col gap-3">
        <h2 id="your-hunts" className="text-sm font-semibold text-foreground">
          Your hunts
        </h2>
        {status === 'loading' && <div className="h-24 animate-pulse rounded-lg bg-secondary" aria-busy="true" />}
        {status === 'error' && <p className="text-sm text-destructive">Couldn&apos;t load your hunts. Refresh to try again.</p>}
        {status === 'ready' && hunts.length === 0 && (
          <EmptyState title="No hunts yet" description="Start with a designer and a piece — season, size and budget make the results sharper." />
        )}
        <ul className="grid gap-3 sm:grid-cols-2">
          {hunts.map((h) => (
            <li key={h.recordId}>
              <Link
                to={`/hunts/${h.recordId}`}
                className="flex h-full flex-col gap-3 rounded-lg border border-border bg-card p-4 transition-colors hover:border-primary/50"
              >
                <div>
                  <p className="text-sm font-semibold text-foreground">{h.data.designer}</p>
                  <p className="text-sm text-muted-foreground">
                    {h.data.piece}
                    {h.data.season ? ` · ${h.data.season}` : ''}
                    {h.data.size ? ` · size ${h.data.size}` : ''}
                    {h.data.maxPriceUsd ? ` · ≤ $${h.data.maxPriceUsd}` : ''}
                  </p>
                </div>
                <ScanStatus hunt={h.data} updatedAt={h.updatedAt} compact />
              </Link>
            </li>
          ))}
        </ul>
      </section>
    </div>
  )
}
