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
 * What the model must return. Enforced twice: the AI SDK sends it as the
 * structured-output schema, and parses the reply against it, so a malformed
 * answer is an error we can count, never a half-filled row on the board.
 * Lengths are capped here rather than trusted — the strings land in the UI.
 */
export const VerdictSchema = z.object({
  score: z.number().int().min(0).max(100).describe('0–100 confidence that this listing is the exact piece being hunted.'),
  verdict: z
    .enum(['exact', 'likely', 'possible', 'no'])
    .describe('exact = this specific piece/season; likely = same piece, season unconfirmed; possible = same designer and garment type; no = not it.'),
  reasons: z.array(z.string().max(140)).max(4).describe('Short evidence for the score, each under 140 characters.'),
  redFlags: z
    .array(z.string().max(140))
    .max(4)
    .describe('Authenticity or condition concerns visible in the listing text or photo. Empty if none.'),
})
export type Verdict = z.infer<typeof VerdictSchema>

export const SYSTEM_PROMPT = `You are an archive-fashion authenticator triaging resale listings for a collector.

You will be shown what the collector is hunting and one listing (title, snippet, marketplace, sometimes a photo). Decide how likely it is that the listing is the exact piece being hunted.

Ground rules:
- Judge only from what is in the listing. Never assume details that aren't there.
- Japanese listings are normal and often the best source. Katakana brand names (e.g. ジュンヤワタナベ) are the same designer as the romanized name. Season codes appear as SS02 / 02SS / 2002SS / 2002春夏 and are equivalent. Comme des Garçons–family tags carry a production code like AD2002.
- A listing that names the right designer and garment but no season is "likely" at best, not "exact".
- A different season code, a diffusion or licensed line the collector didn't ask for, or a different garment type pushes the score down hard.
- Treat "replica", "inspired", "-style", 〜風, レプリカ, or prices far below market for the piece as red flags.
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
 * at 58 stays off. And a model that says "no" never gets on the board however
 * it scored, because the two fields disagreeing means one of them is wrong.
 */
export function toBoardVerdict(v: Verdict, threshold: number = FUNNEL.matchThreshold): MatchVerdict | null {
  if (v.verdict === 'no' || v.score < threshold) return null
  return v.verdict
}
