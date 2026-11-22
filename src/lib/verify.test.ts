import { describe, expect, it } from 'vitest'
import type { Candidate } from './filter'
import { verifyCandidate } from './verify'

const hunt = { designer: 'Junya Watanabe MAN', piece: 'mountain parka', season: 'AW05', maxPriceUsd: 500 }

const candidate = (over: Partial<Candidate> = {}): Candidate => ({
  url: 'https://jp.mercari.com/item/m1',
  marketplace: 'mercari',
  title: 'ジュンヤワタナベマン 05AW マウンテンパーカー',
  snippet: '',
  price: null,
  cost: null,
  relevance: 5,
  signals: ['states season AW05', 'price not visible in snippet'],
  ...over,
})

describe('verifyCandidate', () => {
  it('rejects a listing whose page says sold, or that no longer exists', () => {
    expect(verifyCandidate(candidate(), { markdown: '売り切れました' }, hunt)).toMatchObject({ kind: 'sold' })
    expect(verifyCandidate(candidate(), { markdown: '', statusCode: 404 }, hunt)).toMatchObject({ kind: 'sold' })
  })

  it('lets any sold evidence beat a declared "in stock"', () => {
    expect(verifyCandidate(candidate(), { markdown: '売り切れました', declaredAvailability: 'available' }, hunt)).toMatchObject({ kind: 'sold' })
    expect(verifyCandidate(candidate(), { markdown: '購入手続きへ', declaredAvailability: 'sold' }, hunt)).toMatchObject({ kind: 'sold' })
    expect(verifyCandidate(candidate(), { markdown: '# no buttons', declaredAvailability: 'available' }, hunt)).toMatchObject({ kind: 'available' })
  })

  it('keeps "unknown" distinct, so the board can refuse what it cannot prove', () => {
    expect(verifyCandidate(candidate(), { markdown: '# some page' }, hunt)).toEqual({ kind: 'unknown' })
  })

  it('adds the photo and the real price, and swaps the snippet price note for the landed cost', () => {
    const r = verifyCandidate(
      candidate(),
      { markdown: '¥38,000\n購入手続きへ', imageUrl: 'https://static.mercdn.net/x.jpg', price: { amount: 38000, currency: 'JPY', text: '¥38,000' } },
      hunt,
    )
    expect(r.kind).toBe('available')
    if (r.kind !== 'available') return
    expect(r.candidate.imageUrl).toBe('https://static.mercdn.net/x.jpg')
    expect(r.candidate.price?.text).toBe('¥38,000')
    expect(r.candidate.cost?.landedUsd).toBeGreaterThan(238)
    expect(r.candidate.signals).toContain('listing page shows it is for sale')
    expect(r.candidate.signals.some((s) => s.startsWith('price not visible in snippet'))).toBe(false)
    expect(r.candidate.signals).toContain('states season AW05')
  })

  it('falls back to the price at the top of the page', () => {
    const r = verifyCandidate(candidate(), { markdown: '# パーカー\n¥52,000\n購入手続きへ' }, hunt)
    expect(r.kind === 'available' && r.candidate.price?.amount).toBe(52000)
  })

  it('re-checks the budget once the real price is known', () => {
    const r = verifyCandidate(candidate(), { markdown: '購入手続きへ', price: { amount: 150000, currency: 'JPY', text: '¥150,000' } }, hunt)
    expect(r).toMatchObject({ kind: 'over-budget' })
  })
})
