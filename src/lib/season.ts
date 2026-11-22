/**
 * Season codes. The same collection is written a dozen ways across resale
 * sites: Grailed says "SS02" or "S/S 2002", Japanese sellers say "02SS",
 * "2002SS" or "2002春夏", a collector says "Spring/Summer 2002". The parser
 * turns any of them into one canonical { half, year }, and the variant builders
 * turn that back into the spellings each market uses.
 */

import { compact, fold } from './text'

export type SeasonHalf = 'SS' | 'AW'
export interface Season {
  half: SeasonHalf
  /** Four-digit year the collection is named for (AW03 → 2003). */
  year: number
}

const SS_WORDS = ['ss', 's s', 'spring', 'spring summer', 'summer', 'pe', '春夏']
const AW_WORDS = ['aw', 'a w', 'fw', 'f w', 'fall', 'autumn', 'fall winter', 'autumn winter', 'winter', 'ah', '秋冬']

/** Two-digit years: the archive market starts in the 80s, so 70–99 are 19xx. */
function expandYear(raw: string): number {
  const n = Number(raw)
  if (raw.length === 4) return n
  return n >= 70 ? 1900 + n : 2000 + n
}

/**
 * Parse free text into a Season, or null. Accepts the half before or after the
 * year, slashes, spaces, full-width digits and AW ranges ("AW03-04", the first
 * year names the collection).
 */
export function parseSeason(input: string | undefined): Season | null {
  if (!input) return null
  const text = input
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[/_.-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!text) return null

  const half = (words: string[]) => words.map((w) => w.replace(/ /g, '\\s?')).join('|')
  const ss = half(SS_WORDS)
  const aw = half(AW_WORDS)
  const year = '(\\d{4}|\\d{2})'

  const patterns: Array<[RegExp, SeasonHalf, number]> = [
    // half then year: "ss02", "s s 2002", "spring summer 2002", "aw03 04"
    [new RegExp(`(?:^|\\s)(?:${ss})\\s?${year}(?!\\d)`), 'SS', 1],
    [new RegExp(`(?:^|\\s)(?:${aw})\\s?${year}(?!\\d)`), 'AW', 1],
    // year then half: "02ss", "2002 ss", "2002春夏", "2003 04aw"
    [new RegExp(`(?:^|\\s)${year}(?:\\s\\d{2})?\\s?(?:${ss})(?:$|\\s)`), 'SS', 1],
    [new RegExp(`(?:^|\\s)${year}(?:\\s\\d{2})?\\s?(?:${aw})(?:$|\\s)`), 'AW', 1],
  ]
  for (const [re, h, group] of patterns) {
    const m = text.match(re)
    if (m?.[group]) return { half: h, year: expandYear(m[group]) }
  }
  return null
}

const yy = (year: number) => String(year % 100).padStart(2, '0')

/** How English-language listings write it, most common first. */
export function seasonVariantsEn(s: Season): string[] {
  const words = s.half === 'SS' ? 'spring summer' : 'fall winter'
  return [`${s.half}${yy(s.year)}`, `${s.half}${s.year}`, `${words} ${s.year}`]
}

/** How Japanese listings write it, most common first. */
export function seasonVariantsJa(s: Season): string[] {
  const kanji = s.half === 'SS' ? '春夏' : '秋冬'
  return [`${yy(s.year)}${s.half}`, `${s.year}${s.half}`, `${s.year}${kanji}`]
}

/**
 * Comme des Garçons–family care tags carry a production year ("AD2002"), not
 * the season. Spring/Summer lines are produced the year before they're shown,
 * so an SS03 piece is usually tagged AD2002 and occasionally AD2003; an AW03
 * piece is tagged AD2003.
 */
export function adCodes(s: Season): string[] {
  return s.half === 'SS' ? [`AD${s.year - 1}`, `AD${s.year}`] : [`AD${s.year}`]
}

/**
 * Every compact spelling of this season — used to check whether a listing's
 * title/snippet mentions it, regardless of how it was written.
 */
export function seasonMatchForms(s: Season): string[] {
  const forms = [
    ...seasonVariantsEn(s),
    ...seasonVariantsJa(s),
    `${s.half === 'SS' ? 'S/S' : 'A/W'}${yy(s.year)}`,
    `${s.half === 'SS' ? 'S/S' : 'A/W'}${s.year}`,
    ...(s.half === 'AW' ? [`FW${yy(s.year)}`, `FW${s.year}`, `${yy(s.year)}FW`, `${s.year}FW`] : []),
  ]
  return [...new Set(forms.map(compact))]
}

/** True if `text` mentions this season in any spelling. */
export function mentionsSeason(text: string, s: Season): boolean {
  const hay = compact(text)
  return seasonMatchForms(s).some((f) => hay.includes(f))
}

/**
 * Every season code written in `text` ("SS02", "03AW", "2004SS"…). Lookarounds
 * keep it from reading "class01" or "ss2002x" as codes; Japanese characters on
 * either side are fine, because that's how Japanese titles are written.
 */
export function seasonCodesIn(text: string): Season[] {
  const hay = fold(text)
  const out: Season[] = []
  const halfOf = (h: string): SeasonHalf => (h === 'ss' ? 'SS' : 'AW')
  for (const m of hay.matchAll(/(?<![a-z0-9])(ss|aw|fw) ?(\d{4}|\d{2})(?!\d)/g)) {
    out.push({ half: halfOf(m[1]), year: expandYear(m[2]) })
  }
  for (const m of hay.matchAll(/(?<![a-z0-9])(\d{4}|\d{2}) ?(ss|aw|fw)(?![a-z])/g)) {
    out.push({ half: halfOf(m[2]), year: expandYear(m[1]) })
  }
  return out
}

/**
 * True if `text` names a season code and none of them is this one — "SS03" on
 * a hunt for SS02 is a strong mismatch signal. Silence is not a mismatch: most
 * listings never state the season at all.
 */
export function mentionsOtherSeason(text: string, s: Season): boolean {
  const codes = seasonCodesIn(text)
  return codes.length > 0 && !codes.some((c) => c.half === s.half && c.year === s.year)
}
