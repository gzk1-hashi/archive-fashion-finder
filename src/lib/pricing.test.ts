import { describe, expect, it } from 'vitest'
import { FX, PROXY_COSTS_JPY, US_SHIPPING_USD } from '../config'
import { landedCost, parsePrice, toUsd, withinBudget } from './pricing'

describe('parsePrice', () => {
  it.each([
    ['¥38,000', { amount: 38000, currency: 'JPY', text: '¥38,000' }],
    ['￥38000 送料込み', { amount: 38000, currency: 'JPY', text: '¥38000' }], // full-width yen
    ['38,000円', { amount: 38000, currency: 'JPY', text: '38,000円' }],
    ['３８０００円', { amount: 38000, currency: 'JPY', text: '38000円' }], // full-width digits
    ['即決 3.8万円', { amount: 38000, currency: 'JPY', text: '3.8万円' }],
    ['$450', { amount: 450, currency: 'USD', text: '$450' }],
    ['US $1,250.00 or best offer', { amount: 1250, currency: 'USD', text: 'US $1,250.00' }],
    ['Price: 450 USD', { amount: 450, currency: 'USD', text: '450 USD' }],
  ])('%s', (text, expected) => {
    expect(parsePrice(text)).toEqual(expected)
  })

  it('skips the original retail price (定価) and reads the asking price', () => {
    expect(parsePrice('定価¥120,000 → ¥38,000で出品')?.amount).toBe(38000)
    expect(parsePrice('retail $1,200, asking $450')?.amount).toBe(450)
  })

  it('ignores numbers that are not plausible prices', () => {
    expect(parsePrice('size 2 / 2002SS')).toBeNull()
    expect(parsePrice('¥10')).toBeNull()
    expect(parsePrice(undefined)).toBeNull()
  })
})

describe('landedCost', () => {
  it('adds proxy fee and both shipping legs to Japanese marketplaces', () => {
    const extras = PROXY_COSTS_JPY.serviceFee + PROXY_COSTS_JPY.domesticShipping + PROXY_COSTS_JPY.internationalShipping
    const c = landedCost({ amount: 38000, currency: 'JPY' }, 'mercari')
    expect(c.priceUsd).toBe(Math.round(38000 / FX.jpyPerUsd))
    expect(c.landedUsd).toBe(Math.round((38000 + extras) / FX.jpyPerUsd))
    expect(c.parts[1]).toMatch(/^proxy \+ shipping/)
  })

  it('adds flat domestic shipping to US marketplaces', () => {
    expect(landedCost({ amount: 450, currency: 'USD' }, 'grailed').landedUsd).toBe(450 + US_SHIPPING_USD)
  })

  it('converts JPY with the dated rate', () => {
    expect(toUsd({ amount: FX.jpyPerUsd * 100, currency: 'JPY' })).toBeCloseTo(100)
  })
})

describe('withinBudget', () => {
  it('allows the configured slack and no more', () => {
    expect(withinBudget(330, 300)).toBe(true)
    expect(withinBudget(331, 300)).toBe(false)
  })

  it('never rejects on unknowns', () => {
    expect(withinBudget(undefined, 300)).toBe(true)
    expect(withinBudget(9999, undefined)).toBe(true)
    expect(withinBudget(9999, 0)).toBe(true)
  })
})
