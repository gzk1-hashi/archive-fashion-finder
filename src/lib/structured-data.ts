/**
 * schema.org product data from a listing page's raw HTML.
 *
 * Marketplaces publish machine-readable product data for search engines —
 * JSON-LD `Product` → `offers.availability: "https://schema.org/InStock"`, or
 * the same as microdata attributes. It's the most reliable "still for sale?"
 * signal there is: it's in the same vocabulary on every site, it doesn't change
 * when the UI copy is redesigned, and it isn't affected by how the page renders
 * to markdown (buttons often don't survive that). Page-copy markers
 * (availability.ts) are the fallback when a site publishes none.
 */

import type { Availability } from './availability'
import type { ParsedPrice } from './pricing'

export interface StructuredProduct {
  availability?: Exclude<Availability, 'unknown'>
  price?: ParsedPrice
  imageUrl?: string
}

/** schema.org ItemAvailability → ours. Anything not listed says nothing. */
const AVAILABILITY: Record<string, Exclude<Availability, 'unknown'>> = {
  instock: 'available',
  instoreonly: 'available',
  onlineonly: 'available',
  limitedavailability: 'available',
  preorder: 'available',
  presale: 'available',
  soldout: 'sold',
  outofstock: 'sold',
  discontinued: 'sold',
}

function availabilityOf(value: unknown): StructuredProduct['availability'] {
  if (typeof value !== 'string') return undefined
  const key = value.replace(/^https?:\/\/schema\.org\//i, '').toLowerCase()
  return AVAILABILITY[key]
}

const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : v === undefined || v === null ? [] : [v])

function firstImage(v: unknown): string | undefined {
  for (const item of asArray(v)) {
    const url = typeof item === 'string' ? item : item && typeof item === 'object' ? (item as Record<string, unknown>).url : undefined
    if (typeof url === 'string' && url.startsWith('https://')) return url
  }
  return undefined
}

function priceOf(offer: Record<string, unknown>): ParsedPrice | undefined {
  const amount = Number(String(offer.price ?? offer.lowPrice ?? '').replace(/[^\d.]/g, ''))
  const currency = String(offer.priceCurrency ?? '').toUpperCase()
  if (!Number.isFinite(amount) || amount <= 0) return undefined
  if (currency === 'JPY') return { amount, currency: 'JPY', text: `¥${amount.toLocaleString('en-US')}` }
  if (currency === 'USD') return { amount, currency: 'USD', text: `$${amount.toLocaleString('en-US')}` }
  return undefined
}

/** Every object in a JSON-LD document, depth-first (handles @graph and nesting). */
function* walk(node: unknown, depth = 0): Generator<Record<string, unknown>> {
  if (depth > 6 || !node || typeof node !== 'object') return
  if (Array.isArray(node)) {
    for (const n of node) yield* walk(n, depth + 1)
    return
  }
  const obj = node as Record<string, unknown>
  yield obj
  for (const v of Object.values(obj)) if (v && typeof v === 'object') yield* walk(v, depth + 1)
}

const isProduct = (o: Record<string, unknown>) => asArray(o['@type']).some((t) => t === 'Product' || t === 'IndividualProduct')

/** The first Product in the page's JSON-LD — the listing itself, by convention. */
function fromJsonLd(html: string): StructuredProduct | null {
  for (const m of html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    let doc: unknown
    try {
      doc = JSON.parse(m[1].trim())
    } catch {
      continue // one malformed block shouldn't hide the next
    }
    for (const obj of walk(doc)) {
      if (!isProduct(obj)) continue
      const offer = asArray(obj.offers).find((o): o is Record<string, unknown> => !!o && typeof o === 'object')
      return {
        availability: offer ? availabilityOf(offer.availability) : undefined,
        price: offer ? priceOf(offer) : undefined,
        imageUrl: firstImage(obj.image),
      }
    }
  }
  return null
}

/** Microdata fallback: <link itemprop="availability" href="https://schema.org/InStock"> and friends. */
function fromMicrodata(html: string): StructuredProduct['availability'] {
  const tag = html.match(/<[^>]*itemprop=["']availability["'][^>]*>/i)?.[0]
  const value = tag?.match(/(?:content|href)=["']([^"']+)["']/i)?.[1]
  return availabilityOf(value)
}

export function structuredProduct(html: string | undefined): StructuredProduct {
  if (!html) return {}
  const ld = fromJsonLd(html)
  return {
    availability: ld?.availability ?? fromMicrodata(html),
    price: ld?.price,
    imageUrl: ld?.imageUrl,
  }
}
