/**
 * One scored listing on the board. Everything shown came from outside (search
 * results) or from the model, so: text is rendered as text (never HTML), links
 * open with noopener/noreferrer, and images load with no referrer — which is
 * also what most marketplace CDNs need to serve a hot-linked photo.
 */

import { useState } from 'react'
import { Badge, Button } from '@/components/ui'
import { MARKETPLACES } from '../../config'
import { formatUsd } from '../../lib/pricing'
import type { MatchData, MatchStatus } from '../../types'

const VERDICT_STYLE: Record<MatchData['verdict'], { label: string; variant: 'success' | 'info' | 'secondary' }> = {
  exact: { label: 'Exact', variant: 'success' },
  likely: { label: 'Likely', variant: 'info' },
  possible: { label: 'Possible', variant: 'secondary' },
}

interface Props {
  match: MatchData
  onStatus: (status: MatchStatus) => void
}

export function MatchCard({ match, onStatus }: Props) {
  const [imgFailed, setImgFailed] = useState(false)
  const verdict = VERDICT_STYLE[match.verdict]
  const market = MARKETPLACES[match.marketplace]
  const reasons = Array.isArray(match.reasons) ? match.reasons : []
  const redFlags = Array.isArray(match.redFlags) ? match.redFlags : []

  return (
    <article className="flex flex-col overflow-hidden rounded-lg border border-border bg-card">
      <a
        href={match.url}
        target="_blank"
        rel="noopener noreferrer"
        className="relative block aspect-[4/5] bg-secondary"
        aria-label={`Open listing on ${market?.label ?? 'marketplace'}`}
      >
        {match.imageUrl && !imgFailed ? (
          <img
            src={match.imageUrl}
            alt=""
            loading="lazy"
            decoding="async"
            referrerPolicy="no-referrer"
            onError={() => setImgFailed(true)}
            className="h-full w-full object-cover"
          />
        ) : (
          <div className="flex h-full items-center justify-center text-xs text-muted-foreground">No photo in search result</div>
        )}
        <div className="absolute left-2 top-2 flex gap-1.5">
          <Badge variant={verdict.variant} size="sm">
            {verdict.label} · {match.score}
          </Badge>
        </div>
      </a>

      <div className="flex flex-1 flex-col gap-2 p-3">
        <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
          <span>{market?.label}</span>
          {match.priceText && <span className="tabular-nums">{match.priceText}</span>}
        </div>
        <a href={match.url} target="_blank" rel="noopener noreferrer" className="line-clamp-2 text-sm font-medium text-foreground hover:underline">
          {match.title || match.url}
        </a>
        {match.landedUsd !== undefined && (
          <p
            className="text-xs text-muted-foreground"
            title={market?.viaProxy ? 'Item + proxy fee + domestic & international shipping, estimated' : 'Item + estimated shipping'}
          >
            ≈ {formatUsd(match.landedUsd)} landed
          </p>
        )}
        {reasons.length > 0 && (
          <ul className="list-disc space-y-0.5 pl-4 text-xs text-muted-foreground">
            {reasons.slice(0, 3).map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        )}
        {redFlags.length > 0 && (
          <ul className="space-y-0.5 text-xs text-warning">
            {redFlags.slice(0, 2).map((r) => (
              <li key={r}>⚠ {r}</li>
            ))}
          </ul>
        )}

        <div className="mt-auto flex gap-2 pt-2">
          {match.status === 'saved' || match.status === 'dismissed' ? (
            <Button size="sm" variant="ghost" className="flex-1" onClick={() => onStatus('new')}>
              Move back to new
            </Button>
          ) : (
            <>
              <Button size="sm" className="flex-1" onClick={() => onStatus('saved')}>
                Save
              </Button>
              <Button size="sm" variant="outline" className="flex-1" onClick={() => onStatus('dismissed')}>
                Dismiss
              </Button>
            </>
          )}
        </div>
      </div>
    </article>
  )
}
