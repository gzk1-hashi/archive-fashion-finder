/**
 * Text normalization shared by the query builder, the filter and the tests.
 *
 * Listings are written by people typing fast on phones in two scripts, so
 * "Comme des Garçons", "COMME des GARCONS", "comme-des-garcons" and
 * "ｃｏｍｍｅ　ｄｅｓ　ｇａｒçｏｎｓ" all have to compare equal.
 */

/**
 * Fold case, width and diacritics; turn every run of punctuation/space into one
 * space. NFKC first maps full-width Latin and half-width katakana to their
 * normal forms (ﾌﾞﾙｿﾞﾝ → ブルゾン), then NFD + stripping combining marks
 * removes accents (ç → c). The NFD step would also split ガ into カ + ゛, so it
 * is applied to Latin characters only.
 */
export function fold(input: string): string {
  return input
    .normalize('NFKC')
    .replace(/[A-Za-zÀ-ÖØ-öø-ÿ]+/g, (latin) => latin.normalize('NFD').replace(/\p{M}+/gu, ''))
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, ' ')
    .trim()
}

/** `fold` with all spaces removed — for matching "commedesgarcons" style slugs. */
export function compact(input: string): string {
  return fold(input).replace(/ /g, '')
}

/** True if `needle` appears in `haystack` after folding both, ignoring spaces. */
export function containsFolded(haystack: string, needle: string): boolean {
  const n = compact(needle)
  return n.length > 0 && compact(haystack).includes(n)
}

/** Meaningful lowercase tokens of a phrase (drops 1-char noise and stopwords). */
const STOPWORDS = new Set(['the', 'a', 'an', 'of', 'and', 'with', 'in', 'for', 'by'])
export function tokens(input: string): string[] {
  return fold(input)
    .split(' ')
    .filter((t) => t.length > 1 && !STOPWORDS.has(t))
}

/** Stable de-duplication that keeps first occurrence order. */
export function unique<T>(items: Iterable<T>, key: (item: T) => string = String): T[] {
  const seen = new Set<string>()
  const out: T[] = []
  for (const item of items) {
    const k = key(item)
    if (seen.has(k)) continue
    seen.add(k)
    out.push(item)
  }
  return out
}
