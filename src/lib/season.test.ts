import { describe, expect, it } from 'vitest'
import { adCodes, mentionsOtherSeason, mentionsSeason, parseSeason, seasonCodesIn, seasonVariantsEn, seasonVariantsJa } from './season'

describe('parseSeason', () => {
  it.each([
    ['SS02', { half: 'SS', year: 2002 }],
    ['ss02', { half: 'SS', year: 2002 }],
    ['S/S 2002', { half: 'SS', year: 2002 }],
    ['02SS', { half: 'SS', year: 2002 }],
    ['2002SS', { half: 'SS', year: 2002 }],
    ['2002 S/S', { half: 'SS', year: 2002 }],
    ['Spring/Summer 2002', { half: 'SS', year: 2002 }],
    ['spring summer 02', { half: 'SS', year: 2002 }],
    ['2002春夏', { half: 'SS', year: 2002 }],
    ['ＳＳ０２', { half: 'SS', year: 2002 }], // full-width
    ['AW03', { half: 'AW', year: 2003 }],
    ['FW03', { half: 'AW', year: 2003 }],
    ['F/W 2003', { half: 'AW', year: 2003 }],
    ['03AW', { half: 'AW', year: 2003 }],
    ['AW03-04', { half: 'AW', year: 2003 }],
    ['2003-04AW', { half: 'AW', year: 2003 }],
    ['Autumn/Winter 2003', { half: 'AW', year: 2003 }],
    ['2003秋冬', { half: 'AW', year: 2003 }],
    ['AW98', { half: 'AW', year: 1998 }],
    ['SS18', { half: 'SS', year: 2018 }],
  ])('%s', (input, expected) => {
    expect(parseSeason(input)).toEqual(expected)
  })

  it.each(['', '   ', 'vintage', '2002', 'size 2', undefined])('returns null for %j', (input) => {
    expect(parseSeason(input)).toBeNull()
  })
})

describe('variants', () => {
  it('writes the season the way each market does', () => {
    const s = { half: 'SS', year: 2002 } as const
    expect(seasonVariantsEn(s)[0]).toBe('SS02')
    expect(seasonVariantsJa(s)).toEqual(['02SS', '2002SS', '2002春夏'])
  })

  it('maps SS to the previous production year for AD codes', () => {
    expect(adCodes({ half: 'SS', year: 2003 })).toEqual(['AD2002', 'AD2003'])
    expect(adCodes({ half: 'AW', year: 2003 })).toEqual(['AD2003'])
  })
})

describe('mentions', () => {
  const ss02 = { half: 'SS', year: 2002 } as const

  it('finds the season in any spelling', () => {
    expect(mentionsSeason('JUNYA WATANABE 02SS パッチワーク', ss02)).toBe(true)
    expect(mentionsSeason('Junya Watanabe S/S 2002 jacket', ss02)).toBe(true)
    expect(mentionsSeason('ジュンヤワタナベ 2002春夏', ss02)).toBe(true)
    expect(mentionsSeason('Junya jacket', ss02)).toBe(false)
  })

  it('reads codes without mistaking words for them', () => {
    expect(seasonCodesIn('class01 boss2002x')).toEqual([])
    expect(seasonCodesIn('ジュンヤ03AWジャケット')).toEqual([{ half: 'AW', year: 2003 }])
  })

  it('flags a different code, but not silence', () => {
    expect(mentionsOtherSeason('Junya SS03 jacket', ss02)).toBe(true)
    expect(mentionsOtherSeason('Junya SS02 jacket', ss02)).toBe(false)
    expect(mentionsOtherSeason('Junya jacket', ss02)).toBe(false)
  })
})
