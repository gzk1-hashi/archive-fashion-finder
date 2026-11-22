import { describe, expect, it } from 'vitest'
import { availabilityFromPage, soldInText } from './availability'

describe('soldInText (free check on the search snippet)', () => {
  it.each([
    'JUNYA WATANABE MAN 05AW パーカー 売り切れ',
    'ジュンヤ ジャケット 売切れ',
    'Junya Watanabe jacket - SOLD OUT',
    'This listing has ended. Junya Watanabe parka',
    'このオークションは終了しています',
    'メルカリ 取引中 ジュンヤワタナベ',
    'Junya Watanabe MAN AW05 parka · Sold Price $220',
  ])('flags %s', (text) => {
    expect(soldInText(text)).toBe(true)
  })

  it.each([
    'Junya Watanabe MAN 05AW parka, sold as-is, minor wear',
    'Sold by a verified seller',
    'Unsold stock from 2005',
    'ジュンヤワタナベマン 05AW マウンテンパーカー 美品',
  ])('does not flag %s', (text) => {
    expect(soldInText(text)).toBe(false)
  })
})

describe('availabilityFromPage', () => {
  it('reads Mercari: sold beats the (disabled) purchase area', () => {
    expect(availabilityFromPage('# ジュンヤ パーカー\n¥38,000\n売り切れました\n購入手続きへ', 'mercari')).toBe('sold')
    expect(availabilityFromPage('# ジュンヤ パーカー\n¥38,000\n購入手続きへ', 'mercari')).toBe('available')
  })

  it('reads Yahoo! Auctions without mistaking the buy-now button for a sale', () => {
    expect(availabilityFromPage('現在 12,000円\n残り時間 2日\n入札する\n今すぐ落札する', 'yahoo-auctions')).toBe('available')
    expect(availabilityFromPage('このオークションは終了しています\n落札者', 'yahoo-auctions')).toBe('sold')
  })

  it('reads Grailed and eBay', () => {
    expect(availabilityFromPage('Junya Watanabe MAN Parka\n$420\nPurchase\nMake Offer', 'grailed')).toBe('available')
    expect(availabilityFromPage('Junya Watanabe MAN Parka\nSold Price $420', 'grailed')).toBe('sold')
    expect(availabilityFromPage('Junya parka\nThis listing has ended.\nSold for $380', 'ebay')).toBe('sold')
    expect(availabilityFromPage('Junya parka\nUS $380\nBuy It Now\nAdd to cart', 'ebay')).toBe('available')
  })

  it('ignores "sold" in recommendations below the listing', () => {
    const page = `# Junya parka\n$420\nPurchase\n${'x'.repeat(7000)}\nSimilar items: SOLD OUT`
    expect(availabilityFromPage(page, 'grailed')).toBe('available')
  })

  it('says unknown when the page proves neither', () => {
    expect(availabilityFromPage('', 'mercari')).toBe('unknown')
    expect(availabilityFromPage('# Junya parka\nsome description', 'grailed')).toBe('unknown')
  })
})
