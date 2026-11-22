/**
 * Row shapes for the app's collections, as the `data` half of a record
 * envelope. Kept beside — not generated from — the schemas, so they're cheap to
 * read; src/schemas.test.ts pins that every key here is a real column.
 */

import type { MarketplaceId } from './config'
import type { HUNT_STATUSES } from './schemas/hunts-schema'
import type { MATCH_STATUSES, MATCH_VERDICTS } from './schemas/matches-schema'
import type { SEEN_OUTCOMES } from './schemas/seen-schema'

export type HuntStatus = (typeof HUNT_STATUSES)[number]
export type MatchStatus = (typeof MATCH_STATUSES)[number]
export type MatchVerdict = (typeof MATCH_VERDICTS)[number]
export type SeenOutcome = (typeof SEEN_OUTCOMES)[number]

export interface HuntData {
  designer: string
  piece: string
  season?: string
  size?: string
  maxPriceUsd?: number
  refPhotoKey?: string
  // server-owned
  status?: HuntStatus
  scanProgress?: number
  scanStage?: string
  lastScanSummary?: string
  lastScannedAt?: string
}

export interface MatchData {
  huntId: string
  url: string
  title?: string
  marketplace: MarketplaceId
  priceText?: string
  priceUsd?: number
  landedUsd?: number
  imageUrl?: string
  score: number
  verdict: MatchVerdict
  reasons?: string[]
  redFlags?: string[]
  promptVersion?: string
  status?: MatchStatus
  savedAt?: string
}

export interface SeenData {
  huntId: string
  url: string
  outcome?: SeenOutcome
}

/** What the RecordRoom hands back on the server side. */
export interface Envelope<T> {
  recordId: string
  data: T
  createdBy: string
  createdAt?: string
  updatedAt?: string
}
