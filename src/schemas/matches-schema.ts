import type { CollectionSchema } from 'deepspace/schema'
import { MARKETPLACE_IDS } from '../config'

/**
 * matches — listings the scan job scored above the bar for one hunt.
 *
 * Rows are written by the job *as the hunt's owner* (the job's record context
 * sends the owner's id as X-User-Id), so `createdBy` is the owner and plain
 * `read: 'own'` scopes the board without a spoofable ownerField column.
 *
 * Clients can never create a match, and the only field they can change is
 * `status` (save / dismiss). Score, verdict and price are the model's and the
 * pricing engine's, not the user's.
 *
 * `uniqueOn: ['huntId', 'url']` turns "don't show the same listing twice" into
 * a UNIQUE index inside the hunt's SQLite table instead of a hope. `url` is
 * the canonical form from src/lib/listings.ts, so tracking params and Grailed
 * slugs can't sneak a duplicate past it.
 */

export const MATCH_STATUSES = ['new', 'saved', 'dismissed'] as const
export const MATCH_VERDICTS = ['exact', 'likely', 'possible'] as const
export const MATCH_AVAILABILITY = ['available', 'sold'] as const

export const matchesSchema: CollectionSchema = {
  name: 'matches',
  uniqueOn: ['huntId', 'url'],
  columns: [
    { name: 'huntId', storage: 'text', interpretation: 'plain', required: true, immutable: true, maxLength: 64 },
    { name: 'url', storage: 'text', interpretation: { kind: 'url' }, required: true, immutable: true, maxLength: 2048 },
    { name: 'title', storage: 'text', interpretation: 'plain', maxLength: 300 },
    {
      name: 'marketplace',
      storage: 'text',
      interpretation: { kind: 'select', options: [...MARKETPLACE_IDS] },
      required: true,
    },
    // What the listing said, verbatim ("¥38,000", "$450") — shown next to the
    // converted figure so the user can sanity-check the conversion.
    { name: 'priceText', storage: 'text', interpretation: 'plain', maxLength: 60 },
    { name: 'priceUsd', storage: 'number', interpretation: { kind: 'currency', symbol: '$', decimals: 0 } },
    // Item + proxy fee + domestic + international shipping, in USD. This is the
    // number compared against the hunt's max price.
    { name: 'landedUsd', storage: 'number', interpretation: { kind: 'currency', symbol: '$', decimals: 0 } },
    { name: 'imageUrl', storage: 'text', interpretation: { kind: 'url' }, maxLength: 2048 },
    { name: 'score', storage: 'number', interpretation: 'plain', required: true },
    {
      name: 'verdict',
      storage: 'text',
      interpretation: { kind: 'select', options: [...MATCH_VERDICTS] },
      required: true,
    },
    // JSON arrays of short strings. Stored as TEXT, parsed back to arrays on read.
    { name: 'reasons', storage: 'text', interpretation: { kind: 'json' } },
    { name: 'redFlags', storage: 'text', interpretation: { kind: 'json' } },
    // Which prompt produced this verdict — lets a later prompt change be
    // compared against old rows instead of silently mixing them.
    { name: 'promptVersion', storage: 'text', interpretation: 'plain', maxLength: 20 },
    // Server-owned. Every match was proven for sale when it was written; each
    // rescan re-opens the page and flips this to 'sold' when it's gone, so the
    // board never offers a piece that can't be bought.
    {
      name: 'availability',
      storage: 'text',
      interpretation: { kind: 'select', options: [...MATCH_AVAILABILITY] },
      default: 'available',
    },
    {
      name: 'status',
      storage: 'text',
      interpretation: { kind: 'select', options: [...MATCH_STATUSES] },
      default: 'new',
    },
    // Stamped by the RecordRoom when status becomes 'saved'.
    {
      name: 'savedAt',
      storage: 'text',
      interpretation: { kind: 'datetime' },
      timestampTrigger: { field: 'status', value: 'saved' },
    },
  ],
  permissions: {
    viewer: { read: 'own', create: false, update: false, delete: false },
    member: { read: 'own', create: false, update: 'own', delete: 'own', writableFields: ['status'] },
    admin: { read: 'own', create: false, update: 'own', delete: 'own', writableFields: ['status'] },
  },
}
