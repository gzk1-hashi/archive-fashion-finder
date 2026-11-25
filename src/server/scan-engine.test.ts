import { describe, expect, it, vi } from 'vitest'
import { FUNNEL, PAGE_COST_USD, PROMPT_VERSION, SCAN_BUDGET_USD, SEARCH_COST_USD } from '../config'
import type { Candidate } from '../lib/filter'
import type { Listing, ListingPage } from '../lib/listings'
import type { PlannedQuery } from '../lib/queries'
import type { Verdict } from '../lib/verdict'
import type { HuntData, MatchData, SeenOutcome } from '../types'
import { initialState, PaidCallError, progressOf, runSlice, summaryOf, type BoardItem, type ScanPorts } from './scan-engine'

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
  const soldIds: string[] = []
  const patches: Array<[string, Record<string, unknown>]> = []
  const ports: ScanPorts = {
    // Three fresh listings per query, so a scan has more candidates than one scoring batch.
    search: vi.fn(async (_q: PlannedQuery) => {
      const i = ++searches
      return [hit(i * 10 + 1), hit(i * 10 + 2), hit(i * 10 + 3)]
    }),
    score: vi.fn(async (_h, c: Candidate) => ({
      verdict: { score: 82, verdict: 'likely', reasons: [`saw ${c.url}`], redFlags: [], appearsSold: false } satisfies Verdict,
      costUsd: 0.0004,
    })),
    // Every listing page is live, shows a Purchase button and carries a photo.
    fetchPage: vi.fn(async (url: string): Promise<ListingPage> => ({
      markdown: '# listing\n$300\nPurchase',
      imageUrl: `https://img.example/${url.split('/').pop()}.jpg`,
    })),
    loadSeen: vi.fn(async () => new Set<string>()),
    listBoard: vi.fn(async (): Promise<BoardItem[]> => []),
    updateMatch: vi.fn(async (id: string, patch: Record<string, unknown>) => {
      patches.push([id, patch])
      if (patch.availability === 'sold') soldIds.push(id)
    }),
    writeMatch: vi.fn(async (row) => void matches.push(row)),
    writeSeen: vi.fn(async (url, outcome) => void seen.push([url, outcome])),
    report: vi.fn(async (p) => void reports.push(p)),
    now: () => (clock += 1),
    ...over,
  }
  return { ports, matches, seen, reports, soldIds, patches }
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
    expect(matches[0]).toMatchObject({ marketplace: 'grailed', verdict: 'likely', score: 82, priceText: '$300', promptVersion: PROMPT_VERSION })
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
        verdict: { score: 90, verdict: 'exact', reasons: [], redFlags: [], appearsSold: false } satisfies Verdict,
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
    const fetched = (ports.fetchPage as ReturnType<typeof vi.fn>).mock.calls.map(([u]) => u)
    expect(fetched).not.toContain(already)
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

  it('counts what a failed-but-billed model call cost', async () => {
    const { ports } = fakePorts({
      score: vi.fn(async () => {
        throw new PaidCallError('no verdict (finishReason=length)', 0.01)
      }),
    })
    const { state } = await runToEnd(ports)
    const scoreCalls = (ports.score as ReturnType<typeof vi.fn>).mock.calls.length
    const pageCalls = (ports.fetchPage as ReturnType<typeof vi.fn>).mock.calls.length
    const expected = state.stats.queries * SEARCH_COST_USD.ok + pageCalls * PAGE_COST_USD.ok + scoreCalls * 0.01
    expect(state.spentUsd).toBeCloseTo(expected)
  })

  it('never scores or shows a listing whose page says sold', async () => {
    const { ports, matches, seen } = fakePorts({
      fetchPage: vi.fn(async (url: string) => ({
        markdown: url.endsWith('1') ? 'Sold Price $300' : '$300\nPurchase',
      })),
    })
    const { state } = await runToEnd(ports)
    const soldUrls = seen.filter(([, o]) => o === 'sold').map(([u]) => u)
    expect(soldUrls.length).toBeGreaterThan(0)
    expect(state.stats.sold).toBe(soldUrls.length)
    const scored = (ports.score as ReturnType<typeof vi.fn>).mock.calls.map(([, c]) => (c as Candidate).url)
    for (const u of soldUrls) {
      expect(scored).not.toContain(u)
      expect(matches.map((m) => m.url)).not.toContain(u)
    }
    expect(summaryOf(state)).toMatch(/already sold/)
  })

  it('does not show what it cannot prove is for sale — and leaves it unseen for next time', async () => {
    const { ports, matches, seen } = fakePorts({ fetchPage: vi.fn(async () => ({ markdown: '# a page with no buy button' })) })
    const { state } = await runToEnd(ports)
    expect(matches).toHaveLength(0)
    expect(ports.score).not.toHaveBeenCalled()
    expect(state.stats.unverified).toBeGreaterThan(0)
    expect(seen).toHaveLength(0)
  })

  it('puts the page photo and price on the match', async () => {
    const { ports, matches } = fakePorts()
    await runToEnd(ports)
    expect(matches[0].imageUrl).toMatch(/^https:\/\/img\.example\/\d+\.jpg$/)
    expect(matches[0].priceText).toBe('$300')
  })

  it('rechecks the board first and marks pieces that sold since', async () => {
    const board: BoardItem[] = [
      { recordId: 'm-live', url: 'https://grailed.com/listings/1', marketplace: 'grailed' },
      { recordId: 'm-gone', url: 'https://grailed.com/listings/2', marketplace: 'grailed' },
      { recordId: 'm-404', url: 'https://grailed.com/listings/3', marketplace: 'grailed' },
    ]
    const { ports, soldIds } = fakePorts({
      listBoard: vi.fn(async () => board),
      fetchPage: vi.fn(async (url: string): Promise<ListingPage> => {
        if (url.endsWith('/2')) return { markdown: 'This listing has been sold' }
        if (url.endsWith('/3')) return { markdown: '', statusCode: 404 }
        return { markdown: '$300\nPurchase' }
      }),
    })
    const { state } = await runToEnd(ports)
    expect(soldIds).toEqual(['m-gone', 'm-404'])
    expect(state.stats.sold).toBeGreaterThanOrEqual(2)
  })

  it('backfills a photo and price onto a live board piece that had none', async () => {
    const { ports, patches } = fakePorts({
      listBoard: vi.fn(async () => [{ recordId: 'm-old', url: 'https://jp.mercari.com/item/m5', marketplace: 'mercari' } as BoardItem]),
      fetchPage: vi.fn(async (url: string): Promise<ListingPage> =>
        url.includes('mercari')
          ? { markdown: '購入手続きへ', imageUrl: 'https://static.mercdn.net/m5.jpg', price: { amount: 38000, currency: 'JPY', text: '¥38,000' } }
          : { markdown: '$300\nPurchase' },
      ),
    })
    await runToEnd(ports)
    const [id, patch] = patches.find(([i]) => i === 'm-old') ?? []
    expect(id).toBe('m-old')
    expect(patch).toMatchObject({ imageUrl: 'https://static.mercdn.net/m5.jpg', priceText: '¥38,000' })
    expect(patch?.landedUsd).toBeGreaterThan(238)
  })

  it('treats a model "appears sold" as sold: not boarded, recorded as sold', async () => {
    const { ports, matches, seen } = fakePorts({
      score: vi.fn(async () => ({
        verdict: { score: 95, verdict: 'exact', reasons: [], redFlags: [], appearsSold: true } satisfies Verdict,
        costUsd: 0.0004,
      })),
    })
    const { state } = await runToEnd(ports)
    expect(matches).toHaveLength(0)
    expect(seen.every(([, o]) => o === 'sold')).toBe(true)
    expect(state.stats.sold).toBeGreaterThan(0)
  })

  it('a failing recheck does not stop the search', async () => {
    const { ports, matches } = fakePorts({
      listBoard: vi.fn(async () => [{ recordId: 'm1', url: 'https://grailed.com/listings/9', marketplace: 'grailed' } as BoardItem]),
      fetchPage: vi.fn(async (url: string): Promise<ListingPage> => {
        if (url.endsWith('/9')) throw new Error('blip')
        return { markdown: '$300\nPurchase' }
      }),
    })
    const { state } = await runToEnd(ports)
    expect(ports.search).toHaveBeenCalled()
    expect(matches.length).toBeGreaterThan(0)
    expect(state.stoppedBecause).toBeUndefined()
  })

  it('a full board during a page outage costs one probe, not the search budget', async () => {
    const board = Array.from({ length: 8 }, (_, i): BoardItem => ({
      recordId: `m${i}`,
      url: `https://grailed.com/listings/${90 + i}`,
      marketplace: 'grailed',
    }))
    let boardFetches = 0
    const { ports, matches } = fakePorts({
      listBoard: vi.fn(async () => board),
      fetchPage: vi.fn(async (url: string): Promise<ListingPage> => {
        if (board.some((b) => b.url === url)) {
          boardFetches++
          throw new Error('provider down')
        }
        return { markdown: '$300\nPurchase' }
      }),
    })
    const { state } = await runToEnd(ports)
    expect(boardFetches).toBe(1)
    expect(ports.search).toHaveBeenCalledTimes(state.queries.length)
    expect(matches.length).toBeGreaterThan(0)
    expect(state.stoppedBecause).toBeUndefined()
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
