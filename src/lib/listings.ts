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
