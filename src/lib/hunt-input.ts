/**
 * The "new hunt" form contract. The RecordRoom enforces the hard limits
 * (required, maxLength, writableFields) no matter what the browser sends; this
 * schema exists so the user gets a useful message before the round trip, and
 * so every hunt is stored in one normalized shape.
 */

import { z } from 'zod'
import { HUNT_LIMITS } from '../config'
import { parseSeason } from './season'

const text = (max: number) => z.string().trim().max(max, `Keep it under ${max} characters.`)

export const HuntInput = z.object({
  designer: text(HUNT_LIMITS.designer).min(2, 'Which designer?'),
  piece: text(HUNT_LIMITS.piece).min(2, 'What piece? e.g. "patchwork denim jacket"'),
  season: text(HUNT_LIMITS.season)
    .refine((s) => s === '' || parseSeason(s) !== null, 'Use a season code like SS02, AW03 or 02SS.')
    // Store one canonical spelling so queries and the board agree.
    .transform((s) => {
      const parsed = parseSeason(s)
      return parsed ? `${parsed.half}${String(parsed.year % 100).padStart(2, '0')}` : ''
    }),
  size: text(HUNT_LIMITS.size),
  maxPriceUsd: z
    .string()
    .trim()
    .transform((s) => s.replace(/[$,\s]/g, ''))
    .refine((s) => s === '' || /^\d+$/.test(s), 'Whole dollars, e.g. 400.')
    .transform((s) => (s === '' ? undefined : Number(s)))
    .refine((n) => n === undefined || (n > 0 && n <= HUNT_LIMITS.maxPriceUsd), `Between $1 and $${HUNT_LIMITS.maxPriceUsd.toLocaleString()}.`),
})

export type HuntFormValues = z.input<typeof HuntInput>
export type HuntRecordInput = z.output<typeof HuntInput>

/** Field → first error message, for inline display. */
export function fieldErrors(error: z.ZodError): Partial<Record<keyof HuntFormValues, string>> {
  const out: Partial<Record<keyof HuntFormValues, string>> = {}
  for (const issue of error.issues) {
    const key = issue.path[0] as keyof HuntFormValues
    if (key && !out[key]) out[key] = issue.message
  }
  return out
}
