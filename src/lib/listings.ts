/**
 * Search-provider output → Listing. The provider is untyped JSON from outside
 * our control, so it's parsed with Zod at the boundary and everything past this
 * file works with one known shape.
 *
 * Canonical URLs matter more than they look: they are the dedupe key for the
 * `uniqueOn: ['huntId', 'url']` index on matches and seen_listings. If
 * `?utm_source=…` or a changed Grailed slug produced a "new" URL, the same
 * listing would be paid for and shown again on every scan.
 */

import { z } from 'zod'
import { MARKETPLACES, MARKETPLACE_IDS, type MarketplaceId } from '../config'
import type { Availability } from './availability'
import { parsePrice, type ParsedPrice } from './pricing'
import { structuredProduct } from './structured-data'

export interface Listing {
  url: string
  marketplace: MarketplaceId
  title: string
  snippet: string
  imageUrl?: string
}

// ─── Provider shapes ─────────────────────────────────────────────────────────

/**
 * One search hit. Firecrawl has shipped several shapes over time (top-level
 * fields, everything under `metadata`, `og:` keys), so every field is optional
 * and resolved by precedence below.
 */
const HitSchema = z
  .object({
    url: z.string().optional(),
    title: z.string().optional(),
    description: z.string().optional(),
    snippet: z.string().optional(),
    imageUrl: z.string().optional(),
    image: z.string().optional(),
    thumbnail: z.string().optional(),
    metadata: z
      .object({
        sourceURL: z.string().optional(),
        url: z.string().optional(),
        title: z.string().optional(),
        description: z.string().optional(),
        ogImage: z.string().optional(),
        'og:image': z.string().optional(),
      })
      .partial()
      .optional(),
  })
  .loose()

type Hit = z.infer<typeof HitSchema>

/**
 * Find the array of hits however it was wrapped. Seen in the wild:
 * `[...]`, `{ data: [...] }`, `{ data: { data: [...] } }`, `{ data: { web: [...] } }`,
 * `{ web: [...] }`, `{ results: [...] }`. A `{ success: false }` body is a
 * provider error, not "no results", and is thrown so the caller counts it as a
 * failure instead of quietly paying for the next query.
 */
export function extractHits(raw: unknown): unknown[] {
  const seen = new Set<unknown>()
  const visit = (node: unknown, depth: number): unknown[] | null => {
    if (Array.isArray(node)) return node
    if (!node || typeof node !== 'object' || depth > 3 || seen.has(node)) return null
    seen.add(node)
    const obj = node as Record<string, unknown>
    if (obj.success === false) {
      throw new Error(`search provider error: ${String(obj.error ?? obj.message ?? 'unknown')}`)
    }
    for (const key of ['data', 'web', 'results', 'organic']) {
      const found = visit(obj[key], depth + 1)
      if (found) return found
    }
    return null
  }
  return visit(raw, 0) ?? []
}

// ─── URLs ────────────────────────────────────────────────────────────────────

/** Query params that never change which item a URL points at. */
const TRACKING_PARAM = /^(utm_|fbclid|gclid|msclkid|ref|_trkparms|_trksid|hash|amdata|campid|mkevt|mkcid|mkrid|toolid|customid|afsrc)/i

/** Bare hostname without www, or '' if unparseable. */
export function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '')
  } catch {
    return ''
  }
}

/** Which marketplace a URL belongs to, by registrable domain. */
export function marketplaceForUrl(url: string): MarketplaceId | null {
  const host = hostnameOf(url)
  if (!host) return null
  for (const id of MARKETPLACE_IDS) {
    const domain = MARKETPLACES[id].domain
    if (host === domain || host.endsWith(`.${domain}`)) return id
  }
  return null
}

/**
 * One URL per item. https, lowercase host, no www, no fragment, no tracking
 * params, no trailing slash — plus per-site rules where the path itself
 * carries noise:
 *  - Grailed: /listings/12345678-junya-watanabe-… → /listings/12345678 (slug edits keep the id)
 *  - eBay: /itm/Some-Title/123456789012 → /itm/123456789012
 *  - Mercari / Yahoo / Rakuma / 2nd Street: id is already the path; query dropped entirely
 */
