import { describe, expect, it } from 'vitest'
import { fieldErrors, HuntInput } from './hunt-input'

const base = { designer: 'Junya Watanabe', piece: 'patchwork denim jacket', season: '', size: '', maxPriceUsd: '' }

describe('HuntInput', () => {
  it('normalizes the season to one canonical code', () => {
    expect(HuntInput.parse({ ...base, season: '2002 S/S' }).season).toBe('SS02')
    expect(HuntInput.parse({ ...base, season: 'fw03' }).season).toBe('AW03')
  })

  it('accepts a budget written like a person writes it', () => {
    expect(HuntInput.parse({ ...base, maxPriceUsd: '$1,200' }).maxPriceUsd).toBe(1200)
    expect(HuntInput.parse({ ...base, maxPriceUsd: '' }).maxPriceUsd).toBeUndefined()
  })

  it('explains what is wrong, per field', () => {
    const r = HuntInput.safeParse({ ...base, designer: ' ', season: 'vintage', maxPriceUsd: '12.50' })
    expect(r.success).toBe(false)
    if (r.success) return
    const errs = fieldErrors(r.error)
    expect(errs.designer).toMatch(/designer/i)
    expect(errs.season).toMatch(/SS02/)
    expect(errs.maxPriceUsd).toMatch(/whole dollars/i)
  })

  it('trims and caps lengths to the schema maxLength', () => {
    expect(HuntInput.parse({ ...base, size: '  M  ' }).size).toBe('M')
    expect(HuntInput.safeParse({ ...base, designer: 'x'.repeat(81) }).success).toBe(false)
  })
})
