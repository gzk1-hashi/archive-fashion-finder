/**
 * Hunt → search plan. Pure: same hunt in, same queries out, so the tests can
 * pin exactly what a scan will pay for.
 *
 * Each query targets ONE marketplace with a `site:` filter. One combined
 * `(site:a OR site:b)` query sounds cheaper but the engine collapses it to the
 * strongest domain and the long tail vanishes; per-site queries keep every
 * market represented.
 *
 * Queries are emitted in tiers — season-specific first, then broad, then the
 * Comme des Garçons production-code trick — and round-robin across
 * marketplaces inside each tier, so the cap trims the least specific queries
 * instead of starving a whole market.
 */

import { FUNNEL, MARKETPLACES, type MarketplaceId } from '../config'
import { resolveDesigner, garmentJa } from './designers'
import { adCodes, parseSeason, seasonVariantsEn, seasonVariantsJa } from './season'
import { fold, unique } from './text'

export interface HuntQueryInput {
  designer: string
  piece: string
  season?: string
}

export interface PlannedQuery {
  marketplace: MarketplaceId
  /** What the user would type into the site's own search box. */
  terms: string
  /** `terms` + the `site:` filter — the exact string sent to the search API. */
  query: string
}

/**
 * Descriptors worth translating. Japanese sellers describe material and
 * construction in Japanese even when the brand is romanized; English
 * descriptors on a Mercari query mostly just shrink the result set.
 */
const DESCRIPTORS_JA: Record<string, string> = {
  patchwork: 'パッチワーク',
  camo: '迷彩',
  camouflage: '迷彩',
  leather: 'レザー',
  wool: 'ウール',
  mohair: 'モヘア',
  nylon: 'ナイロン',
  cotton: 'コットン',
  linen: 'リネン',
  check: 'チェック',
  plaid: 'チェック',
  tartan: 'タータンチェック',
  stripe: 'ストライプ',
  striped: 'ストライプ',
  military: 'ミリタリー',
  reversible: 'リバーシブル',
  distressed: 'ダメージ',
  bondage: 'ボンテージ',
  hooded: 'フード付き',
  graphic: 'グラフィック',
  embroidered: '刺繍',
  velvet: 'ベロア',
  corduroy: 'コーデュロイ',
}

/** Romanized, accent-free display name — what an English listing title uses. */
function englishName(designerInput: string): string {
  const d = resolveDesigner(designerInput)
  const name = d?.name ?? designerInput
  return name.normalize('NFD').replace(/\p{M}+/gu, '').trim()
}

function japaneseTerms(designerInput: string, piece: string): string {
  const d = resolveDesigner(designerInput)
  const brand = d?.ja[0] ?? englishName(designerInput)
  const garment = garmentJa(piece)?.[0]
  const descriptors = unique(
    fold(piece)
      .split(' ')
      .map((w) => DESCRIPTORS_JA[w])
      // "leather jacket" already becomes レザージャケット — don't also add レザー.
      .filter((w): w is string => Boolean(w) && !garment?.includes(w)),
  )
  // Nothing translated → keep the English piece: a romanized query on Mercari
  // still beats a brand-only query that returns every item the label ever made.
  const pieceTerms = garment || descriptors.length > 0 ? [...descriptors, garment ?? ''] : [piece]
  return [brand, ...pieceTerms].filter(Boolean).join(' ')
}

function plan(marketplace: MarketplaceId, terms: string): PlannedQuery {
  const clean = terms.replace(/\s+/g, ' ').trim()
  return { marketplace, terms: clean, query: `${clean} site:${MARKETPLACES[marketplace].domain}` }
}

const EN_MARKETS: MarketplaceId[] = ['grailed', 'ebay']
const JA_MARKETS: MarketplaceId[] = ['mercari', 'yahoo-auctions', 'rakuma', '2nd-street']
/** Order inside each tier: alternate English and Japanese markets so a tight cap keeps both. */
const ROTATION: MarketplaceId[] = ['grailed', 'mercari', 'yahoo-auctions', 'ebay', 'rakuma', '2nd-street']

export function buildQueries(hunt: HuntQueryInput, limit: number = FUNNEL.maxQueries): PlannedQuery[] {
  const en = `${englishName(hunt.designer)} ${hunt.piece}`
  const ja = japaneseTerms(hunt.designer, hunt.piece)
  const season = parseSeason(hunt.season)
  const designer = resolveDesigner(hunt.designer)

  const termsFor = (m: MarketplaceId, suffix: { en?: string; ja?: string }) =>
    EN_MARKETS.includes(m) ? `${en} ${suffix.en ?? ''}` : `${ja} ${suffix.ja ?? ''}`

  const tiers: PlannedQuery[][] = []
  if (season) {
    const sEn = seasonVariantsEn(season)[0]
    const sJa = seasonVariantsJa(season)[0]
    tiers.push(ROTATION.map((m) => plan(m, termsFor(m, { en: sEn, ja: sJa }))))
  }
  tiers.push(ROTATION.map((m) => plan(m, termsFor(m, {}))))
  if (season && designer?.adCode) {
    // Production-code queries only make sense where Japanese sellers list tag
    // details: the two biggest Japanese C2C markets.
    const code = adCodes(season)[0]
    tiers.push(JA_MARKETS.slice(0, 2).map((m) => plan(m, `${ja} ${code}`)))
  }

  return unique(tiers.flat(), (q) => q.query).slice(0, Math.max(0, limit))
}
