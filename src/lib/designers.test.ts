import { describe, expect, it } from 'vitest'
import { designerForms, garmentJa, resolveDesigner, sizeAliases } from './designers'
import { fold } from './text'

describe('fold', () => {
  it('treats accents, width and punctuation as noise', () => {
    expect(fold('Comme des Garçons')).toBe('comme des garcons')
    expect(fold('ＣＯＭＭＥ　ｄｅｓ　ＧＡＲＣＯＮＳ')).toBe('comme des garcons')
    expect(fold('comme-des-garcons')).toBe('comme des garcons')
  })

  it('keeps katakana intact (no dakuten split) and joins half-width kana', () => {
    expect(fold('ギャルソン')).toBe('ギャルソン')
    expect(fold('ﾌﾞﾙｿﾞﾝ')).toBe('ブルゾン')
  })
})

describe('resolveDesigner', () => {
  it.each([
    ['junya watanabe', 'Junya Watanabe'],
    ['JUNYA WATANABE MAN', 'Junya Watanabe MAN'],
    ['Junya Watanabe Comme des Garçons', 'Junya Watanabe'],
    ['ジュンヤワタナベ', 'Junya Watanabe'],
    ['comme des garcons homme plus', 'Comme des Garçons Homme Plus'],
    ['cdg', 'Comme des Garçons'],
    ['Number (N)ine', 'Number (N)ine'],
    ['martin margiela', 'Maison Margiela'],
  ])('%s → %s', (input, name) => {
    expect(resolveDesigner(input)?.name).toBe(name)
  })

  it('returns null for an unknown label instead of guessing', () => {
    expect(resolveDesigner('Some Small Label')).toBeNull()
    expect(resolveDesigner('')).toBeNull()
  })

  it('never uses tiny shorthands as match evidence', () => {
    const forms = designerForms('undercover')
    expect(forms).toContain('undercover')
    expect(forms).toContain('アンダーカバー')
    expect(forms).not.toContain('uc')
  })

  it('falls back to the raw input for unknown designers', () => {
    expect(designerForms('Some Small Label')).toEqual(['some small label'])
  })
})

describe('garmentJa', () => {
  it('prefers the most specific garment', () => {
    expect(garmentJa('leather jacket')?.[0]).toBe('レザージャケット')
    expect(garmentJa('patchwork denim jacket')?.[0]).toBe('デニムジャケット')
    expect(garmentJa('jacket')?.[0]).toBe('ジャケット')
  })

  it('does not match inside other words', () => {
    expect(garmentJa('teething ring')).toBeNull()
  })
})

describe('sizeAliases', () => {
  it('maps letter sizes to Japanese numeric and Italian sizes', () => {
    expect(sizeAliases('M')).toEqual(['m', '2', '48'])
    expect(sizeAliases('3')).toEqual(['l', '3', '50'])
    expect(sizeAliases('46')).toEqual(['s', '1', '46'])
  })

  it('passes through anything it does not know', () => {
    expect(sizeAliases('W32')).toEqual(['w32'])
    expect(sizeAliases('')).toEqual([])
    expect(sizeAliases(undefined)).toEqual([])
  })
})
