import { describe, expect, it } from 'vitest'
import { SCAN_ADMISSION } from '../config'
import { cooldownRemaining, isLeaseActive } from './lease'

const now = Date.parse('2026-11-21T20:00:00Z')
const ago = (ms: number) => new Date(now - ms).toISOString()

describe('isLeaseActive', () => {
  it('only queued/scanning hold the lease', () => {
    expect(isLeaseActive('idle', ago(0), now)).toBe(false)
    expect(isLeaseActive('done', ago(0), now)).toBe(false)
    expect(isLeaseActive('failed', ago(0), now)).toBe(false)
    expect(isLeaseActive('scanning', ago(1000), now)).toBe(true)
    expect(isLeaseActive('queued', ago(1000), now)).toBe(true)
  })

  it('expires a lease nobody renewed', () => {
    expect(isLeaseActive('scanning', ago(SCAN_ADMISSION.staleLeaseMs - 1), now)).toBe(true)
    expect(isLeaseActive('scanning', ago(SCAN_ADMISSION.staleLeaseMs), now)).toBe(false)
  })

  it('treats a missing timestamp as live rather than guessing', () => {
    expect(isLeaseActive('scanning', undefined, now)).toBe(true)
  })
})

describe('cooldownRemaining', () => {
  it('counts down from the last finished scan', () => {
    expect(cooldownRemaining(ago(0), now)).toBe(SCAN_ADMISSION.rescanCooldownMs)
    expect(cooldownRemaining(ago(SCAN_ADMISSION.rescanCooldownMs + 1), now)).toBe(0)
    expect(cooldownRemaining(undefined, now)).toBe(0)
  })
})
