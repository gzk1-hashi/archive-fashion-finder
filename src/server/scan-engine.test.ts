import { describe, expect, it, vi } from 'vitest'
import { FUNNEL, SCAN_BUDGET_USD, SEARCH_COST_USD } from '../config'
import type { Candidate } from '../lib/filter'
import type { Listing } from '../lib/listings'
import type { PlannedQuery } from '../lib/queries'
import type { Verdict } from '../lib/verdict'
import type { HuntData, MatchData, SeenOutcome } from '../types'
import { initialState, progressOf, runSlice, summaryOf, type ScanPorts } from './scan-engine'

const hunt: HuntData = { designer: 'Junya Watanabe', piece: 'patchwork denim jacket', season: 'SS02', maxPriceUsd: 500 }

/** A Grailed hit for query #n that passes the free filter. */
const hit = (n: number, title = `Junya Watanabe SS02 patchwork denim jacket #${n}`): Listing => ({
  url: `https://grailed.com/listings/${1000 + n}`,
  marketplace: 'grailed',
  title,
  snippet: '$300',
})

function fakePorts(over: Partial<ScanPorts> = {}) {
  let clock = 0
  let searches = 0
  const matches: Array<Omit<MatchData, 'huntId'>> = []
  const seen: Array<[string, SeenOutcome]> = []
  const reports: number[] = []
  const ports: ScanPorts = {
    // Three fresh listings per query, so a scan has more candidates than one scoring batch.
    search: vi.fn(async (_q: PlannedQuery) => {
      const i = ++searches
      return [hit(i * 10 + 1), hit(i * 10 + 2), hit(i * 10 + 3)]
    }),
    score: vi.fn(async (_h, c: Candidate) => ({
      verdict: { score: 82, verdict: 'likely', reasons: [`saw ${c.url}`], redFlags: [] } satisfies Verdict,
      costUsd: 0.0004,
    })),
    loadSeen: vi.fn(async () => new Set<string>()),
    writeMatch: vi.fn(async (row) => void matches.push(row)),
    writeSeen: vi.fn(async (url, outcome) => void seen.push([url, outcome])),
    report: vi.fn(async (p) => void reports.push(p)),
    now: () => (clock += 1),
    ...over,
  }
  return { ports, matches, seen, reports }
}

async function runToEnd(ports: ScanPorts, sliceMs = 1e9) {
  let state = initialState(hunt)
  let slices = 0
  while (state.phase !== 'done' && slices < 100) {
    state = await runSlice(state, ports, sliceMs)
    slices++
  }
  return { state, slices }
}

describe('scan engine', () => {
  it('runs a full scan: search → filter → score → board', async () => {
    const { ports, matches, seen } = fakePorts()
    const { state } = await runToEnd(ports)

    expect(state.phase).toBe('done')
    expect(ports.search).toHaveBeenCalledTimes(state.queries.length)
    expect(matches.length).toBe(state.stats.matched)
    expect(matches.length).toBeGreaterThan(0)
    expect(matches[0]).toMatchObject({ marketplace: 'grailed', verdict: 'likely', score: 82, priceText: '$300', promptVersion: 'v1' })
    expect(seen.every(([, o]) => o === 'matched')).toBe(true)
    expect(summaryOf(state)).toMatch(/match/)
  })

  it('resumes across slices without repeating paid work', async () => {
    const one = fakePorts()
    const many = fakePorts()
    const a = await runToEnd(one.ports)
    // Every search/score step costs 1 clock tick; a 3-tick slice forces many checkpoints.
    const b = await runToEnd(many.ports, 3)

    expect(b.slices).toBeGreaterThan(3)
    expect(many.ports.search).toHaveBeenCalledTimes((one.ports.search as ReturnType<typeof vi.fn>).mock.calls.length)
    expect(many.ports.score).toHaveBeenCalledTimes((one.ports.score as ReturnType<typeof vi.fn>).mock.calls.length)
    expect(b.state.stats).toEqual(a.state.stats)
  })

  it('does not mutate the state it was given', async () => {
    const { ports } = fakePorts()
    const start = initialState(hunt)
    const snapshot = structuredClone(start)
    await runSlice(start, ports)
    expect(start).toEqual(snapshot)
  })

  it('stops paying after consecutive provider failures', async () => {
    const { ports, matches } = fakePorts({
      search: vi.fn(async () => {
        throw new Error('402 Payment Required')
      }),
    })
    const { state } = await runToEnd(ports)

    expect(ports.search).toHaveBeenCalledTimes(FUNNEL.maxConsecutiveFailures)
    expect(state.stoppedBecause).toBe('provider-failures')
    expect(state.spentUsd).toBeCloseTo(SEARCH_COST_USD.failed * FUNNEL.maxConsecutiveFailures)
    expect(matches).toHaveLength(0)
    expect(ports.score).not.toHaveBeenCalled()
    expect(summaryOf(state)).toMatch(/unavailable/)
  })

  it('a single failure does not end the scan', async () => {
    let calls = 0
    const { ports } = fakePorts({
      search: vi.fn(async () => {
        calls++
        if (calls === 1) throw new Error('blip')
        return [hit(calls)]
      }),
    })
    const { state } = await runToEnd(ports)
    expect(state.stoppedBecause).toBeUndefined()
    expect(state.stats.failedCalls).toBe(1)
    expect(state.stats.matched).toBeGreaterThan(0)
  })

  it('never starts a paid call it cannot afford', async () => {
    const { ports } = fakePorts({
      score: vi.fn(async () => ({
        verdict: { score: 90, verdict: 'exact', reasons: [], redFlags: [] } satisfies Verdict,
        costUsd: SCAN_BUDGET_USD, // one call eats the whole budget
      })),
    })
    const { state } = await runToEnd(ports)
    expect(state.stoppedBecause).toBe('budget')
    expect(ports.score).toHaveBeenCalledTimes(FUNNEL.scoreConcurrency) // one batch, then the gate closes
  })

  it('skips listings this hunt has already paid to look at', async () => {
    const already = hit(11).url // first listing of the first query
    const { ports } = fakePorts({ loadSeen: vi.fn(async () => new Set([already])) })
    await runToEnd(ports)
    const scoredUrls = (ports.score as ReturnType<typeof vi.fn>).mock.calls.map(([, c]) => (c as Candidate).url)
    expect(scoredUrls).toContain(hit(12).url)
    expect(scoredUrls).not.toContain(already)
  })

  it('keeps errored listings unseen so the next scan retries them', async () => {
    const { ports, seen } = fakePorts({
      score: vi.fn(async () => {
        throw new Error('model timeout')
      }),
    })
    const { state } = await runToEnd(ports)
    expect(seen.filter(([, o]) => o !== 'red-flag' && o !== 'over-budget' && o !== 'off-target')).toHaveLength(0)
    expect(state.stoppedBecause).toBe('provider-failures')
  })

  it('reports monotonic progress that ends at 1', async () => {
    const { ports, reports } = fakePorts()
    const { state } = await runToEnd(ports)
    expect(reports.every((p, i) => i === 0 || p >= reports[i - 1])).toBe(true)
    expect(progressOf(state)).toBe(1)
  })

  it('honours cancellation at the next suspension point', async () => {
    const ctl = new AbortController()
    ctl.abort()
    const { ports } = fakePorts({ signal: ctl.signal })
    const state = await runSlice(initialState(hunt), ports)
    expect(state.phase).toBe('done')
    expect(state.stoppedBecause).toBe('canceled')
    expect(ports.search).not.toHaveBeenCalled()
  })
})
