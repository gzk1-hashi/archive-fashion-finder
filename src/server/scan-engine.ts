/**
 * The scan, as a resumable state machine with its side effects passed in.
 *
 *   recheck  →  search  →  filter  →  verify  →  score  →  done
 *
 *   recheck  pieces already on the board: still for sale? (sold → marked sold;
 *            live → missing photo/price backfilled)
 *   search   ~12 marketplace queries
 *   filter   free: seen, snippet says sold, replica words, budget, designer
 *   verify   open each surviving listing's page: for sale? real price? photo?
 *   score    the model judges only listings proven to be for sale
 *
 * One call to `runSlice` does as much work as fits in a wall-clock slice, then
 * returns the state to checkpoint. The job adapter (scan-job.ts) feeds that
 * state to `ctx.continue`, the JobRoom persists it in its SQLite row, and the
 * next alarm resumes exactly where this one stopped — so a scan survives
 * isolate eviction and never runs into the 15-minute alarm ceiling.
 *
 * Nothing in this file imports the platform or the AI SDK. Every side effect is
 * a port, which is what lets scan-engine.test.ts drive a whole scan — budget
 * exhaustion, a provider outage, a resume between slices — with plain fakes.
 */

import { FUNNEL, PAGE_COST_USD, PROMPT_VERSION, SCAN_BUDGET_USD, SEARCH_COST_USD, type MarketplaceId } from '../config'
import { prefilter, type Candidate, type HuntFilterInput } from '../lib/filter'
import { landedCost } from '../lib/pricing'
import type { Listing, ListingPage } from '../lib/listings'
import { buildQueries, type PlannedQuery } from '../lib/queries'
import { toBoardVerdict, type Verdict } from '../lib/verdict'
import { pageAvailability, verifyCandidate } from '../lib/verify'
import type { HuntData, MatchData, SeenOutcome } from '../types'

// ─── Ports ───────────────────────────────────────────────────────────────────

/** A piece already on the board, as far as the recheck needs to know. */
export interface BoardItem {
  recordId: string
  url: string
  marketplace: MarketplaceId
  /** Present so the recheck can backfill a photo/price a match was written without. */
  imageUrl?: string
  priceText?: string
}

export interface ScanPorts {
  search(q: PlannedQuery): Promise<Listing[]>
  /** Fetch one listing page (paid). */
  fetchPage(url: string): Promise<ListingPage>
  score(hunt: HuntFilterInput, c: Candidate): Promise<{ verdict: Verdict; costUsd: number }>
  loadSeen(): Promise<Set<string>>
  /** This hunt's matches that are still shown as available and not dismissed. */
  listBoard(): Promise<BoardItem[]>
  /** Server-owned fields only: availability, imageUrl, price. */
  updateMatch(recordId: string, patch: Partial<Pick<MatchData, 'availability' | 'imageUrl' | 'priceText' | 'priceUsd' | 'landedUsd'>>): Promise<void>
  /** Must treat a uniqueOn conflict as success: the row already exists. */
  writeMatch(row: Omit<MatchData, 'huntId'>): Promise<void>
  writeSeen(url: string, outcome: SeenOutcome): Promise<void>
  /** Progress + stage for the board. Fire-and-forget semantics are fine. */
  report(progress: number, stage: string): Promise<void>
  now(): number
  signal?: AbortSignal
}

/**
 * A port may throw this when a call failed but was still billed (a model reply
 * that didn't parse still consumed tokens). The engine adds `costUsd` to the
 * scan's spend so the budget reflects what was actually paid.
 */
export class PaidCallError extends Error {
  constructor(
    message: string,
    readonly costUsd: number,
  ) {
    super(message)
    this.name = 'PaidCallError'
  }
}

// ─── State ───────────────────────────────────────────────────────────────────

export interface ScanStats {
  queries: number
  found: number
  rejected: number
  deferred: number
  /** Listings dropped because they're sold — by snippet, by page, or on the board. */
  sold: number
  /** Pages that proved neither sold nor for sale; not shown, retried next scan. */
  unverified: number
  scored: number
  matched: number
  failedCalls: number
}

export type Phase = 'recheck' | 'search' | 'verify' | 'score' | 'done'

export interface ScanState {
  v: 2
  phase: Phase
  /** Frozen at start: editing the hunt mid-scan can't change what this scan buys. */
  hunt: HuntFilterInput
  queries: PlannedQuery[]
  nextQuery: number
  pool: Listing[]
  /** Board items to recheck; `null` until loaded on the first recheck slice. */
  board: BoardItem[] | null
  nextBoard: number
  /** Survivors of the free filter, waiting for their page check. */
  candidates: Candidate[]
  nextVerify: number
  /** Proven for sale, enriched with page photo and price, waiting for the model. */
  verified: Candidate[]
  nextScore: number
  spentUsd: number
  consecutiveFailures: number
  stats: ScanStats
  /** Set when the scan stopped early; shown in the summary. */
  stoppedBecause?: 'budget' | 'provider-failures' | 'canceled'
}

