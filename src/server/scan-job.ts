/**
 * The `scan-hunt` background job: wires the scan engine to the platform.
 *
 * Runs inside AppJobRoom's alarm. Each invocation runs one slice of the engine
 * and either finishes the hunt or checkpoints with `ctx.continue(state)`, which
 * the JobRoom persists and hands back as `job.resumeFrom` on the next alarm.
 *
 * Trust: the payload came from our own startScan action, but the job still
 * re-checks that the hunt exists and belongs to the user the job was enqueued
 * by. The record context it uses has RBAC off; this check is the only thing
 * standing between a forged payload and someone else's hunt.
 */

import type { Job, JobContext } from 'deepspace/worker'
import { z } from 'zod'
import { FUNNEL } from '../config'
import { normalizeSearchResponse } from '../lib/listings'
import type { PlannedQuery } from '../lib/queries'
import type { HuntData } from '../types'
import type { Env } from '../../worker'
import { initialState, progressOf, runSlice, summaryOf, type ScanPorts, type ScanState } from './scan-engine'
import { actingAs, createIfAbsent, getHunt } from './records'
import { createScorer } from './score'

export const SCAN_JOB = 'scan-hunt'

export const ScanPayload = z.object({
  huntId: z.string().min(1).max(64),
  ownerId: z.string().min(1).max(128),
})
export type ScanPayload = z.infer<typeof ScanPayload>

/** Minimal structural check on a checkpoint before trusting it. */
function isState(v: unknown): v is ScanState {
  return !!v && typeof v === 'object' && (v as ScanState).v === 1 && typeof (v as ScanState).phase === 'string'
}

export async function runScanJob(job: Job, ctx: JobContext, env: Env): Promise<unknown> {
  const { huntId, ownerId } = ScanPayload.parse(job.payload)
  if (job.enqueuedBy && job.enqueuedBy !== ownerId) throw new Error('scan: payload owner does not match enqueuer')

  const records = actingAs(env, ownerId)
  const hunt = await getHunt(records, huntId)
  if (!hunt || hunt.createdBy !== ownerId) throw new Error('scan: hunt not found for owner')

  const patchHunt = (patch: Partial<HuntData>) => records.records.update('hunts', huntId, patch as Record<string, unknown>)

  let state: ScanState
  if (isState(job.resumeFrom)) {
    state = job.resumeFrom
  } else {
    state = initialState(hunt.data)
    await patchHunt({ status: 'scanning', scanProgress: progressOf(state), scanStage: 'Planning searches' })
  }

  const score = createScorer(env, ctx.signal)
  const ports: ScanPorts = {
    async search(q: PlannedQuery) {
      const raw = await records.integrations.call('firecrawl/search', {
        query: q.query,
        limit: FUNNEL.resultsPerQuery,
        // Snippet-only: a scrape per hit would multiply cost and truncate the
        // result set to whatever could be scraped in time.
        scrapeOptions: { formats: [] },
      })
      return normalizeSearchResponse(raw, q.marketplace)
    },
    score,
    async loadSeen() {
      const rows = (await records.records.query('seen_listings', { where: { huntId }, limit: 5000 })) as Array<{
        data: { url: string }
      }>
      return new Set(rows.map((r) => r.data.url))
    },
    writeMatch: (row) => createIfAbsent(records, 'matches', { huntId, ...row }),
    writeSeen: (url, outcome) => createIfAbsent(records, 'seen_listings', { huntId, url, outcome }),
    async report(progress, stage) {
      // The JobRoom broadcast is visible to every queue subscriber, so it gets
      // a number and a generic word; the detailed stage goes on the hunt row,
      // which only its owner can read.
      ctx.progress(progress, 'scanning')
      await patchHunt({ scanProgress: progress, scanStage: stage })
    },
    now: () => Date.now(),
    signal: ctx.signal,
  }

  try {
    state = await runSlice(state, ports)
  } catch (err) {
    await patchHunt({ status: 'failed', scanStage: 'Scan failed', lastScanSummary: 'Something went wrong — try again.' })
    throw err
  }

  if (state.phase !== 'done') {
    ctx.continue(state, { afterMs: 0 })
    return undefined
  }

  const failed = state.stoppedBecause === 'provider-failures' && state.stats.scored === 0
  await patchHunt({
    status: failed ? 'failed' : 'done',
    scanProgress: 1,
    scanStage: failed ? 'Scan failed' : 'Done',
    lastScanSummary: summaryOf(state),
  })
  return { stats: state.stats, spentUsd: Number(state.spentUsd.toFixed(4)), stoppedBecause: state.stoppedBecause ?? null }
}
