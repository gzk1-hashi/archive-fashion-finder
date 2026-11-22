/**
 * A hunt's status doubles as a lease on "the one scan allowed to run for it".
 * Leases that stop being renewed (the job died without cleaning up) expire, so
 * a crash can never lock a user out of their own hunt. Shared by the startScan
 * action and the board, so both agree on what "running" means.
 */

import { SCAN_ADMISSION } from '../config'
import type { HuntStatus } from '../types'

export function isLeaseActive(status: HuntStatus | undefined, updatedAt: string | undefined, now: number): boolean {
  if (status !== 'queued' && status !== 'scanning') return false
  const touched = updatedAt ? Date.parse(updatedAt) : NaN
  if (Number.isNaN(touched)) return true // no timestamp → be conservative, treat as live
  return now - touched < SCAN_ADMISSION.staleLeaseMs
}

/** Milliseconds until this hunt may be scanned again (0 = now). */
export function cooldownRemaining(lastScannedAt: string | undefined, now: number): number {
  const at = lastScannedAt ? Date.parse(lastScannedAt) : NaN
  if (Number.isNaN(at)) return 0
  return Math.max(0, SCAN_ADMISSION.rescanCooldownMs - (now - at))
}
