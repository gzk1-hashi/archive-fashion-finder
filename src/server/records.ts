/**
 * Server-side record access for code that runs outside a request (the scan
 * job), built on the SDK's `buildCronContext`.
 *
 * `actingAs(env, userId)` returns a context whose record calls carry
 * `X-User-Id: userId` and `X-App-Action: true`. Two consequences, both
 * deliberate:
 *  - RBAC is OFF. The context can read and write any row in any collection, so
 *    every caller here must scope its own queries (by huntId) and check
 *    ownership itself before trusting a record.
 *  - Rows it creates are created BY `userId`. The scan job acts as the hunt's
 *    owner, so matches it writes have `createdBy = owner` and the plain
 *    `read: 'own'` rule on matches shows them to that user and nobody else —
 *    no ownerField column for a client to spoof.
 *
 * Integration calls from this context are always billed to the app owner
 * (APP_OWNER_JWT), whoever we act as.
 */

import { buildCronContext, type CronContext } from 'deepspace/worker'
import type { Env } from '../../worker'
import type { Envelope, HuntData } from '../types'

/** The app's single record/job scope, same as SCOPE_ID on the client. */
export const scopeId = (env: Pick<Env, 'DEEPSPACE_APP_ID'>): string => `app:${env.DEEPSPACE_APP_ID}`

export function actingAs(env: Env, userId: string): CronContext {
  return buildCronContext(env, userId, scopeId(env))
}

/** RecordRoom's uniqueOn conflict, as surfaced through the tools API. */
export function isDuplicate(err: unknown): boolean {
  return err instanceof Error && /\bDuplicate:/.test(err.message)
}

/** Create, treating "already exists" as success — the idempotent write the scan relies on. */
export async function createIfAbsent(ctx: CronContext, collection: string, data: Record<string, unknown>): Promise<void> {
  try {
    await ctx.records.create(collection, data)
  } catch (err) {
    if (!isDuplicate(err)) throw err
  }
}

export async function getHunt(ctx: CronContext, huntId: string): Promise<Envelope<HuntData> | null> {
  const rows = (await ctx.records.query('hunts', { where: { recordId: huntId }, limit: 1 })) as Envelope<HuntData>[]
  return rows[0] ?? null
}