export function canonicalUrl(raw: string): string | null {
  let u: URL
  try {
    u = new URL(raw.trim())
  } catch {
    return null
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null
  u.protocol = 'https:'
  u.hostname = u.hostname.toLowerCase().replace(/^www\./, '')
  u.hash = ''

  const market = marketplaceForUrl(u.toString())
  let path = u.pathname.replace(/\/+$/, '') || '/'

  if (market === 'grailed') {
    const m = path.match(/^\/listings\/(\d+)/)
    if (m) path = `/listings/${m[1]}`
    u.search = ''
  } else if (market === 'ebay') {
    const m = path.match(/^\/itm\/(?:[^/]+\/)?(\d{9,})/)
    if (m) path = `/itm/${m[1]}`
    u.search = ''
  } else if (market) {
    u.search = ''
  } else {
    for (const key of [...u.searchParams.keys()]) {
      if (TRACKING_PARAM.test(key)) u.searchParams.delete(key)
    }
  }
  u.pathname = path
  return u.toString().replace(/\/$/, '')
}

/** True if the URL is a single listing page on its marketplace (not search, category or profile). */
export function isListingUrl(url: string, marketplace: MarketplaceId): boolean {
  try {
    return MARKETPLACES[marketplace].listingPath.test(new URL(url).pathname)
  } catch {
    return false
  }
}

// ─── Normalization ───────────────────────────────────────────────────────────

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

function httpsOrUndefined(v: string | undefined): string | undefined {
  if (!v) return undefined
  try {
    const u = new URL(v)
    return u.protocol === 'https:' ? u.toString() : undefined
  } catch {
    return undefined
  }
}

function toListing(hit: Hit, expected: MarketplaceId): Listing | null {
  const rawUrl = hit.url ?? hit.metadata?.sourceURL ?? hit.metadata?.url
  if (!rawUrl) return null
  const url = canonicalUrl(rawUrl)
  if (!url) return null
  // The engine sometimes ignores site: and returns a neighbour; trust the URL.
  const market = marketplaceForUrl(url)
  if (market !== expected) return null
  if (!isListingUrl(url, market)) return null
  return {
    url,
    marketplace: market,
    title: clip((hit.title ?? hit.metadata?.title ?? '').trim(), 300),
    snippet: clip((hit.description ?? hit.snippet ?? hit.metadata?.description ?? '').trim(), 600),
    imageUrl: httpsOrUndefined(
      hit.imageUrl ?? hit.image ?? hit.thumbnail ?? hit.metadata?.ogImage ?? hit.metadata?.['og:image'],
    ),
  }
}

/**
 * Raw provider response → listings on `marketplace`, canonicalized and
 * de-duplicated. Malformed hits are skipped individually; one bad row never
 * sinks the batch.
 */
export function normalizeSearchResponse(raw: unknown, marketplace: MarketplaceId): Listing[] {
  const out = new Map<string, Listing>()
  for (const item of extractHits(raw)) {
    const parsed = HitSchema.safeParse(item)
    if (!parsed.success) continue
    const listing = toListing(parsed.data, marketplace)
    if (listing && !out.has(listing.url)) out.set(listing.url, listing)
  }
  return [...out.values()]
}

// ─── Listing pages (firecrawl/scrape) ────────────────────────────────────────

export interface ListingPage {
  /** Page text as markdown ('' if the provider returned none). */
  markdown: string
  /** og:image (https only) — the listing's main photo on every marketplace we search. */
  imageUrl?: string
  /** Structured price from meta tags, when the site publishes one. */
  price?: ParsedPrice
  /** HTTP status the provider saw. 404/410 = the listing was deleted. */
  statusCode?: number
  /** What the call actually billed, when the integration reports it. */
  costUsd?: number
  /**
   * Availability the page declares in machine-readable form (schema.org
   * JSON-LD / microdata, or a product:availability meta tag). Absent when the
   * page publishes none — then the page-copy markers decide.
   */
  declaredAvailability?: Exclude<Availability, 'unknown'>
}

/** og/product meta availability values seen in the wild: "instock", "in stock", "oos", "out of stock". */
function metaAvailability(meta: Record<string, unknown>): ListingPage['declaredAvailability'] {
  const v = metaString(meta, 'product:availability', 'og:availability', 'availability')
    ?.toLowerCase()
    .replace(/^https?:\/\/schema\.org\//, '')
    .replace(/[\s_-]/g, '')
  if (!v) return undefined
  if (['instock', 'available', 'preorder', 'limitedavailability'].includes(v)) return 'available'
  if (['outofstock', 'oos', 'soldout', 'discontinued'].includes(v)) return 'sold'
  return undefined
}

/** Meta values arrive as a string, or as an array when the tag repeats. */
function metaString(meta: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const v = meta[key]
    const s = Array.isArray(v) ? v.find((x) => typeof x === 'string') : v
    if (typeof s === 'string' && s.trim()) return s.trim()
  }
  return undefined
}

/**
 * Price from the page's structured data. Grailed, eBay and most shops publish
 * og/product price tags; reading those beats regexing a page full of other
 * listings' prices.
 */
function metaPrice(meta: Record<string, unknown>): ParsedPrice | undefined {
  const amountRaw = metaString(meta, 'product:price:amount', 'og:price:amount', 'price', 'twitter:data1')
  if (!amountRaw) return undefined
  const amount = Number(amountRaw.replace(/[^\d.]/g, ''))
  const currency = (metaString(meta, 'product:price:currency', 'og:price:currency', 'priceCurrency') ?? '').toUpperCase()
  if (!Number.isFinite(amount) || amount <= 0) return undefined
  if (currency === 'JPY') return { amount, currency: 'JPY', text: `¥${amount.toLocaleString('en-US')}` }
  if (currency === 'USD') return { amount, currency: 'USD', text: `$${amount.toLocaleString('en-US')}` }
  return parsePrice(amountRaw) ?? undefined
}

/**
 * Raw scrape response → ListingPage. The integration returns
 * `{ data: <Firecrawl payload>, creditsUsed, costUsd }` (its published output
 * schema); the payload itself has been wrapped differently over time
 * (`{ markdown, metadata }`, `{ data: { markdown, metadata } }`), so it's
 * unwrapped by shape. An explicit
 * `{ success: false }` throws so the caller counts a failure.
 */
export function normalizePage(raw: unknown): ListingPage {
  // The integration wraps Firecrawl's payload as { data, creditsUsed, costUsd }.
  const billed = raw && typeof raw === 'object' ? (raw as Record<string, unknown>).costUsd : undefined
  let node: unknown = raw
  for (let depth = 0; depth < 3 && node && typeof node === 'object'; depth++) {
    const obj = node as Record<string, unknown>
    if (obj.success === false) throw new Error(`scrape provider error: ${String(obj.error ?? obj.message ?? 'unknown')}`)
    if ('markdown' in obj || 'metadata' in obj) break
    node = obj.data
  }
  const obj = (node && typeof node === 'object' ? node : {}) as Record<string, unknown>
  const meta = (obj.metadata && typeof obj.metadata === 'object' ? obj.metadata : {}) as Record<string, unknown>
  // Raw HTML is read for its schema.org data and then dropped — never stored.
  const product = structuredProduct(typeof obj.rawHtml === 'string' ? obj.rawHtml : typeof obj.html === 'string' ? obj.html : undefined)
  return {
    markdown: typeof obj.markdown === 'string' ? obj.markdown : '',
    imageUrl: httpsOrUndefined(metaString(meta, 'ogImage', 'og:image', 'og:image:secure_url', 'twitter:image') ?? product.imageUrl),
    price: product.price ?? metaPrice(meta),
    declaredAvailability: product.availability ?? metaAvailability(meta),
    statusCode: typeof meta.statusCode === 'number' ? meta.statusCode : undefined,
    costUsd: typeof billed === 'number' && Number.isFinite(billed) && billed >= 0 ? billed : undefined,
  }
}
