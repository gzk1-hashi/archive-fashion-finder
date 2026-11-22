/**
 * The actions are the authorization boundary (their tools run RBAC-off), so
 * their refusals are tested as carefully as their happy paths.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ActionContext, ActionTools } from 'deepspace/worker'
import { SCAN_ADMISSION } from '../config'
import type { HuntData } from '../types'
import type { Env } from '../../worker'

const enqueueJob = vi.fn(async () => 'job-1')
vi.mock('deepspace/worker', async (importOriginal) => ({
  ...(await importOriginal<typeof import('deepspace/worker')>()),
  enqueueJob: (...args: unknown[]) => enqueueJob(...(args as [])),
}))

const { actions } = await import('./index')

const ME = 'user-me'
const now = Date.now()
const iso = (msAgo: number) => new Date(now - msAgo).toISOString()

type Row = { recordId: string; createdBy: string; updatedAt: string; data: Partial<HuntData> }

function fakeTools(rows: Row[]) {
  const updates: Array<[string, Record<string, unknown>]> = []
  const tools = {
    get: vi.fn(async (_c: string, id: string) => {
      const r = rows.find((x) => x.recordId === id)
      return r ? { success: true, data: { record: { ...r, createdAt: r.updatedAt } } } : { success: false, error: 'not found' }
    }),
    query: vi.fn(async (_c: string, opts?: { where?: { createdBy?: string } }) => ({
      success: true,
      data: { records: rows.filter((r) => r.createdBy === opts?.where?.createdBy), count: 0, offset: 0 },
    })),
    update: vi.fn(async (_c: string, id: string, data: Record<string, unknown>) => {
      updates.push([id, data])
      return { success: true, data: { recordId: id } }
    }),
    deleteWhere: vi.fn(async () => ({ success: true, data: { deleted: 0 } })),
    remove: vi.fn(async (_c: string, id: string) => ({ success: true, data: { recordId: id } })),
  }
  return { tools: tools as unknown as ActionTools, updates, raw: tools }
}

const ctx = (tools: ActionTools, params: Record<string, unknown>): ActionContext<Env> => ({
  userId: ME,
  params,
  tools,
  env: { DEEPSPACE_APP_ID: 'app123', JOB_ROOMS: {} } as unknown as Env,
  callerJwt: 'jwt',
})

const hunt = (id: string, over: Partial<Row> = {}, data: Partial<HuntData> = {}): Row => ({
  recordId: id,
  createdBy: ME,
  updatedAt: iso(60 * 60_000),
  data: { designer: 'Junya Watanabe', piece: 'jacket', status: 'idle', ...data },
  ...over,
})

beforeEach(() => {
  enqueueJob.mockReset()
  enqueueJob.mockResolvedValue('job-1')
})

describe('startScan', () => {
  it('claims the hunt and enqueues a job attributed to the caller', async () => {
    const { tools, updates } = fakeTools([hunt('h1')])
    const res = await actions.startScan(ctx(tools, { huntId: 'h1' }))
    expect(res).toEqual({ success: true, data: { jobId: 'job-1' } })
    expect(updates[0]).toEqual(['h1', { status: 'queued', scanProgress: 0, scanStage: 'Queued' }])
    expect(enqueueJob).toHaveBeenCalledWith({}, 'app:app123', 'scan-hunt', { huntId: 'h1', ownerId: ME }, { maxAttempts: 1, enqueuedBy: ME })
  })

  it('answers "not found" for someone else’s hunt — same as a missing one', async () => {
    const { tools, raw } = fakeTools([hunt('theirs', { createdBy: 'user-other' })])
    const theirs = await actions.startScan(ctx(tools, { huntId: 'theirs' }))
    const missing = await actions.startScan(ctx(tools, { huntId: 'nope' }))
    expect(theirs).toEqual(missing)
    expect(theirs).toMatchObject({ success: false, code: 'not_found' })
    expect(raw.update).not.toHaveBeenCalled()
    expect(enqueueJob).not.toHaveBeenCalled()
  })

  it.each([[{}], [{ huntId: '' }], [{ huntId: 42 }], [{ huntId: 'x'.repeat(65) }]])('rejects malformed params %j', async (params) => {
    const { tools } = fakeTools([hunt('h1')])
    expect(await actions.startScan(ctx(tools, params))).toMatchObject({ success: false, code: 'bad_request' })
  })

  it('refuses while a live scan holds the lease, but not a dead one', async () => {
    const live = fakeTools([hunt('h1', { updatedAt: iso(1000) }, { status: 'scanning' })])
    expect(await actions.startScan(ctx(live.tools, { huntId: 'h1' }))).toMatchObject({ code: 'scan_active' })

    const dead = fakeTools([hunt('h1', { updatedAt: iso(SCAN_ADMISSION.staleLeaseMs + 1) }, { status: 'scanning' })])
    expect(await actions.startScan(ctx(dead.tools, { huntId: 'h1' }))).toMatchObject({ success: true })
  })

  it('enforces the rescan cooldown', async () => {
    const { tools } = fakeTools([hunt('h1', {}, { status: 'done', lastScannedAt: iso(10_000) })])
    const res = await actions.startScan(ctx(tools, { huntId: 'h1' }))
    expect(res).toMatchObject({ success: false, code: 'cooldown' })
  })

  it('caps concurrent scans per user', async () => {
    const busy = (id: string) => hunt(id, { updatedAt: iso(1000) }, { status: 'scanning' })
    const rows = [hunt('h1'), ...Array.from({ length: SCAN_ADMISSION.maxActivePerUser }, (_, i) => busy(`b${i}`))]
    const { tools } = fakeTools(rows)
    expect(await actions.startScan(ctx(tools, { huntId: 'h1' }))).toMatchObject({ code: 'too_many_scans' })
  })

  it('releases the lease as failed (not done) when the enqueue fails', async () => {
    enqueueJob.mockRejectedValueOnce(new Error('room unavailable'))
    const { tools, updates } = fakeTools([hunt('h1', {}, { status: 'done' })])
    const res = await actions.startScan(ctx(tools, { huntId: 'h1' }))
    expect(res).toMatchObject({ success: false })
    expect(updates.at(-1)?.[1]).toMatchObject({ status: 'failed' })
  })
})

describe('deleteHunt', () => {
  it('cascades matches and seen rows, scoped to the hunt, then removes it', async () => {
    const { tools, raw } = fakeTools([hunt('h1')])
    const res = await actions.deleteHunt(ctx(tools, { huntId: 'h1' }))
    expect(res).toMatchObject({ success: true })
    expect(raw.deleteWhere).toHaveBeenCalledWith('matches', { huntId: 'h1' }, 500)
    expect(raw.deleteWhere).toHaveBeenCalledWith('seen_listings', { huntId: 'h1' }, 500)
    expect(raw.remove).toHaveBeenCalledWith('hunts', 'h1')
  })

  it('drains in pages until a page comes back short', async () => {
    const { tools, raw } = fakeTools([hunt('h1')])
    raw.deleteWhere
      .mockResolvedValueOnce({ success: true, data: { deleted: 500 } })
      .mockResolvedValueOnce({ success: true, data: { deleted: 12 } })
    const res = await actions.deleteHunt(ctx(tools, { huntId: 'h1' }))
    expect(res).toEqual({ success: true, data: { removed: 512 } })
    expect(raw.deleteWhere).toHaveBeenCalledTimes(3) // matches ×2, seen ×1
  })

  it('will not delete someone else’s hunt, or one mid-scan', async () => {
    const theirs = fakeTools([hunt('h1', { createdBy: 'user-other' })])
    expect(await actions.deleteHunt(ctx(theirs.tools, { huntId: 'h1' }))).toMatchObject({ code: 'not_found' })
    expect(theirs.raw.deleteWhere).not.toHaveBeenCalled()

    const busy = fakeTools([hunt('h1', { updatedAt: iso(1000) }, { status: 'scanning' })])
    expect(await actions.deleteHunt(ctx(busy.tools, { huntId: 'h1' }))).toMatchObject({ code: 'scan_active' })
    expect(busy.raw.remove).not.toHaveBeenCalled()
  })
})
