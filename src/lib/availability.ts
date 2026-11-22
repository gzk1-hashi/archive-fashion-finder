/**
 * Is this listing still for sale? Search results go stale fast — Mercari items
 * sell in hours, Yahoo auctions end on a timer — and the search engine's
 * snapshot keeps showing them for days. So the board never trusts the snippet:
 * every candidate's actual page is fetched and read before it can be shown.
 *
 * Two levels:
 *  - `soldInText` — cheap, on the search snippet, run in the free filter. Only
 *    unambiguous phrases; a miss here costs nothing because the page check
 *    runs next.
 *  - `availabilityFromPage` — on the fetched page. Sold markers win over
 *    for-sale markers (a sold Mercari page still renders the "buy" area,
 *    disabled). No marker either way → 'unknown', which the board treats as
 *    not shown: "only available pieces" means proven available.
 */

import type { MarketplaceId } from '../config'

export type Availability = 'available' | 'sold' | 'unknown'

/** Phrases that only ever mean "gone", in English and Japanese resale UI copy. */
const SOLD_ANYWHERE: RegExp[] = [
  /\bsold out\b/i,
  /\bsold price\b/i, // Grailed's label on a sold listing, which search snippets quote
  /\b(?:this|the) (?:item|listing) (?:has been|was|is) sold\b/i,
  /\b(?:this )?listing (?:has |was )?(?:ended|been removed|no longer available)\b/i,
  /\bno longer available\b/i,
  /\bbidding (?:has )?ended\b/i,
  /売り切れ|売切れ/, // "sold out" — Mercari, Rakuma, shops
  /販売終了|販売停止|在庫なし|在庫切れ/, // "sales ended", "out of stock"
  /オークションは終了/, // "this auction has ended" — Yahoo! Auctions
  /取引中/, // Mercari: "in transaction" — bought, not yet shipped; not buyable
]

/**
 * Per-site page copy. `sold` markers are checked first. `forSale` markers are
 * the live purchase controls — positive proof, not just absence of "sold".
 * Note Yahoo's buy-now button is 今すぐ落札する ("win now"), so 落札 alone
 * (which also appears on ended auctions) is never used as a sold marker.
 */
const PAGE_MARKERS: Record<MarketplaceId, { sold: RegExp[]; forSale: RegExp[] }> = {
  grailed: {
    sold: [/\bsold (?:price|for)\b/i, /\bthis listing (?:has been|was) sold\b/i, /^\s*sold\s*$/im],
    forSale: [/\bpurchase\b/i, /\bbuy now\b/i, /\bmake (?:an )?offer\b/i, /\badd to cart\b/i],
  },
  ebay: {
    sold: [/\bthis listing (?:has|was) ended\b/i, /\bthis listing sold\b/i, /\bsold for\b/i, /\bout of stock\b/i],
    forSale: [/\bbuy it now\b/i, /\bplace bid\b/i, /\badd to cart\b/i, /\bmake offer\b/i],
  },
  mercari: {
    sold: [/売り切れました/, /SOLD\b/, /公開停止/, /削除されました/],
    forSale: [/購入手続きへ/, /購入に進む/, /購入する/],
  },
  'yahoo-auctions': {
    sold: [/このオークションは終了しています/, /終了しました/],
    forSale: [/入札する/, /今すぐ落札する/, /残り時間/],
  },
  rakuma: {
    sold: [/SOLD OUT/i, /売り切れ/],
    forSale: [/購入に進む/, /購入手続きへ/],
  },
  '2nd-street': {
    sold: [/SOLD OUT/i, /売り切れ/, /在庫なし/, /販売終了/],
    forSale: [/カートに入れる/, /カートに追加/, /カートへ/, /購入手続き/, /在庫あり/],
  },
}

/** True if the snippet/title text plainly says the item is gone. */
export function soldInText(text: string): boolean {
  const t = text.normalize('NFKC')
  return SOLD_ANYWHERE.some((re) => re.test(t))
}

/**
 * Read a fetched listing page. Only the top of the page is read: "sold" and
 * "buy" both appear in recommendation carousels further down, and those are
 * other people's listings.
 */
export function availabilityFromPage(markdown: string, marketplace: MarketplaceId, headChars = 6000): Availability {
  const head = markdown.normalize('NFKC').slice(0, headChars)
  if (!head.trim()) return 'unknown'
  const { sold, forSale } = PAGE_MARKERS[marketplace]
  if (sold.some((re) => re.test(head)) || SOLD_ANYWHERE.some((re) => re.test(head))) return 'sold'
  if (forSale.some((re) => re.test(head))) return 'available'
  return 'unknown'
}
