/**
 * The scan, as a resumable state machine with its side effects passed in.
 *
 *   search  →  filter  →  score  →  done
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

import { FUNNEL, PROMPT_VERSION, SCAN_BUDGET_USD, SEARCH_COST_USD } from '../config'
import { prefilter, type Candidate, type HuntFilterInput } from '../lib/filter'
import type { Listing } from '../lib/listings'
import { buildQueries, type PlannedQuery } from '../lib/queries'
import { toBoardVerdict, type Verdict } from '../lib/verdict'
import type { HuntData, MatchData, SeenOutcome } from '../types'

// ─── Ports ───────────────────────────────────────────────────────────────────

export interface ScanPorts {
  search(q: PlannedQuery): Promise<Listing[]>
  score(hunt: HuntFilterInput, c: Candidate): Promise<{ verdict: Verdict; costUsd: number }>
  loadSeen(): Promise<Set<string>>
  /** Must treat a uniqueOn conflict as success: the row already exists. */
  writeMatch(row: Omit<MatchData, 'huntId'>): Promise<void>
  writeSeen(url: string, outcome: SeenOutcome): Promise<void>
  /** Progress + stage for the board. Fire-and-forget semantics are fine. */
  report(progress: number, stage: string): Promise<void>
  now(): number
  signal?: AbortSignal
}

// ─── State ───────────────────────────────────────────────────────────────────

export interface ScanStats {
  queries: number
  found: number
  rejected: number
  deferred: number
  scored: number
  matched: number
  failedCalls: number
}

export interface ScanState {
  v: 1
  phase: 'search' | 'score' | 'done'
  /** Frozen at start: editing the hunt mid-scan can't change what this scan buys. */
  hunt: HuntFilterInput
  queries: PlannedQuery[]
  nextQuery: number
  pool: Listing[]
  candidates: Candidate[]
  nextCandidate: number
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
    v: 1,
    phase: 'search',
    hunt: frozen,
    queries: buildQueries(frozen),
    nextQuery: 0,
    pool: [],
    candidates: [],
    nextCandidate: 0,
    spentUsd: 0,
    consecutiveFailures: 0,
    stats: { queries: 0, found: 0, rejected: 0, deferred: 0, scored: 0, matched: 0, failedCalls: 0 },
  }
}

// ─── Progress ────────────────────────────────────────────────────────────────

/** Search is ~45% of the bar, scoring the rest; never shows 0 or 100 mid-scan. */
export function progressOf(s: ScanState): number {
  if (s.phase === 'done') return 1
  if (s.phase === 'search') return 0.03 + 0.42 * (s.nextQuery / Math.max(1, s.queries.length))
  return 0.45 + 0.54 * (s.nextCandidate / Math.max(1, s.candidates.length))
}

export function summaryOf(s: ScanState): string {
  const { found, scored, matched } = s.stats
  const base = `${found} listing${found === 1 ? '' : 's'} found · ${scored} checked · ${matched} match${matched === 1 ? '' : 'es'}`
  if (s.stoppedBecause === 'budget') return `${base} (stopped at the scan budget)`
  if (s.stoppedBecause === 'provider-failures') return `${base} (search provider unavailable — try again later)`
  if (s.stoppedBecause === 'canceled') return `${base} (canceled)`
  return base
}

// ─── Engine ──────────────────────────────────────────────────────────────────

/** Rough per-call model cost used for the pre-call budget check (actual cost is added after). */
const SCORE_COST_ESTIMATE_USD = 0.001

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e))

async function searchPhase(s: ScanState, ports: ScanPorts, deadline: number): Promise<void> {
  while (s.nextQuery < s.queries.length) {
    if (ports.signal?.aborted) return void (s.stoppedBecause = 'canceled')
    if (ports.now() >= deadline) return
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
  // free rejections, and move on to scoring whatever survived.
  s.stats.found = s.pool.length
  const seen = await ports.loadSeen()
  const { toScore, rejected, deferred } = prefilter(s.pool, s.hunt, seen)
  for (const r of rejected) await ports.writeSeen(r.listing.url, r.outcome)
  s.stats.rejected = rejected.length
  s.stats.deferred = deferred
  s.candidates = toScore
  s.pool = [] // no longer needed; keeps the checkpoint small
  s.phase = s.stoppedBecause === 'provider-failures' || s.stoppedBecause === 'canceled' ? 'done' : 'score'
  await ports.report(progressOf(s), toScore.length ? `Checking ${toScore.length} listings` : 'Wrapping up')
}

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
    await ports.writeSeen(c.url, board ? 'matched' : verdict.redFlags.length ? 'red-flag' : 'low-score')
    return 'ok'
  } catch (e) {
    // Not marked seen: a listing that errored gets another chance next scan.
    s.stats.failedCalls++
    console.warn(`[scan] scoring failed: ${errorText(e)}`)
    return 'failed'
  }
}

async function scorePhase(s: ScanState, ports: ScanPorts, deadline: number): Promise<void> {
  while (s.nextCandidate < s.candidates.length) {
    if (ports.signal?.aborted) return void (s.stoppedBecause = 'canceled')
    if (ports.now() >= deadline) return
    const room = Math.floor((SCAN_BUDGET_USD - s.spentUsd) / SCORE_COST_ESTIMATE_USD)
    if (room <= 0) {
      s.stoppedBecause = 'budget'
      break
    }
    const batch = s.candidates.slice(s.nextCandidate, s.nextCandidate + Math.min(FUNNEL.scoreConcurrency, room))
    const results = await Promise.all(batch.map((c) => scoreOne(s, ports, c)))
    s.nextCandidate += batch.length
    // A whole batch failing is a provider problem, not four bad listings.
    if (results.every((r) => r === 'failed')) {
      s.consecutiveFailures++
      if (s.consecutiveFailures >= FUNNEL.maxConsecutiveFailures) {
        s.stoppedBecause = 'provider-failures'
        break
      }
    } else {
      s.consecutiveFailures = 0
    }
    await ports.report(progressOf(s), `Checked ${s.nextCandidate} of ${s.candidates.length}`)
  }
  s.phase = 'done'
}

/**
 * Advance the scan by at most one slice. Returns the new state; `phase ===
 * 'done'` means the scan is finished and the caller should finalize the hunt.
 * The input state is not mutated.
 */
export async function runSlice(input: ScanState, ports: ScanPorts, sliceMs: number = FUNNEL.sliceMs): Promise<ScanState> {
  const s: ScanState = structuredClone(input)
  const deadline = ports.now() + sliceMs
  if (s.phase === 'search') await searchPhase(s, ports, deadline)
  if (s.phase === 'score' && s.stoppedBecause !== 'canceled') await scorePhase(s, ports, deadline)
  if (s.stoppedBecause === 'canceled') s.phase = 'done'
  return s
}
