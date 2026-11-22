/**
 * A hunt's scan state, read straight off the hunt row. The job writes
 * status / scanProgress / scanStage between batches, and the row arrives here
 * over the same realtime subscription as everything else — no polling, no
 * JobRoom socket, and nothing another user could see.
 */

import { Badge } from '@/components/ui'
import { isLeaseActive } from '../../lib/lease'
import { timeAgo } from '../../lib/format'
import type { HuntData } from '../../types'

interface Props {
  hunt: HuntData
  updatedAt?: string
  compact?: boolean
}

export function ScanStatus({ hunt, updatedAt, compact = false }: Props) {
  const running = isLeaseActive(hunt.status, updatedAt, Date.now())
  const pct = Math.round((hunt.scanProgress ?? 0) * 100)

  if (running) {
    return (
      <div className="flex flex-col gap-1.5" role="status" aria-live="polite">
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>{hunt.scanStage || 'Scanning'}</span>
          <span className="tabular-nums">{pct}%</span>
        </div>
        <div
          className="h-1.5 w-full overflow-hidden rounded-full bg-secondary"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={pct}
          aria-label="Scan progress"
        >
          <div className="h-full rounded-full bg-primary transition-[width] duration-500" style={{ width: `${Math.max(3, pct)}%` }} />
        </div>
      </div>
    )
  }

  if (hunt.status === 'failed') {
    return (
      <div className="flex items-center gap-2 text-xs">
        <Badge variant="destructive" size="sm">Scan failed</Badge>
        {!compact && <span className="text-muted-foreground">{hunt.lastScanSummary}</span>}
      </div>
    )
  }

  if (hunt.status === 'done' && hunt.lastScannedAt) {
    return (
      <p className="text-xs text-muted-foreground">
        Scanned {timeAgo(hunt.lastScannedAt)}
        {!compact && hunt.lastScanSummary ? ` · ${hunt.lastScanSummary}` : ''}
      </p>
    )
  }

  return <p className="text-xs text-muted-foreground">Not scanned yet</p>
}
