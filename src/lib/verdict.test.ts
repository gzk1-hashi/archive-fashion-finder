import { describe, expect, it } from 'vitest'
import { FUNNEL } from '../config'
import { buildUserPrompt, toBoardVerdict, VerdictSchema, type Verdict } from './verdict'

const v = (over: Partial<Verdict>): Verdict => ({ score: 80, verdict: 'exact', reasons: [], redFlags: [], ...over })

describe('VerdictSchema', () => {
  it('accepts a well-formed answer', () => {
    expect(VerdictSchema.safeParse(v({})).success).toBe(true)
  })

  it.each([
    ['score above 100', { score: 101 }],
    ['fractional score', { score: 72.5 }],
    ['unknown verdict', { verdict: 'maybe' }],
    ['too many reasons', { reasons: ['a', 'b', 'c', 'd', 'e'] }],
    ['overlong reason', { reasons: ['x'.repeat(141)] }],
  ])('rejects %s', (_, patch) => {
    expect(VerdictSchema.safeParse({ ...v({}), ...patch }).success).toBe(false)
  })
})

describe('toBoardVerdict', () => {
  it('uses our threshold, not the model’s enthusiasm', () => {
    expect(toBoardVerdict(v({ score: FUNNEL.matchThreshold }))).toBe('exact')
    expect(toBoardVerdict(v({ score: FUNNEL.matchThreshold - 1 }))).toBeNull()
  })

  it('never boards a "no", whatever the score says', () => {
    expect(toBoardVerdict(v({ score: 95, verdict: 'no' }))).toBeNull()
  })
})

describe('buildUserPrompt', () => {
  it('lays out the hunt and the listing with stable labels', () => {
    const prompt = buildUserPrompt(
      { designer: 'Junya Watanabe', piece: 'patchwork denim jacket', season: 'SS02', maxPriceUsd: 400 },
      {
        title: 'ジュンヤワタナベ 02SS パッチワーク',
        snippet: '¥38,000',
        marketplace: 'mercari',
        signals: ['states season SS02'],
        priceText: '¥38,000',
      },
    )
    expect(prompt).toBe(
      [
        'HUNTING',
        'Designer: Junya Watanabe',
        'Piece: patchwork denim jacket',
        'Season: SS02',
        'Budget: up to $400 landed',
        '',
        'LISTING',
        'Marketplace: Mercari JP',
        'Title: ジュンヤワタナベ 02SS パッチワーク',
        'Snippet: ¥38,000',
        'Price as listed: ¥38,000',
        'Pre-check notes: states season SS02',
      ].join('\n'),
    )
  })
})
