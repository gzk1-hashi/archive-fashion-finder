import type { CollectionSchema } from 'deepspace/schema'

/**
 * seen_listings — every canonical URL a hunt has already paid to look at,
 * whether it became a match or not.
 *
 * Without it, every rescan re-buys the same model calls for the same rejects.
 * With it, a rescan only spends money on listings that are new since last time.
 *
 * Server-only: no role can read or write it from a client. The scan job reaches
 * it through the RecordRoom tools API (X-App-Action), which skips RBAC.
 */

export const SEEN_OUTCOMES = ['matched', 'low-score', 'red-flag', 'over-budget', 'off-target', 'error'] as const

export const seenSchema: CollectionSchema = {
  name: 'seen_listings',
  uniqueOn: ['huntId', 'url'],
  columns: [
    { name: 'huntId', storage: 'text', interpretation: 'plain', required: true, immutable: true, maxLength: 64 },
    { name: 'url', storage: 'text', interpretation: { kind: 'url' }, required: true, immutable: true, maxLength: 2048 },
    { name: 'outcome', storage: 'text', interpretation: { kind: 'select', options: [...SEEN_OUTCOMES] } },
  ],
  permissions: {
    viewer: { read: false, create: false, update: false, delete: false },
    member: { read: false, create: false, update: false, delete: false },
    admin: { read: false, create: false, update: false, delete: false },
  },
}
