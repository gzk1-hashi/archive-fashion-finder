/**
 * Background-job dispatch — invoked by AppJobRoom (worker.ts) for every job
 * picked up from the queue. Return a value to record it as `job.result`, throw
 * to fail the job (retried up to `maxAttempts`, then marked failed), or call
 * `ctx.continue(state)` to checkpoint and resume on the next alarm.
 *
 * Jobs are enqueued only server-side (`enqueueJob` from an action), never by a
 * client — see AppJobRoom's authorizeWrite in worker.ts.
 */

import type { Job, JobContext } from 'deepspace/worker'
import type { Env } from '../worker'
import { runScanJob, SCAN_JOB } from './server/scan-job'

export async function runJob(job: Job, ctx: JobContext, env: Env): Promise<unknown> {
  switch (job.type) {
    case SCAN_JOB:
      return runScanJob(job, ctx, env)
    default:
      throw new Error(`Unknown job type: ${job.type}`)
  }
}
