import { describe, expect, it } from 'vitest'
import { canonicalUrl, extractHits, isListingUrl, marketplaceForUrl, normalizeSearchResponse } from './listings'

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
