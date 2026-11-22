/**
 * Schema invariants — the security model of the app is mostly declared in
 * src/schemas/*, so it gets tests like code does.
 */

import { lintSchemas } from 'deepspace/worker'
import { describe, expect, it } from 'vitest'
import { schemas } from './schemas'
import { HUNT_EDITABLE_FIELDS } from './schemas/hunts-schema'

const byName = (name: string) => {
  const s = schemas.find((x) => x.name === name)
  if (!s) throw new Error(`no schema ${name}`)
  return s
}
const CLIENT_ROLES = ['viewer', 'member', 'admin'] as const

describe('schemas', () => {
  it('pass the SDK schema linter with zero warnings', () => {
    expect(lintSchemas(schemas)).toEqual([])
  })

  it('every writableFields entry is a real column', () => {
    for (const schema of schemas) {
      const cols = new Set(schema.columns.map((c) => c.name))
      for (const [role, perms] of Object.entries(schema.permissions)) {
        for (const f of perms.writableFields ?? []) {
          expect(cols.has(f), `${schema.name}.${role} writes unknown field ${f}`).toBe(true)
        }
      }
    }
  })

  it('hunts: users edit search inputs only; scan state is server-owned', () => {
    const hunts = byName('hunts')
    for (const role of ['member', 'admin'] as const) {
      expect(hunts.permissions[role].writableFields).toEqual([...HUNT_EDITABLE_FIELDS])
      expect(hunts.permissions[role].read).toBe('own')
      // deletes go through the deleteHunt action so they cascade
      expect(hunts.permissions[role].delete).toBe(false)
    }
    for (const serverOwned of ['status', 'scanProgress', 'scanStage', 'lastScanSummary', 'lastScannedAt']) {
      expect(HUNT_EDITABLE_FIELDS as readonly string[]).not.toContain(serverOwned)
    }
  })

  it('matches: clients never create, and may only change status', () => {
    const matches = byName('matches')
    for (const role of CLIENT_ROLES) {
      expect(matches.permissions[role].create).toBe(false)
      expect(matches.permissions[role].read).toBe('own')
    }
    expect(matches.permissions.member.writableFields).toEqual(['status'])
    expect(matches.uniqueOn).toEqual(['huntId', 'url'])
  })

  it('seen_listings: invisible to every client role', () => {
    const seen = byName('seen_listings')
    for (const role of CLIENT_ROLES) {
      expect(seen.permissions[role]).toEqual({ read: false, create: false, update: false, delete: false })
    }
    expect(seen.uniqueOn).toEqual(['huntId', 'url'])
  })

  it('every text column a user or the model can fill is length-capped', () => {
    for (const name of ['hunts', 'matches']) {
      for (const col of byName(name).columns) {
        const userOrModelText =
          col.storage === 'text' &&
          (typeof col.interpretation === 'string' || !['json', 'select', 'datetime'].includes(col.interpretation.kind))
        if (userOrModelText) expect(col.maxLength, `${name}.${col.name}`).toBeGreaterThan(0)
      }
    }
  })
})
