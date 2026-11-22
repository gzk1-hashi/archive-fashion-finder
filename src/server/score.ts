/**
 * One listing → one Verdict, via the DeepSpace AI proxy and the Vercel AI SDK.
 *
 * `createDeepSpaceAI(env, 'anthropic')` is a raw passthrough to the Anthropic
 * Messages API, billed to the app owner, so the full API is available —
 * structured output and image inputs included — through the standard AI SDK
 * provider instead of a bespoke integration call.
 */

import { generateText, NoObjectGeneratedError, Output, type LanguageModelUsage, type UserContent } from 'ai'
import { createDeepSpaceAI } from 'deepspace/worker'
import { MODELS, MODEL_PRICING_PER_MTOK } from '../config'
import type { Candidate, HuntFilterInput } from '../lib/filter'
import { buildUserPrompt, normalizeVerdict, SYSTEM_PROMPT, VerdictSchema, type Verdict } from '../lib/verdict'
import type { Env } from '../../worker'
import { PaidCallError } from './scan-engine'

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
    try {
      const result = await generateText({
        model,
        instructions: SYSTEM_PROMPT,
        messages: [{ role: 'user', content }],
        output: Output.object({ schema: VerdictSchema, name: 'verdict' }),
        // Haiku 5.5 thinks adaptively, and thinking tokens count against the
        // output cap. A tight cap (the first version used 500) truncates the
        // JSON mid-object — "could not parse the response". Low effort keeps
        // the thinking short; the cap leaves room for it plus the verdict.
        // Same settings the SDK's own Haiku summarizer uses.
        providerOptions: { anthropic: { effort: 'low' } },
        maxOutputTokens: 4000,
        // No `temperature`: this model rejects sampling parameters and the SDK
        // would drop it with a warning on every call. Consistency comes from
        // the strict output schema and the fixed prompt instead.
        //
        // The engine owns retry policy (and counts failures); one SDK retry
        // absorbs a transient 529 without hiding a real outage.
        maxRetries: 1,
        // A hung request must not eat the slice (or the 15-minute alarm ceiling).
        timeout: 45_000,
        abortSignal: signal,
      })
      return { verdict: normalizeVerdict(result.output as Verdict), costUsd: costOf(result.usage) }
    } catch (err) {
      // A reply that didn't parse was still generated — and billed. Carry the
      // cost and the reason (finishReason 'length' = truncated) to the engine.
      if (NoObjectGeneratedError.isInstance(err)) {
        throw new PaidCallError(
          `no verdict (finishReason=${err.finishReason ?? 'unknown'}, outputTokens=${err.usage?.outputTokens ?? '?'})`,
          err.usage ? costOf(err.usage) : 0,
        )
      }
      throw err
    }
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
