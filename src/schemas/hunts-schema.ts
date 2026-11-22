import type { CollectionSchema } from 'deepspace/schema'

/**
 * hunts — one row per "thing I'm looking for".
 *
 * Ownership is the row creator (no ownerField), so `read: 'own'` means a user
 * only ever sees hunts they created. The client may edit the search inputs;
 * everything that describes a scan (status, progress, summary, timestamps) is
 * written only by the scan job, which goes through the RecordRoom tools API
 * with X-App-Action and therefore isn't bound by writableFields.
 */

/** Columns a signed-in user may set on create/update. Everything else is server-owned. */
export const HUNT_EDITABLE_FIELDS = [
  'designer',
  'piece',
  'season',
  'size',
  'maxPriceUsd',
  'refPhotoKey',
] as const

export const HUNT_STATUSES = ['idle', 'queued', 'scanning', 'done', 'failed'] as const

export const huntsSchema: CollectionSchema = {
  name: 'hunts',
  columns: [
    { name: 'designer', storage: 'text', interpretation: 'plain', required: true, maxLength: 80 },
    { name: 'piece', storage: 'text', interpretation: 'plain', required: true, maxLength: 120 },
    { name: 'season', storage: 'text', interpretation: 'plain', maxLength: 20 },
    { name: 'size', storage: 'text', interpretation: 'plain', maxLength: 20 },
    {
      name: 'maxPriceUsd',
      storage: 'number',
      interpretation: { kind: 'currency', symbol: '$', decimals: 0 },
    },
    { name: 'refPhotoKey', storage: 'text', interpretation: 'plain', maxLength: 300 },
    {
      name: 'status',
      storage: 'text',
      interpretation: { kind: 'select', options: [...HUNT_STATUSES] },
      default: 'idle',
    },
    // 0..1, written by the job between batches so the board can draw a real
    // progress bar off the same realtime subscription that streams matches.
    { name: 'scanProgress', storage: 'number', interpretation: { kind: 'percent' }, default: 0 },
    // Short, user-facing stage label ("Searching Japanese marketplaces").
    { name: 'scanStage', storage: 'text', interpretation: 'plain', maxLength: 80 },
    // One-line result of the last finished scan ("38 listings checked · 4 matches").
    { name: 'lastScanSummary', storage: 'text', interpretation: 'plain', maxLength: 160 },
    // Stamped by the RecordRoom itself the moment status flips to 'done' —
    // no clock reads in the job, and it can't drift from the status change.
    {
      name: 'lastScannedAt',
      storage: 'text',
      interpretation: { kind: 'datetime' },
      timestampTrigger: { field: 'status', value: 'done' },
    },
  ],
  permissions: {
    viewer: { read: 'own', create: false, update: false, delete: false },
    // No client delete: deleting a hunt goes through the deleteHunt action so
    // its matches and seen_listings rows are removed with it.
    member: {
      read: 'own',
      create: true,
      update: 'own',
      delete: false,
      writableFields: [...HUNT_EDITABLE_FIELDS],
    },
    admin: {
      read: 'own',
      create: true,
      update: 'own',
      delete: false,
      writableFields: [...HUNT_EDITABLE_FIELDS],
    },
  },
}