export function initialState(hunt: HuntData): ScanState {
  const frozen: HuntFilterInput = {
    designer: hunt.designer,
    piece: hunt.piece,
    season: hunt.season || undefined,
    size: hunt.size || undefined,
    maxPriceUsd: hunt.maxPriceUsd || undefined,
  }
  return {
    v: 2,
    phase: 'recheck',
    hunt: frozen,
    queries: buildQueries(frozen),
    nextQuery: 0,
    pool: [],
    board: null,
    nextBoard: 0,
    candidates: [],
    nextVerify: 0,
    verified: [],
    nextScore: 0,
    spentUsd: 0,
    consecutiveFailures: 0,
    stats: { queries: 0, found: 0, rejected: 0, deferred: 0, sold: 0, unverified: 0, scored: 0, matched: 0, failedCalls: 0 },
  }
}

// ─── Progress ────────────────────────────────────────────────────────────────

const frac = (done: number, total: number) => (total > 0 ? done / total : 1)

/** recheck 2–8%, search 8–40%, verify 40–65%, score 65–99%; never 0 or 100 mid-scan. */
export function progressOf(s: ScanState): number {
  switch (s.phase) {
    case 'recheck':
      return 0.02 + 0.06 * frac(s.nextBoard, s.board?.length ?? 0) * (s.board ? 1 : 0)
    case 'search':
      return 0.08 + 0.32 * frac(s.nextQuery, s.queries.length)
    case 'verify':
      return 0.4 + 0.25 * frac(s.nextVerify, s.candidates.length)
    case 'score':
      return 0.65 + 0.34 * frac(s.nextScore, s.verified.length)
    case 'done':
      return 1
  }
}

export function summaryOf(s: ScanState): string {
  const { found, sold, scored, matched } = s.stats
  const parts = [
    `${found} listing${found === 1 ? '' : 's'} found`,
    ...(sold ? [`${sold} already sold`] : []),
    `${scored} checked`,
    `${matched} match${matched === 1 ? '' : 'es'}`,
  ]
  const base = parts.join(' · ')
  if (s.stoppedBecause === 'budget') return `${base} (stopped at the scan budget)`
  if (s.stoppedBecause === 'provider-failures') return `${base} (a provider was unavailable — try again later)`
  if (s.stoppedBecause === 'canceled') return `${base} (canceled)`
  return base
}

// ─── Engine ──────────────────────────────────────────────────────────────────

/** Rough per-call model cost used for the pre-call budget check (actual cost is added after). */
const SCORE_COST_ESTIMATE_USD = 0.001

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** How many more calls at `unitUsd` the budget allows. */
const roomFor = (s: ScanState, unitUsd: number) => Math.floor((SCAN_BUDGET_USD - s.spentUsd) / unitUsd)

/**
 * Batch bookkeeping shared by every paid phase: a whole batch failing is a
 * provider problem, not N bad listings. Returns true when the scan must stop.
 */
function recordBatch(s: ScanState, outcomes: Array<'ok' | 'failed'>): boolean {
  if (outcomes.length > 0 && outcomes.every((o) => o === 'failed')) {
    s.consecutiveFailures++
    if (s.consecutiveFailures >= FUNNEL.maxConsecutiveFailures) {
      s.stoppedBecause = 'provider-failures'
      return true
    }
  } else {
    s.consecutiveFailures = 0
  }
  return false
}

/** One paid page fetch with the failure accounting every page phase needs. */
async function fetchPaid(s: ScanState, ports: ScanPorts, url: string): Promise<ListingPage | null> {
  try {
    const page = await ports.fetchPage(url)
    // The integration reports what it actually billed; the estimate is only a fallback.
    s.spentUsd += page.costUsd ?? PAGE_COST_USD.ok
    return page
  } catch (e) {
    s.spentUsd += e instanceof PaidCallError ? e.costUsd : PAGE_COST_USD.failed
    s.stats.failedCalls++
    console.warn(`[scan] page fetch failed: ${errorText(e)}`)
    return null
  }
}

/** Gate shared by every loop: canceled → stop; slice spent → checkpoint. */
function mustPause(s: ScanState, ports: ScanPorts, deadline: number): boolean {
  if (ports.signal?.aborted) {
    s.stoppedBecause = 'canceled'
    return true
  }
  return ports.now() >= deadline
}

// ── recheck ──

