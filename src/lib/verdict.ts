/**
 * The model's half of the funnel, minus the network: the output contract, the
 * prompt, and the rule that turns a model answer into a board decision. Kept
 * pure so the tests can pin the prompt and the thresholds without a model.
 */

import { z } from 'zod'
import { FUNNEL, MARKETPLACES } from '../config'
import type { MatchVerdict } from '../types'
import type { Candidate, HuntFilterInput } from './filter'

/**
 * What the model must return. Sent to the provider as the structured-output
 * schema (constrained decoding: the reply is valid JSON of this shape) and
 * parsed against it again by the AI SDK.
 *
 * Deliberately no length/range limits in the schema itself: structured-output
 * JSON Schema support for maxLength / maxItems / minimum varies by provider,
 * and a limit the provider ignores becomes a local parse failure — a paid call
 * thrown away over a 141-character reason. The limits are stated to the model
 * in the descriptions and enforced after parsing by `normalizeVerdict`.
 */
export const VerdictSchema = z.object({
  score: z.number().describe('Integer 0–100: confidence that this listing is the exact piece being hunted.'),
  verdict: z
    .enum(['exact', 'likely', 'possible', 'no'])
    .describe('exact = this specific piece/season; likely = same piece, season unconfirmed; possible = same designer and garment type; no = not it.'),
  reasons: z.array(z.string()).describe('Up to 4 short pieces of evidence for the score, each under 140 characters.'),
  redFlags: z
    .array(z.string())
    .describe('Up to 4 authenticity or condition concerns visible in the listing text or photo, each under 140 characters. Empty if none.'),
  appearsSold: z
    .boolean()
    .describe('true if the title, snippet or photo indicates the item has already sold or the listing has ended (e.g. "Sold", 売り切れ, a SOLD stamp on the photo).'),
})
export type Verdict = z.infer<typeof VerdictSchema>

export const VERDICT_LIMITS = { items: 4, chars: 140 } as const

const clip = (t: string) => {
  const s = t.trim()
  return s.length > VERDICT_LIMITS.chars ? `${s.slice(0, VERDICT_LIMITS.chars - 1)}…` : s
}

/**
 * Enforce what the schema only asks for: an integer score in 0–100, at most 4
 * non-empty strings per list, each at most 140 characters. These strings land
 * in the UI and in the database, so they're bounded here, never trusted.
 */
export function normalizeVerdict(v: Verdict): Verdict {
  const list = (xs: string[]) => xs.map(clip).filter(Boolean).slice(0, VERDICT_LIMITS.items)
  const score = Number.isFinite(v.score) ? Math.min(100, Math.max(0, Math.round(v.score))) : 0
  return { score, verdict: v.verdict, reasons: list(v.reasons), redFlags: list(v.redFlags), appearsSold: v.appearsSold === true }
}

export const SYSTEM_PROMPT = `You are an archive-fashion authenticator triaging resale listings for a collector.

You will be shown what the collector is hunting and one listing (title, snippet, marketplace, sometimes a photo). Decide how likely it is that the listing is the exact piece being hunted.

Ground rules:
- Judge only from what is in the listing. Never assume details that aren't there.
- Japanese listings are normal and often the best source. Katakana brand names (e.g. ジュンヤワタナベ) are the same designer as the romanized name. Season codes appear as SS02 / 02SS / 2002SS / 2002春夏 and are equivalent. Comme des Garçons–family tags carry a production code like AD2002.
- A listing that names the right designer and garment but no season is "likely" at best, not "exact".
- A different season code, a diffusion or licensed line the collector didn't ask for, or a different garment type pushes the score down hard.
- Treat "replica", "inspired", "-style", 〜風, レプリカ, or prices far below market for the piece as red flags.
- The listing page was already checked and looked for sale. If anything you see still says it sold or ended (a "Sold" label, 売り切れ, a SOLD stamp on the photo), set appearsSold to true — the collector only wants pieces they can buy.
- Keep reasons concrete ("title says 02SS", "katakana brand matches"), not generic.`

export interface PromptListing extends Pick<Candidate, 'title' | 'snippet' | 'marketplace' | 'signals'> {
  priceText?: string
}

/** The user-turn text. Field labels are stable so prompt changes are reviewable diffs. */
export function buildUserPrompt(hunt: HuntFilterInput, listing: PromptListing): string {
  const want = [
    `Designer: ${hunt.designer}`,
    `Piece: ${hunt.piece}`,
    hunt.season ? `Season: ${hunt.season}` : null,
    hunt.size ? `Size: ${hunt.size}` : null,
    hunt.maxPriceUsd ? `Budget: up to $${hunt.maxPriceUsd} landed` : null,
  ].filter(Boolean)
  const got = [
    `Marketplace: ${MARKETPLACES[listing.marketplace].label}`,
    `Title: ${listing.title || '(none)'}`,
    `Snippet: ${listing.snippet || '(none)'}`,
    listing.priceText ? `Price as listed: ${listing.priceText}` : null,
    listing.signals.length ? `Pre-check notes: ${listing.signals.join('; ')}` : null,
  ].filter(Boolean)
  return `HUNTING\n${want.join('\n')}\n\nLISTING\n${got.join('\n')}`
}

/**
 * Model verdict → board verdict, or null to keep it off the board. The score
 * threshold is ours, not the model's: a "likely" at 45 stays off, an "exact"
 * at 58 stays off. A model that says "no" never gets on the board however it
 * scored, because the two fields disagreeing means one of them is wrong. And
 * anything the model reads as sold stays off, whatever the page check said —
 * for availability, any "sold" evidence wins.
 */
export function toBoardVerdict(v: Verdict, threshold: number = FUNNEL.matchThreshold): MatchVerdict | null {
  if (v.appearsSold || v.verdict === 'no' || v.score < threshold) return null
  return v.verdict
}
