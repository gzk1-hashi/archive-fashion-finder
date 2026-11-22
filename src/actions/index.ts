/**
 * Server actions — POST /api/actions/:name.
 *
 * Each action receives the caller's verified `userId` and tools that reach the
 * RecordRoom with RBAC OFF (see src/server/action-routes.ts). So every action
 * here does the same three things before it touches anything:
 *   1. parse params with Zod (clients send whatever they like),
 *   2. load the target record and check it belongs to the caller,
 *   3. answer "not found" for both missing and not-yours, so the API never
 *      confirms that someone else's hunt id exists.
 */

import { enqueueJob, type ActionHandler, type ActionResult } from 'deepspace/worker'
import { z } from 'zod'
import { SCAN_ADMISSION } from '../config'
import { cooldownRemaining, isLeaseActive } from '../lib/lease'
import { scopeId } from '../server/records'
import { SCAN_JOB, type ScanPayload } from '../server/scan-job'
import type { HuntData } from '../types'
import type { Env } from '../../worker'

const HuntRef = z.object({ huntId: z.string().min(1).max(64) })

const NOT_FOUND: ActionResult = { success: false, code: 'not_found', error: 'Hunt not found.' }
const BAD_REQUEST: ActionResult = { success: false, code: 'bad_request', error: 'Invalid request.' }

/** Load a hunt and return it only if `userId` owns it. */
async function ownHunt(tools: Parameters<ActionHandler<Env>>[0]['tools'], huntId: string, userId: string) {
  const got = await tools.get<Record<string, unknown>>('hunts', huntId)
  if (!got.success || got.data.record.createdBy !== userId) return null
  return { ...got.data.record, data: got.data.record.data as unknown as HuntData }
}

/**
 * Start a scan for one of the caller's hunts. Admission control lives here,
 * not in the job, because this is the last point where saying "no" is free:
 *  - one live scan per hunt (status is a lease — see src/lib/lease.ts),
 *  - a short cooldown between scans of the same hunt,
 *  - a cap on concurrent scans per user, since every scan is owner-billed.
 */
const startScan: ActionHandler<Env> = async ({ userId, params, tools, env }) => {
  const parsed = HuntRef.safeParse(params)
  if (!parsed.success) return BAD_REQUEST
  const { huntId } = parsed.data

  const hunt = await ownHunt(tools, huntId, userId)
  if (!hunt) return NOT_FOUND

  const now = Date.now()
  if (isLeaseActive(hunt.data.status, hunt.updatedAt, now)) {
    return { success: false, code: 'scan_active', error: 'A scan is already running for this hunt.' }
  }
  const wait = cooldownRemaining(hunt.data.lastScannedAt, now)
  if (wait > 0) {
    return {
      success: false,
      code: 'cooldown',
      error: `This hunt was just scanned — try again in ${Math.ceil(wait / 1000)}s.`,
      details: { retryAfterMs: wait },
    }
  }

  const mine = await tools.query<Record<string, unknown>>('hunts', { where: { createdBy: userId }, limit: 200 })
  const active = mine.success
    ? mine.data.records.filter((r) => r.recordId !== huntId && isLeaseActive(r.data.status as HuntData['status'], r.updatedAt, now)).length
    : 0
  if (active >= SCAN_ADMISSION.maxActivePerUser) {
    return {
      success: false,
      code: 'too_many_scans',
      error: `You already have ${active} scans running. Wait for one to finish.`,
    }
  }

  const claimed = await tools.update('hunts', huntId, { status: 'queued', scanProgress: 0, scanStage: 'Queued' })
  if (!claimed.success) return { success: false, error: 'Could not start the scan.' }

  try {
    const payload: ScanPayload = { huntId, ownerId: userId }
    const jobId = await enqueueJob(env.JOB_ROOMS, scopeId(env), SCAN_JOB, payload, {
      // A scan is not safely retryable as a whole — it spends money as it
      // goes. Resumption inside one attempt is ctx.continue's job.
      maxAttempts: 1,
      enqueuedBy: userId,
    })
    return { success: true, data: { jobId } }
  } catch (err) {
    console.error(`[startScan] enqueue failed: ${err instanceof Error ? err.message : String(err)}`)
    // Release the lease as 'failed', not the previous status: flipping back to
    // 'done' would fire lastScannedAt's timestampTrigger and start a cooldown
    // for a scan that never ran.
    await tools.update('hunts', huntId, {
      status: 'failed',
      scanStage: '',
      lastScanSummary: 'The scan could not be started — try again.',
    })
    return { success: false, error: 'Could not start the scan. Try again in a moment.' }
  }
}

/**
 * Delete a hunt and everything hanging off it. Clients can't delete hunts
 * directly (the schema grants no delete) precisely so that this cascade always
 * runs: matches and seen_listings rows would otherwise be orphaned forever.
 * deleteWhere removes at most `limit` rows per call, so each collection is
 * drained in a loop until a call comes back short.
 */
const deleteHunt: ActionHandler<Env> = async ({ userId, params, tools }) => {
  const parsed = HuntRef.safeParse(params)
  if (!parsed.success) return BAD_REQUEST
  const { huntId } = parsed.data

  const hunt = await ownHunt(tools, huntId, userId)
  if (!hunt) return NOT_FOUND
  // A running scan would keep writing matches for a hunt that no longer
  // exists, re-orphaning rows behind the cascade.
  if (isLeaseActive(hunt.data.status, hunt.updatedAt, Date.now())) {
    return { success: false, code: 'scan_active', error: 'Wait for the current scan to finish, then delete.' }
  }

  const LIMIT = 500
  let removed = 0
  for (const collection of ['matches', 'seen_listings']) {
    for (let guard = 0; guard < 100; guard++) {
      const res = await tools.deleteWhere(collection, { huntId }, LIMIT)
      if (!res.success) return { success: false, error: 'Could not delete this hunt.' }
      removed += res.data.deleted
      if (res.data.deleted < LIMIT) break
    }
  }
  const gone = await tools.remove('hunts', huntId)
  if (!gone.success) return { success: false, error: 'Could not delete this hunt.' }
  return { success: true, data: { removed } }
}

export const actions: Record<string, ActionHandler<Env>> = {
  startScan,
  deleteHunt,
}