async function recheckPhase(s: ScanState, ports: ScanPorts, deadline: number): Promise<void> {
  if (s.board === null) s.board = (await ports.listBoard()).slice(0, FUNNEL.maxRechecksPerScan)
  while (s.nextBoard < s.board.length) {
    if (mustPause(s, ports, deadline)) return
    const room = roomFor(s, PAGE_COST_USD.ok)
    if (room <= 0) break // rechecking is a courtesy; never spend the search budget on it
    const batch = s.board.slice(s.nextBoard, s.nextBoard + Math.min(FUNNEL.pageConcurrency, room))
    const outcomes = await Promise.all(
      batch.map(async (item): Promise<'ok' | 'failed'> => {
        const page = await fetchPaid(s, ports, item.url)
        if (!page) return 'failed'
        if (pageAvailability(page, item.marketplace) === 'sold') {
          await ports.updateMatch(item.recordId, { availability: 'sold' })
          s.stats.sold++
          return 'ok'
        }
        // Still live: fill in what the match was written without (matches
        // from before page checks existed had no photo or price).
        const patch: Parameters<ScanPorts['updateMatch']>[1] = {}
        if (!item.imageUrl && page.imageUrl) patch.imageUrl = page.imageUrl
        if (!item.priceText && page.price) {
          const cost = landedCost(page.price, item.marketplace)
          Object.assign(patch, { priceText: page.price.text, priceUsd: cost.priceUsd, landedUsd: cost.landedUsd })
        }
        if (Object.keys(patch).length) await ports.updateMatch(item.recordId, patch)
        return 'ok'
      }),
    )
    s.nextBoard += batch.length
    await ports.report(progressOf(s), 'Re-checking pieces on your board')
    // Rechecking is a courtesy pass: if a whole batch fails, the provider is
    // struggling — stop rechecking (no further paid failures) and let the
    // search run on its own failure rules.
    if (outcomes.every((o) => o === 'failed')) break
  }
  s.board = []
  s.phase = 'search'
}

// ── search + free filter ──

async function searchPhase(s: ScanState, ports: ScanPorts, deadline: number): Promise<void> {
  while (s.nextQuery < s.queries.length) {
    if (mustPause(s, ports, deadline)) return
    if (s.spentUsd + SEARCH_COST_USD.ok > SCAN_BUDGET_USD) {
      s.stoppedBecause = 'budget'
      break
    }

    const q = s.queries[s.nextQuery]
    try {
      const listings = await ports.search(q)
      s.spentUsd += SEARCH_COST_USD.ok
      s.consecutiveFailures = 0
      const known = new Set(s.pool.map((l) => l.url))
      for (const l of listings) if (!known.has(l.url)) s.pool.push(l)
    } catch (e) {
      // A failed search is billed (flat, and expensively). Count it, and stop
      // paying for more of them the moment it looks like an outage.
      s.spentUsd += SEARCH_COST_USD.failed
      s.stats.failedCalls++
      s.consecutiveFailures++
      console.warn(`[scan] search failed (${q.marketplace}): ${errorText(e)}`)
      if (s.consecutiveFailures >= FUNNEL.maxConsecutiveFailures) {
        s.stoppedBecause = 'provider-failures'
        break
      }
    }
    s.nextQuery++
    s.stats.queries = s.nextQuery
    await ports.report(progressOf(s), `Searching ${q.marketplace === 'grailed' || q.marketplace === 'ebay' ? 'US' : 'Japanese'} marketplaces`)
  }

  // Search finished (or was cut short) → run the free filter once, record the
  // free rejections, and move on to the page checks.
  s.stats.found = s.pool.length
  const seen = await ports.loadSeen()
  const { toScore, rejected, deferred } = prefilter(s.pool, s.hunt, seen)
  for (const r of rejected) await ports.writeSeen(r.listing.url, r.outcome)
  s.stats.rejected = rejected.length
  s.stats.sold += rejected.filter((r) => r.outcome === 'sold').length
  s.stats.deferred = deferred
  s.candidates = toScore
  s.pool = [] // no longer needed; keeps the checkpoint small
  s.phase = s.stoppedBecause === 'provider-failures' || s.stoppedBecause === 'canceled' ? 'done' : 'verify'
  await ports.report(progressOf(s), toScore.length ? `Opening ${toScore.length} listings` : 'Wrapping up')
}

// ── verify ──

/** First few hundred characters of a page, on one line — enough to see why it didn't read. */
const excerpt = (markdown: string) => markdown.slice(0, 300).replace(/\s+/g, ' ').trim() || '(empty page)'

