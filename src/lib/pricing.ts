/**
 * Prices out of search snippets, and what a listing really costs to land.
 *
 * A ¥38,000 Mercari jacket is not a $238 jacket: it's ¥38,000 + the proxy's
 * fee + shipping to the proxy's warehouse + EMS to the US. Budgets are compared
 * against that landed number, because that's the number the buyer pays.
 */

import {
  BUDGET_SLACK,
  FX,
  MARKETPLACES,
  PROXY_COSTS_JPY,
  US_SHIPPING_USD,
  type MarketplaceId,
} from '../config'

export type Currency = 'USD' | 'JPY'

export interface ParsedPrice {
  amount: number
  currency: Currency
  /** The exact substring the price was read from — shown to the user verbatim. */
  text: string
}

interface Candidate extends ParsedPrice {
  index: number
}

const num = (raw: string) => Number(raw.replace(/,/g, ''))

/**
 * Words that mean "this is NOT the asking price". Japanese listings routinely
 * quote 定価 (original retail) right next to the asking price — reading that
 * number would make every listing look 3–5x more expensive than it is.
 */
const NOT_ASKING = /(定価|参考価格|参考上代|元値|購入価格|retail|msrp|originally|orig\.?|was)\s*[:：]?\s*$/i

const PATTERNS: Array<{ re: RegExp; currency: Currency; amount: (m: RegExpMatchArray) => number }> = [
  // 1.2万円 / 3万円 — man (万) is 10,000; very common in casual listings
  { re: /(\d+(?:\.\d+)?)\s*万\s*円/g, currency: 'JPY', amount: (m) => Math.round(Number(m[1]) * 10_000) },
  { re: /[¥]\s*(\d{1,3}(?:,\d{3})+|\d+)/g, currency: 'JPY', amount: (m) => num(m[1]) },
  { re: /(\d{1,3}(?:,\d{3})+|\d+)\s*円/g, currency: 'JPY', amount: (m) => num(m[1]) },
  { re: /(?:JPY)\s*(\d{1,3}(?:,\d{3})+|\d+)/gi, currency: 'JPY', amount: (m) => num(m[1]) },
  { re: /(\d{1,3}(?:,\d{3})+|\d+)\s*JPY/gi, currency: 'JPY', amount: (m) => num(m[1]) },
  { re: /(?:US\s?\$|USD\s?\$?|\$)\s*(\d{1,3}(?:,\d{3})+(?:\.\d{2})?|\d+(?:\.\d{2})?)/g, currency: 'USD', amount: (m) => num(m[1]) },
  { re: /(\d{1,3}(?:,\d{3})+(?:\.\d{2})?|\d+(?:\.\d{2})?)\s*USD/gi, currency: 'USD', amount: (m) => num(m[1]) },
]

/** Plausible asking-price range per currency; outside it, it's a model number or a year. */
const BOUNDS: Record<Currency, [min: number, max: number]> = {
  JPY: [300, 50_000_000], // ¥300 is Mercari's floor
  USD: [5, 500_000],
}

/**
 * First asking price mentioned in `text`, or null. Full-width digits and the
 * full-width yen sign are folded by NFKC before matching.
 */
export function parsePrice(text: string | undefined): ParsedPrice | null {
  if (!text) return null
  const hay = text.normalize('NFKC')
  const found: Candidate[] = []
  for (const { re, currency, amount } of PATTERNS) {
    for (const m of hay.matchAll(re)) {
      const value = amount(m)
      const [min, max] = BOUNDS[currency]
      if (!Number.isFinite(value) || value < min || value > max) continue
      const before = hay.slice(Math.max(0, (m.index ?? 0) - 12), m.index)
      if (NOT_ASKING.test(before)) continue
      found.push({ amount: value, currency, text: m[0].trim(), index: m.index ?? 0 })
    }
  }
  if (found.length === 0) return null
  found.sort((a, b) => a.index - b.index)
  const { amount, currency, text: matched } = found[0]
  return { amount, currency, text: matched }
}

export function toUsd(price: Pick<ParsedPrice, 'amount' | 'currency'>): number {
  return price.currency === 'USD' ? price.amount : price.amount / FX.jpyPerUsd
}

export interface LandedCost {
  priceUsd: number
  landedUsd: number
  /** Human-readable parts, for a tooltip: ["item $238", "proxy + shipping $37"]. */
  parts: string[]
}

/**
 * Item price → door-to-door USD. Japanese domestic marketplaces add the proxy's
 * fee and two legs of shipping (seller → proxy warehouse → US); US marketplaces
 * add a flat domestic shipping guess.
 */
export function landedCost(price: Pick<ParsedPrice, 'amount' | 'currency'>, marketplace: MarketplaceId): LandedCost {
  const itemUsd = toUsd(price)
  let extraUsd: number
  if (MARKETPLACES[marketplace].viaProxy) {
    const { serviceFee, domesticShipping, internationalShipping } = PROXY_COSTS_JPY
    extraUsd = (serviceFee + domesticShipping + internationalShipping) / FX.jpyPerUsd
  } else {
    extraUsd = US_SHIPPING_USD
  }
  const label = MARKETPLACES[marketplace].viaProxy ? 'proxy + shipping' : 'shipping'
  return {
    priceUsd: Math.round(itemUsd),
    landedUsd: Math.round(itemUsd + extraUsd),
    parts: [`item $${Math.round(itemUsd)}`, `${label} ~$${Math.round(extraUsd)}`],
  }
}

/**
 * Inside budget, with slack for estimate error. Unknown price or no budget →
 * true: a listing whose snippet hides the price is exactly the kind a human
 * would still click.
 */
export function withinBudget(landedUsd: number | undefined, maxPriceUsd: number | undefined): boolean {
  if (landedUsd === undefined || maxPriceUsd === undefined || maxPriceUsd <= 0) return true
  return landedUsd <= maxPriceUsd * (1 + BUDGET_SLACK)
}

export function formatUsd(n: number | undefined): string {
  return n === undefined ? '—' : `$${Math.round(n).toLocaleString('en-US')}`
}
