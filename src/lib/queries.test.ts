import { describe, expect, it } from 'vitest'
import { FUNNEL } from '../config'
import { buildQueries } from './queries'

const junya = { designer: 'Junya Watanabe', piece: 'patchwork denim jacket', season: 'SS02' }

describe('buildQueries', () => {
  it('pins the exact plan for a known designer with a season', () => {
    expect(buildQueries(junya).map((q) => q.query)).toEqual([
      // tier 1 — season-specific, alternating EN / JA markets
      'Junya Watanabe patchwork denim jacket SS02 site:grailed.com',
      'ジュンヤワタナベ パッチワーク デニムジャケット 02SS site:jp.mercari.com',
      'ジュンヤワタナベ パッチワーク デニムジャケット 02SS site:auctions.yahoo.co.jp',
      'Junya Watanabe patchwork denim jacket SS02 site:ebay.com',
      'ジュンヤワタナベ パッチワーク デニムジャケット 02SS site:item.fril.jp',
      'ジュンヤワタナベ パッチワーク デニムジャケット 02SS site:2ndstreet.jp',
      // tier 2 — broad
      'Junya Watanabe patchwork denim jacket site:grailed.com',
      'ジュンヤワタナベ パッチワーク デニムジャケット site:jp.mercari.com',
      'ジュンヤワタナベ パッチワーク デニムジャケット site:auctions.yahoo.co.jp',
      'Junya Watanabe patchwork denim jacket site:ebay.com',
      'ジュンヤワタナベ パッチワーク デニムジャケット site:item.fril.jp',
      'ジュンヤワタナベ パッチワーク デニムジャケット site:2ndstreet.jp',
    ])
  })

  it('adds AD production-code queries for Comme des Garçons–family labels when the cap allows', () => {
    const plan = buildQueries(junya, 20)
    expect(plan.slice(-2).map((q) => q.terms)).toEqual([
      'ジュンヤワタナベ パッチワーク デニムジャケット AD2001',
      'ジュンヤワタナベ パッチワーク デニムジャケット AD2001',
    ])
    expect(plan.slice(-2).map((q) => q.marketplace)).toEqual(['mercari', 'yahoo-auctions'])
  })

  it('never exceeds the cap and never repeats a query', () => {
    for (const limit of [0, 1, 5, FUNNEL.maxQueries, 50]) {
      const plan = buildQueries(junya, limit)
      expect(plan.length).toBeLessThanOrEqual(limit)
      expect(new Set(plan.map((q) => q.query)).size).toBe(plan.length)
    }
  })

  it('keeps both languages represented under a tight cap', () => {
    const markets = buildQueries(junya, 3).map((q) => q.marketplace)
    expect(markets).toEqual(['grailed', 'mercari', 'yahoo-auctions'])
  })

  it('skips the season tier when there is no season', () => {
    const plan = buildQueries({ designer: 'Undercover', piece: 'bomber' })
    expect(plan).toHaveLength(6)
    expect(plan[1].terms).toBe('アンダーカバー ボンバージャケット')
  })

  it('searches Japanese markets with the romanized name for unknown designers', () => {
    const plan = buildQueries({ designer: 'Some Small Label', piece: 'coat' })
    expect(plan.find((q) => q.marketplace === 'mercari')?.terms).toBe('Some Small Label コート')
  })

  it('keeps an untranslatable piece in English rather than dropping it', () => {
    const plan = buildQueries({ designer: 'Kapital', piece: 'boro kountry' })
    expect(plan.find((q) => q.marketplace === 'mercari')?.terms).toBe('キャピタル boro kountry')
  })
})
