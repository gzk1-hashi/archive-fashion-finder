import { describe, expect, it } from 'vitest'
import { structuredProduct } from './structured-data'

const ld = (obj: unknown) => `<html><head><script type="application/ld+json">${JSON.stringify(obj)}</script></head></html>`

describe('structuredProduct', () => {
  it('reads availability, price and image from JSON-LD', () => {
    const html = ld({
      '@context': 'https://schema.org',
      '@type': 'Product',
      name: 'ジュンヤワタナベマン パーカー',
      image: ['https://static.mercdn.net/item/1.jpg'],
      offers: { '@type': 'Offer', price: '38000', priceCurrency: 'JPY', availability: 'https://schema.org/InStock' },
    })
    expect(structuredProduct(html)).toEqual({
      availability: 'available',
      price: { amount: 38000, currency: 'JPY', text: '¥38,000' },
      imageUrl: 'https://static.mercdn.net/item/1.jpg',
    })
  })

  it.each([
    ['https://schema.org/SoldOut', 'sold'],
    ['http://schema.org/OutOfStock', 'sold'],
    ['Discontinued', 'sold'],
    ['https://schema.org/LimitedAvailability', 'available'],
  ])('maps %s → %s', (value, expected) => {
    expect(structuredProduct(ld({ '@type': 'Product', offers: [{ availability: value }] })).availability).toBe(expected)
  })

  it('finds the Product inside @graph and skips malformed blocks', () => {
    const html =
      '<script type="application/ld+json">{ not json</script>' +
      ld({ '@graph': [{ '@type': 'BreadcrumbList' }, { '@type': 'Product', offers: { availability: 'SoldOut' } }] })
    expect(structuredProduct(html).availability).toBe('sold')
  })

  it('falls back to microdata', () => {
    expect(structuredProduct('<link itemprop="availability" href="https://schema.org/InStock" />').availability).toBe('available')
    expect(structuredProduct('<meta content="https://schema.org/OutOfStock" itemprop="availability">').availability).toBe('sold')
  })

  it('says nothing when the page publishes nothing', () => {
    expect(structuredProduct('<html><body>no data</body></html>')).toEqual({ availability: undefined, price: undefined, imageUrl: undefined })
    expect(structuredProduct(undefined)).toEqual({})
  })
})
