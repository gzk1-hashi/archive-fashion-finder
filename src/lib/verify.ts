/**
 * Fold a fetched listing page back into a candidate. Pure: the page fetch
 * happens in the scan job; this decides what the page proves.
 *
 * The page beats the snippet on everything it knows: availability (the
 * snippet can be days old), price (structured meta tags over a regex on a
 * summary) and photo (og:image). After a better price, the budget is checked
 * again — a snippet that hid the price can't smuggle a $900 piece onto a $400
 * board.
 */

import type { MarketplaceId } from '../config'
import type { Candidate, HuntFilterInput } from './filter'
import { availabilityFromPage, type Availability } from './availability'
import type { ListingPage } from './listings'
import { landedCost, parsePrice, withinBudget } from './pricing'

export type VerifyResult =
  | { kind: 'available'; candidate: Candidate }
  | { kind: 'sold'; detail: string }
  | { kind: 'over-budget'; landedUsd: number }
  | { kind: 'unknown' }

/**
 * What a fetched page proves. Any evidence of "sold" wins over any evidence of
 * "available" — showing a gone piece costs the user's trust, hiding a live one
 * costs one listing:
 *  1. the page is gone (404/410) → sold;
 *  2. structured data says sold, OR the page copy says sold → sold
 *     (sites have been seen keeping schema.org `InStock` on sold listings);
 *  3. structured data says in stock, OR the copy shows live buy controls → available;
 *  4. otherwise unknown.
 */
export function pageAvailability(page: ListingPage, marketplace: MarketplaceId): Availability {
  if (page.statusCode === 404 || page.statusCode === 410) return 'sold'
  const fromCopy = availabilityFromPage(page.markdown, marketplace)
  if (page.declaredAvailability === 'sold' || fromCopy === 'sold') return 'sold'
  if (page.declaredAvailability === 'available' || fromCopy === 'available') return 'available'
  return 'unknown'
}

/** Signals the filter wrote from the snippet that the page now supersedes. */
const SNIPPET_PRICE_SIGNAL = /^(?:landed cost ~|price not visible)/

export function verifyCandidate(c: Candidate, page: ListingPage, hunt: HuntFilterInput): VerifyResult {
  const availability = pageAvailability(page, c.marketplace)
  if (availability === 'sold') return { kind: 'sold', detail: 'listing page says sold / ended / gone' }
  if (availability === 'unknown') return { kind: 'unknown' }

  // Structured price first; then the snippet's; then the top of the page,
  // where every marketplace renders the item's own price before anything else.
  const price = page.price ?? c.price ?? parsePrice(page.markdown.slice(0, 1500))
  const cost = price ? landedCost(price, c.marketplace) : null
  if (cost && !withinBudget(cost.landedUsd, hunt.maxPriceUsd)) return { kind: 'over-budget', landedUsd: cost.landedUsd }

  const signals = [
    ...c.signals.filter((s) => !SNIPPET_PRICE_SIGNAL.test(s)),
    page.declaredAvailability ? 'listing page declares it in stock' : 'listing page shows it is for sale',
    cost ? `landed cost ~$${cost.landedUsd} (${cost.parts.join(' + ')})` : 'price not visible on the page',
  ]
  return {
    kind: 'available',
    candidate: { ...c, price, cost, imageUrl: page.imageUrl ?? c.imageUrl, signals },
  }
}
