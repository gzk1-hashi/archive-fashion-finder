/**
 * One listing → one Verdict, via the DeepSpace AI proxy and the Vercel AI SDK.
 *
 * `createDeepSpaceAI(env, 'anthropic')` is a raw passthrough to the Anthropic
 * Messages API, billed to the app owner, so the full API is available —
 * structured output and image inputs included — through the standard AI SDK
 * provider instead of a bespoke integration call.
 */

import { generateText, Output, type LanguageModelUsage, type UserContent } from 'ai'
import { createDeepSpaceAI } from 'deepspace/worker'
import { MODELS, MODEL_PRICING_PER_MTOK } from '../config'
import type { Candidate, HuntFilterInput } from '../lib/filter'
import { buildUserPrompt, SYSTEM_PROMPT, VerdictSchema, type Verdict } from '../lib/verdict'
import type { Env } from '../../worker'

export function costOf(usage: Pick<LanguageModelUsage, 'inputTokens' | 'outputTokens'>, model: string = MODELS.scorer): number {
  const price = MODEL_PRICING_PER_MTOK[model]
  if (!price) return 0
  return ((usage.inputTokens ?? 0) * price.input + (usage.outputTokens ?? 0) * price.output) / 1_000_000
}

export function createScorer(env: Env, signal?: AbortSignal) {
  const model = createDeepSpaceAI(env, 'anthropic')(MODELS.scorer)

  async function call(hunt: HuntFilterInput, c: Candidate, withImage: boolean) {
    const content: UserContent = [
      { type: 'text', text: buildUserPrompt(hunt, { ...c, priceText: c.price?.text }) },
    ]
    if (withImage && c.imageUrl) content.push({ type: 'image', image: new URL(c.imageUrl) })
    const result = await generateText({
      model,
      instructions: SYSTEM_PROMPT,
      messages: [{ role: 'user', content }],
      output: Output.object({ schema: VerdictSchema, name: 'verdict' }),
      // Classification, not creative writing: same listing, same answer.
      temperature: 0,
      maxOutputTokens: 500,
      // The engine owns retry policy (and counts failures); one SDK retry
      // absorbs a transient 529 without hiding a real outage.
      maxRetries: 1,
      // A hung request must not eat the slice (or the 15-minute alarm ceiling).
      timeout: 45_000,
      abortSignal: signal,
    })
    return { verdict: result.output as Verdict, costUsd: costOf(result.usage) }
  }

  return async function score(hunt: HuntFilterInput, c: Candidate): Promise<{ verdict: Verdict; costUsd: number }> {
    if (!c.imageUrl) return call(hunt, c, false)
    try {
      return await call(hunt, c, true)
    } catch (err) {
      if (signal?.aborted) throw err
      // Listing photos are hot-linked from the marketplace CDN; when the model
      // provider can't fetch one (expired, hotlink-protected, 403), judge on
      // text alone rather than losing the listing.
      return call(hunt, c, false)
    }
  }
}
