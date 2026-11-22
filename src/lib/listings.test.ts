import { describe, expect, it } from 'vitest'
import { canonicalUrl, extractHits, isListingUrl, marketplaceForUrl, normalizePage, normalizeSearchResponse } from './listings'

describe('canonicalUrl', () => {
  it.each([
    [
      'https://www.grailed.com/listings/48211933-junya-watanabe-patchwork?utm_source=x#photos',
      'https://grailed.com/listings/48211933',
    ],
    ['https://www.ebay.com/itm/Junya-Watanabe-Jacket/123456789012?hash=item1', 'https://ebay.com/itm/123456789012'],
    ['https://jp.mercari.com/item/m12345678901?source_location=share', 'https://jp.mercari.com/item/m12345678901'],
    ['http://page.auctions.yahoo.co.jp/jp/auction/x1234567890/', 'https://page.auctions.yahoo.co.jp/jp/auction/x1234567890'],
    ['https://example.com/a?utm_medium=y&id=7', 'https://example.com/a?id=7'],
  ])('%s', (raw, expected) => {
    expect(canonicalUrl(raw)).toBe(expected)
  })

  it('makes slug edits and tracking params collapse to one key', () => {
    const a = canonicalUrl('https://www.grailed.com/listings/48211933-old-slug')
    const b = canonicalUrl('https://grailed.com/listings/48211933-new-slug?ref=feed')
    expect(a).toBe(b)
  })

  it('rejects non-web URLs', () => {
    expect(canonicalUrl('javascript:alert(1)')).toBeNull()
    expect(canonicalUrl('not a url')).toBeNull()
  })
})

describe('marketplace detection', () => {
  it('maps subdomains to their marketplace', () => {
    expect(marketplaceForUrl('https://page.auctions.yahoo.co.jp/jp/auction/x1')).toBe('yahoo-auctions')
    expect(marketplaceForUrl('https://www.2ndstreet.jp/goods/detail/goodsId/1')).toBe('2nd-street')
    expect(marketplaceForUrl('https://evil-grailed.com/listings/1')).toBeNull()
  })

  it('accepts listing pages and drops search/category pages', () => {
    expect(isListingUrl('https://grailed.com/listings/48211933', 'grailed')).toBe(true)
    expect(isListingUrl('https://grailed.com/designers/junya-watanabe', 'grailed')).toBe(false)
    expect(isListingUrl('https://jp.mercari.com/search?keyword=x', 'mercari')).toBe(false)
    expect(isListingUrl('https://item.fril.jp/0123456789abcdef0123456789abcdef', 'rakuma')).toBe(true)
  })
})

describe('extractHits', () => {
  const hit = { url: 'https://grailed.com/listings/1' }
  it.each([
    ['bare array', [hit]],
    ['{ data: [] }', { data: [hit] }],
    ['{ data: { data: [] } }', { data: { data: [hit] } }],
    ['{ data: { web: [] } }', { data: { web: [hit] } }],
    ['{ results: [] }', { results: [hit] }],
  ])('finds hits in %s', (_, raw) => {
    expect(extractHits(raw)).toEqual([hit])
  })

  it('returns [] for empty or unknown shapes', () => {
    expect(extractHits(null)).toEqual([])
    expect(extractHits({ data: {} })).toEqual([])
  })

  it('throws on an explicit provider failure so it counts as a failure, not "no results"', () => {
    expect(() => extractHits({ success: false, error: 'Payment required' })).toThrow(/Payment required/)
  })
})

describe('normalizeSearchResponse', () => {
  it('canonicalizes, filters to listing pages on the right market, and de-dupes', () => {
    const raw = {
      data: [
        { url: 'https://www.grailed.com/listings/111-a?utm_source=g', title: 'Junya SS02', description: '$450' },
        { url: 'https://grailed.com/listings/111-b', title: 'dupe of the above' },
        { url: 'https://grailed.com/designers/junya-watanabe', title: 'category page' },
        { url: 'https://jp.mercari.com/item/m1', title: 'wrong market for this query' },
        { metadata: { sourceURL: 'https://grailed.com/listings/222', title: 'meta-only', ogImage: 'https://img/x.jpg' } },
        { url: 42 }, // malformed — skipped, not fatal
      ],
    }
    const out = normalizeSearchResponse(raw, 'grailed')
    expect(out.map((l) => l.url)).toEqual(['https://grailed.com/listings/111', 'https://grailed.com/listings/222'])
    expect(out[0]).toMatchObject({ title: 'Junya SS02', snippet: '$450', marketplace: 'grailed' })
    expect(out[1].imageUrl).toBe('https://img/x.jpg')
  })
})

describe('normalizePage', () => {
  it('unwraps either response shape and reads og:image + structured price', () => {
    const page = { markdown: '# Junya parka\nPurchase', metadata: { ogImage: 'https://cdn.grailed.com/a.jpg', 'product:price:amount': '420.00', 'product:price:currency': 'USD' } }
    for (const raw of [page, { data: page }, { data: { data: page } }]) {
      expect(normalizePage(raw)).toEqual({
        markdown: '# Junya parka\nPurchase',
        imageUrl: 'https://cdn.grailed.com/a.jpg',
        price: { amount: 420, currency: 'USD', text: '$420' },
        statusCode: undefined,
        costUsd: undefined,
        declaredAvailability: undefined,
      })
    }
  })

  it('handles repeated meta tags (arrays) and JPY prices', () => {
    const p = normalizePage({ metadata: { 'og:image': ['https://static.mercdn.net/x.jpg', 'https://static.mercdn.net/y.jpg'], 'og:price:amount': '38000', 'og:price:currency': 'JPY' } })
    expect(p.imageUrl).toBe('https://static.mercdn.net/x.jpg')
    expect(p.price).toEqual({ amount: 38000, currency: 'JPY', text: '¥38,000' })
    expect(p.markdown).toBe('')
  })

  it('reads the integration envelope { data, creditsUsed, costUsd }', () => {
    const p = normalizePage({ data: { markdown: 'Purchase', metadata: { statusCode: 200 } }, creditsUsed: 1, costUsd: 0.0011 })
    expect(p).toMatchObject({ markdown: 'Purchase', statusCode: 200, costUsd: 0.0011 })
  })

  it('reads schema.org availability from raw HTML, then meta tags', () => {
    const rawHtml = '<script type="application/ld+json">{"@type":"Product","offers":{"availability":"https://schema.org/SoldOut","price":"38000","priceCurrency":"JPY"}}</script>'
    expect(normalizePage({ data: { markdown: '購入手続きへ', rawHtml, metadata: {} } })).toMatchObject({
      declaredAvailability: 'sold',
      price: { amount: 38000, currency: 'JPY' },
    })
    expect(normalizePage({ markdown: '', metadata: { 'product:availability': 'in stock' } }).declaredAvailability).toBe('available')
    expect(normalizePage({ markdown: '', metadata: { 'product:availability': 'oos' } }).declaredAvailability).toBe('sold')
  })

  it('drops non-https images and throws on provider failure', () => {
    expect(normalizePage({ markdown: 'x', metadata: { ogImage: 'http://insecure/x.jpg' } }).imageUrl).toBeUndefined()
    expect(() => normalizePage({ success: false, error: 'blocked' })).toThrow(/blocked/)
  })
})
