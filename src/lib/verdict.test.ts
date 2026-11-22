import { describe, expect, it } from 'vitest'
import { FUNNEL } from '../config'
import { buildUserPrompt, normalizeVerdict, toBoardVerdict, VerdictSchema, type Verdict } from './verdict'

const v = (over: Partial<Verdict>): Verdict => ({ score: 80, verdict: 'exact', reasons: [], redFlags: [], appearsSold: false, ...over })

describe('VerdictSchema', () => {
  it('accepts a well-formed answer', () => {
    expect(VerdictSchema.safeParse(v({})).success).toBe(true)
  })

  it('rejects a verdict outside the enum and a missing field', () => {
    expect(VerdictSchema.safeParse({ ...v({}), verdict: 'maybe' }).success).toBe(false)
    expect(VerdictSchema.safeParse({ score: 80, verdict: 'exact', reasons: [], redFlags: [] }).success).toBe(false)
  })

  it('carries no hard limits a provider might silently ignore (normalizeVerdict enforces them)', () => {
    expect(VerdictSchema.safeParse({ ...v({}), score: 101, reasons: ['x'.repeat(500)] }).success).toBe(true)
  })
})

describe('normalizeVerdict', () => {
  it('clamps and rounds the score', () => {
    expect(normalizeVerdict(v({ score: 101 })).score).toBe(100)
    expect(normalizeVerdict(v({ score: -3 })).score).toBe(0)
    expect(normalizeVerdict(v({ score: 72.5 })).score).toBe(73)
    expect(normalizeVerdict(v({ score: Number.NaN })).score).toBe(0)
  })

  it('caps list length and string length, and drops blanks', () => {
    const n = normalizeVerdict(v({ reasons: ['a', ' ', 'b', 'c', 'd', 'e'], redFlags: ['x'.repeat(300)] }))
    expect(n.reasons).toEqual(['a', 'b', 'c', 'd'])
    expect(n.redFlags[0]).toHaveLength(140)
    expect(n.redFlags[0].endsWith('…')).toBe(true)
  })

  it('leaves a well-formed verdict unchanged', () => {
    const ok = v({ score: 64, verdict: 'likely', reasons: ['title says 02SS'], redFlags: [] })
    expect(normalizeVerdict(ok)).toEqual(ok)
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

  it('never boards anything the model reads as sold', () => {
    expect(toBoardVerdict(v({ score: 95, verdict: 'exact', appearsSold: true }))).toBeNull()
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
