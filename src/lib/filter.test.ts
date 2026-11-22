import { describe, expect, it } from 'vitest'
import { prefilter, redFlagIn } from './filter'
import type { Listing } from './listings'

const hunt = { designer: 'Junya Watanabe', piece: 'patchwork denim jacket', season: 'SS02', size: 'M', maxPriceUsd: 400 }

const listing = (url: string, title: string, snippet = '', marketplace: Listing['marketplace'] = 'grailed'): Listing => ({
  url,
  title,
  snippet,
  marketplace,
})

describe('redFlagIn', () => {
  it.each([
    'Junya Watanabe REPLICA patchwork',
    'CDG inspired jacket',
    'Margiela-style tabi',
    'ギャルソン風 ジャケット',
    'ジュンヤ レプリカ',
    'ノーブランド デニム',
  ])('flags %s', (text) => {
    expect(redFlagIn(text)).not.toBeNull()
  })

  it.each([
    'ジュンヤワタナベ デニム 風合い良し', // 風合い = hand-feel, appears in genuine listings
    'Junya Watanabe patchwork jacket style no. JN-J001',
    'Junya Watanabe SS02 patchwork',
  ])('does not flag %s', (text) => {
    expect(redFlagIn(text)).toBeNull()
  })
})

describe('prefilter', () => {
  const listings: Listing[] = [
    listing('https://grailed.com/listings/1', 'Junya Watanabe denim jacket', '$300'),
    listing('https://grailed.com/listings/2', 'Junya Watanabe SS02 patchwork denim jacket size M', '$380'),
    listing('https://grailed.com/listings/3', 'Junya Watanabe replica patchwork', '$90'),
    listing('https://grailed.com/listings/4', 'Junya Watanabe patchwork jacket', '$2,400'),
    listing('https://grailed.com/listings/5', 'Kapital patchwork denim jacket', '$300'),
    listing('https://jp.mercari.com/item/m6', 'ジュンヤワタナベ 02SS パッチワーク デニムジャケット', '¥38,000', 'mercari'),
    listing('https://grailed.com/listings/7', 'Junya Watanabe SS03 denim jacket', '$300'),
    listing('https://grailed.com/listings/8', 'already seen', ''),
  ]
  const seen = new Set(['https://grailed.com/listings/8'])

  it('rejects for free, with a reason the job can store', () => {
    const { rejected } = prefilter(listings, hunt, seen)
    expect(rejected.map((r) => [r.listing.url.split('/').pop(), r.outcome])).toEqual([
      ['3', 'red-flag'],
      ['4', 'over-budget'],
      ['5', 'off-target'],
    ])
  })

  it('ranks season + size + garment matches first and drops seen URLs silently', () => {
    const { toScore } = prefilter(listings, hunt, seen)
    const ids = toScore.map((c) => c.url.split('/').pop())
    expect(ids[0]).toBe('2')
    expect(ids).toContain('m6')
    expect(ids).not.toContain('8')
    // A different season code is allowed through but ranked last.
    expect(ids.at(-1)).toBe('7')
  })

  it('judges Japanese listings on landed cost, not item price', () => {
    const { toScore } = prefilter(listings, hunt, seen)
    const jp = toScore.find((c) => c.marketplace === 'mercari')
    expect(jp?.cost?.landedUsd).toBeGreaterThan(jp?.cost?.priceUsd ?? Infinity)
    expect(jp?.signals.join(' ')).toMatch(/landed cost/)
  })

  it('caps model work and reports what it deferred', () => {
    const result = prefilter(listings, hunt, seen, 2)
    expect(result.toScore).toHaveLength(2)
    expect(result.deferred).toBe(2)
  })
})