async function verifyOne(s: ScanState, ports: ScanPorts, c: Candidate): Promise<'ok' | 'failed'> {
  const page = await fetchPaid(s, ports, c.url)
  if (!page) return 'failed' // not marked seen: retried next scan
  const result = verifyCandidate(c, page, s.hunt)
  switch (result.kind) {
    case 'available':
      s.verified.push(result.candidate)
      break
    case 'sold':
      s.stats.sold++
      await ports.writeSeen(c.url, 'sold')
      break
    case 'over-budget':
      await ports.writeSeen(c.url, 'over-budget')
      break
    case 'unknown':
      // Couldn't prove it's for sale → not shown. Not marked seen either: it
      // may read clearly next time (or a marker list may learn its wording).
      s.stats.unverified++
      console.warn(`[scan] availability unknown, not shown: ${c.url}\n        page starts: ${excerpt(page.markdown)}`)
      break
  }
  return 'ok'
}

async function verifyPhase(s: ScanState, ports: ScanPorts, deadline: number): Promise<void> {
  while (s.nextVerify < s.candidates.length) {
    if (mustPause(s, ports, deadline)) return
    const room = roomFor(s, PAGE_COST_USD.ok)
    if (room <= 0) {
      s.stoppedBecause = 'budget'
      break
    }
    const batch = s.candidates.slice(s.nextVerify, s.nextVerify + Math.min(FUNNEL.pageConcurrency, room))
    const outcomes = await Promise.all(batch.map((c) => verifyOne(s, ports, c)))
    s.nextVerify += batch.length
    await ports.report(progressOf(s), `Opened ${s.nextVerify} of ${s.candidates.length} listings`)
    if (recordBatch(s, outcomes)) break
  }
  s.candidates = [] // verified copies carry everything the score phase needs
  s.phase = s.stoppedBecause === 'provider-failures' || s.stoppedBecause === 'canceled' ? 'done' : 'score'
}

// ── score ──

async function scoreOne(s: ScanState, ports: ScanPorts, c: Candidate): Promise<'ok' | 'failed'> {
  try {
    const { verdict, costUsd } = await ports.score(s.hunt, c)
    s.spentUsd += costUsd
    s.stats.scored++
    const board = toBoardVerdict(verdict)
    if (board) {
      await ports.writeMatch({
        url: c.url,
        title: c.title,
        marketplace: c.marketplace,
        priceText: c.price?.text,
        priceUsd: c.cost?.priceUsd,
        landedUsd: c.cost?.landedUsd,
        imageUrl: c.imageUrl,
        score: verdict.score,
        verdict: board,
        reasons: verdict.reasons,
        redFlags: verdict.redFlags,
        promptVersion: PROMPT_VERSION,
      })
      s.stats.matched++
    }
    if (verdict.appearsSold) s.stats.sold++
    await ports.writeSeen(c.url, board ? 'matched' : verdict.appearsSold ? 'sold' : verdict.redFlags.length ? 'red-flag' : 'low-score')
    return 'ok'
  } catch (e) {
    // Not marked seen: a listing that errored gets another chance next scan.
    if (e instanceof PaidCallError) s.spentUsd += e.costUsd
    s.stats.failedCalls++
    console.warn(`[scan] scoring failed: ${errorText(e)}`)
    return 'failed'
  }
}

async function scorePhase(s: ScanState, ports: ScanPorts, deadline: number): Promise<void> {
  while (s.nextScore < s.verified.length) {
    if (mustPause(s, ports, deadline)) return
    const room = roomFor(s, SCORE_COST_ESTIMATE_USD)
    if (room <= 0) {
      s.stoppedBecause = 'budget'
      break
    }
    const batch = s.verified.slice(s.nextScore, s.nextScore + Math.min(FUNNEL.scoreConcurrency, room))
    const outcomes = await Promise.all(batch.map((c) => scoreOne(s, ports, c)))
    s.nextScore += batch.length
    await ports.report(progressOf(s), `Checked ${s.nextScore} of ${s.verified.length}`)
    if (recordBatch(s, outcomes)) break
  }
  s.phase = 'done'
}

// ─── Driver ──────────────────────────────────────────────────────────────────

/**
 * Advance the scan by at most one slice. Returns the new state; `phase ===
 * 'done'` means the scan is finished and the caller should finalize the hunt.
 * The input state is not mutated.
 */
export async function runSlice(input: ScanState, ports: ScanPorts, sliceMs: number = FUNNEL.sliceMs): Promise<ScanState> {
  const s: ScanState = structuredClone(input)
  const deadline = ports.now() + sliceMs
  const phases: Array<[Phase, (s: ScanState, p: ScanPorts, d: number) => Promise<void>]> = [
    ['recheck', recheckPhase],
    ['search', searchPhase],
    ['verify', verifyPhase],
    ['score', scorePhase],
  ]
  for (const [phase, run] of phases) {
    if (s.stoppedBecause === 'canceled') break
    if (s.phase === phase) await run(s, ports, deadline)
  }
  if (s.stoppedBecause === 'canceled') s.phase = 'done'
  return s
}
