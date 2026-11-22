/**
 * The free part of the funnel. Everything here is deterministic and costs
 * nothing, and it runs before a single paid call: drop what's already been
 * paid for, drop what the snippet already says is sold, drop what announces
 * itself as fake, drop what blows the budget,
 * then rank the rest so the model's limited calls go to the most promising
 * listings first.
 */

import { FUNNEL } from '../config'
import { soldInText } from './availability'
import type { SeenOutcome } from '../types'
import { designerForms, garmentJa, sizeAliases } from './designers'
import type { Listing } from './listings'
import { landedCost, parsePrice, withinBudget, type LandedCost, type ParsedPrice } from './pricing'
import { mentionsOtherSeason, mentionsSeason, parseSeason } from './season'
import { compact, fold, tokens } from './text'

export interface HuntFilterInput {
  designer: string
  piece: string
  season?: string
  size?: string
  maxPriceUsd?: number
}

export interface Candidate extends Listing {
  price: ParsedPrice | null
  cost: LandedCost | null
  /** Deterministic pre-rank; higher is more promising. Not shown to users. */
  relevance: number
  /** Facts the filter established, passed to the model as context. */
  signals: string[]
}

export interface Rejection {
  listing: Listing
  outcome: Extract<SeenOutcome, 'red-flag' | 'over-budget' | 'off-target' | 'sold'>
  detail: string
}

export interface FilterResult {
  /** Best-first, capped at `limit`. */
  toScore: Candidate[]
  /** Rejected for free — recorded in seen_listings so they're never re-checked. */
  rejected: Rejection[]
  /** Passed the filter but over this scan's model budget; picked up next scan. */
  deferred: number
}

// ─── Red flags ───────────────────────────────────────────────────────────────

/**
 * Sellers are oddly honest in titles. These are the words that mean "not the
 * real thing" in English and in Japanese resale slang.
 *  - 〜風 after a katakana word ("ギャルソン風") means "Garçons-style"; the
 *    negative lookahead keeps 風合い ("texture/hand-feel"), which appears in
 *    half of all genuine listings, from tripping it.
 *  - ノーブランド is literally "no brand".
 */
const RED_FLAGS: Array<[RegExp, string]> = [
  [/\b(replica|reps?|fake|bootleg|counterfeit|unauthentic|not authentic|dupe)\b/i, 'calls itself a replica'],
  [/\b(inspired|homage|in the style of|style of)\b|\w-style\b/i, 'calls itself "inspired by" / "-style"'],
  [/レプリカ|コピー品|偽物|偽造|模造/, 'Japanese listing says replica/copy'],
  [/オマージュ|インスパイア|ノーブランド/, 'Japanese listing says homage / no brand'],
  [/[ァ-ヶー]風(?!合)/, 'Japanese listing says "-style" (〜風)'],
]

export function redFlagIn(text: string): string | null {
  const t = text.normalize('NFKC')
  for (const [re, why] of RED_FLAGS) if (re.test(t)) return why
  return null
}

// ─── Relevance ───────────────────────────────────────────────────────────────

function relevanceOf(listing: Listing, hunt: HuntFilterInput, forms: string[]): { score: number; signals: string[]; designerHit: boolean } {
  const text = `${listing.title} ${listing.snippet}`
  const hay = compact(text)
  const signals: string[] = []
  let score = 0

  const designerHit = forms.some((f) => hay.includes(f.replace(/ /g, '')))
  if (designerHit) score += 3

  const pieceTokens = tokens(hunt.piece)
  const folded = ` ${fold(text)} `
  const pieceHits = pieceTokens.filter((t) => folded.includes(` ${t} `) || folded.includes(` ${t}s `))
  score += pieceHits.length
  const ja = garmentJa(hunt.piece)
  if (ja?.some((term) => text.includes(term))) {
    score += 2
    pieceHits.push(ja[0])
  }
  if (pieceHits.length) signals.push(`mentions ${pieceHits.join(', ')}`)

  const season = parseSeason(hunt.season)
  if (season) {
    if (mentionsSeason(text, season)) {
      score += 2
      signals.push(`states season ${hunt.season}`)
    } else if (mentionsOtherSeason(text, season)) {
      score -= 3
      signals.push('states a different season code')
    }
  }

  const sizes = sizeAliases(hunt.size)
  if (sizes.length) {
    const sizeRe = new RegExp(`(?:size|サイズ|sz)\\s*[:：]?\\s*(${sizes.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})(?![a-z0-9])`, 'i')
    if (sizeRe.test(text.normalize('NFKC'))) {
      score += 1
      signals.push(`size ${hunt.size} (or equivalent) mentioned`)
    }
  }
  return { score, signals, designerHit }
}

// ─── Funnel ──────────────────────────────────────────────────────────────────

export function prefilter(
  listings: Listing[],
  hunt: HuntFilterInput,
  seen: ReadonlySet<string>,
  limit: number = FUNNEL.maxScoredPerScan,
): FilterResult {
  const forms = designerForms(hunt.designer)
  const rejected: Rejection[] = []
  const passed: Candidate[] = []
  const handled = new Set<string>()

  for (const listing of listings) {
    if (seen.has(listing.url) || handled.has(listing.url)) continue
    handled.add(listing.url)
    const text = `${listing.title} ${listing.snippet}`

    if (soldInText(text)) {
      rejected.push({ listing, outcome: 'sold', detail: 'search snippet says sold / ended' })
      continue
    }

    const flag = redFlagIn(text)
    if (flag) {
      rejected.push({ listing, outcome: 'red-flag', detail: flag })
      continue
    }

    const price = parsePrice(text)
    const cost = price ? landedCost(price, listing.marketplace) : null
    if (!withinBudget(cost?.landedUsd, hunt.maxPriceUsd)) {
      rejected.push({ listing, outcome: 'over-budget', detail: `landed ~$${cost?.landedUsd} > max $${hunt.maxPriceUsd}` })
      continue
    }

    const { score, signals, designerHit } = relevanceOf(listing, hunt, forms)
    if (!designerHit) {
      rejected.push({ listing, outcome: 'off-target', detail: 'designer not named in title or snippet' })
      continue
    }
    if (cost) signals.push(`landed cost ~$${cost.landedUsd} (${cost.parts.join(' + ')})`)
    else signals.push('price not visible in snippet')

    passed.push({ ...listing, price, cost, relevance: score, signals })
  }

  // Stable sort: equal relevance keeps search order, which already encodes the
  // engine's own ranking and our query tiering.
  passed.sort((a, b) => b.relevance - a.relevance)
  return {
    toScore: passed.slice(0, Math.max(0, limit)),
    rejected,
    deferred: Math.max(0, passed.length - limit),
  }
}
