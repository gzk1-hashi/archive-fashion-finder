/**
 * The archive-fashion vocabulary the search needs and a general-purpose model
 * doesn't reliably have: how each label is written on Japanese resale sites,
 * which lines belong to which house, and how garments are named in Japanese.
 *
 * Japanese listings almost never use the romanized name in the title — a
 * Junya Watanabe jacket on Mercari is "ジュンヤワタナベ コムデギャルソン
 * ジャケット". Searching in English only finds the slice of the market that
 * already got exported.
 */

import { compact, fold } from './text'

export interface Designer {
  /** Canonical display name. */
  name: string
  /** Romanized spellings people actually type (folded on comparison). */
  aliases: string[]
  /** Katakana (or kanji) form used by Japanese listings, most common first. */
  ja: string[]
  /**
   * Comme des Garçons–family garments carry an "AD" + year production code on
   * the care tag (AD2003 = made in 2003). Japanese sellers quote it in titles
   * because it's the fastest way to date a piece.
   */
  adCode?: boolean
}

export const DESIGNERS: Designer[] = [
  { name: 'Comme des Garçons', aliases: ['comme des garcons', 'cdg', 'comme'], ja: ['コムデギャルソン', 'コム・デ・ギャルソン'], adCode: true },
  { name: 'Comme des Garçons Homme Plus', aliases: ['cdg homme plus', 'homme plus'], ja: ['コムデギャルソンオムプリュス'], adCode: true },
  { name: 'Comme des Garçons Homme', aliases: ['cdg homme'], ja: ['コムデギャルソンオム'], adCode: true },
  { name: 'Junya Watanabe', aliases: ['junya watanabe', 'junya watanabe comme des garcons', 'junya', 'jw'], ja: ['ジュンヤワタナベ', 'ジュンヤワタナベ コムデギャルソン'], adCode: true },
  { name: 'Junya Watanabe MAN', aliases: ['junya watanabe man', 'junya man', 'jwm'], ja: ['ジュンヤワタナベマン'], adCode: true },
  { name: 'Yohji Yamamoto', aliases: ['yohji yamamoto', 'yohji', 'yy'], ja: ['ヨウジヤマモト'] },
  { name: 'Yohji Yamamoto Pour Homme', aliases: ['yohji yamamoto pour homme', 'yohji pour homme', 'yyph'], ja: ['ヨウジヤマモトプールオム'] },
  { name: "Y's", aliases: ["y's", 'ys yohji'], ja: ['ワイズ'] },
  { name: 'Issey Miyake', aliases: ['issey miyake', 'issey'], ja: ['イッセイミヤケ'] },
  { name: 'Homme Plissé Issey Miyake', aliases: ['homme plisse', 'homme plisse issey miyake'], ja: ['オムプリッセ', 'オムプリッセ イッセイミヤケ'] },
  { name: 'Undercover', aliases: ['undercover', 'uc', 'jun takahashi'], ja: ['アンダーカバー'] },
  { name: 'Number (N)ine', aliases: ['number nine', 'number (n)ine', 'numbernine', 'n(n)'], ja: ['ナンバーナイン'] },
  { name: 'Hysteric Glamour', aliases: ['hysteric glamour', 'hysteric'], ja: ['ヒステリックグラマー'] },
  { name: 'Kapital', aliases: ['kapital'], ja: ['キャピタル'] },
  { name: 'Visvim', aliases: ['visvim'], ja: ['ビズビム', 'ヴィスヴィム'] },
  { name: 'Neighborhood', aliases: ['neighborhood', 'nbhd'], ja: ['ネイバーフッド'] },
  { name: 'Sacai', aliases: ['sacai'], ja: ['サカイ'] },
  { name: 'The Soloist', aliases: ['the soloist', 'soloist', 'takahiromiyashita the soloist'], ja: ['ソロイスト', 'タカヒロミヤシタザソロイスト'] },
  { name: 'Mihara Yasuhiro', aliases: ['mihara yasuhiro', 'maison mihara yasuhiro', 'mihara'], ja: ['ミハラヤスヒロ'] },
  { name: 'Kansai Yamamoto', aliases: ['kansai yamamoto', 'kansai'], ja: ['山本寛斎', 'カンサイヤマモト'] },
  { name: 'Lad Musician', aliases: ['lad musician'], ja: ['ラッドミュージシャン'] },
  { name: 'A Bathing Ape', aliases: ['a bathing ape', 'bape'], ja: ['アベイシングエイプ'] },
  { name: 'Helmut Lang', aliases: ['helmut lang'], ja: ['ヘルムートラング'] },
  { name: 'Raf Simons', aliases: ['raf simons', 'raf'], ja: ['ラフシモンズ'] },
  { name: 'Maison Margiela', aliases: ['maison margiela', 'martin margiela', 'maison martin margiela', 'margiela', 'mmm'], ja: ['マルタンマルジェラ', 'メゾンマルジェラ'] },
  { name: 'Rick Owens', aliases: ['rick owens', 'rick'], ja: ['リックオウエンス'] },
  { name: 'Dior Homme', aliases: ['dior homme', 'hedi slimane dior'], ja: ['ディオールオム'] },
  { name: 'Jean Paul Gaultier', aliases: ['jean paul gaultier', 'jpg', 'gaultier'], ja: ['ジャンポールゴルチエ', 'ゴルチエ'] },
  { name: 'Vivienne Westwood', aliases: ['vivienne westwood', 'westwood'], ja: ['ヴィヴィアンウエストウッド'] },
  { name: 'Ann Demeulemeester', aliases: ['ann demeulemeester', 'ann d'], ja: ['アンドゥムルメステール'] },
  { name: 'Dries Van Noten', aliases: ['dries van noten', 'dries'], ja: ['ドリスヴァンノッテン'] },
  { name: 'Walter Van Beirendonck', aliases: ['walter van beirendonck', 'wvb'], ja: ['ウォルターヴァンベイレンドンク'] },
  { name: 'Jil Sander', aliases: ['jil sander'], ja: ['ジルサンダー'] },
  { name: 'Prada', aliases: ['prada', 'prada sport', 'prada linea rossa'], ja: ['プラダ'] },
  { name: 'Stone Island', aliases: ['stone island'], ja: ['ストーンアイランド'] },
  { name: 'C.P. Company', aliases: ['cp company', 'c p company', 'c.p. company'], ja: ['シーピーカンパニー'] },
  { name: 'Chrome Hearts', aliases: ['chrome hearts'], ja: ['クロムハーツ'] },
  { name: 'Carol Christian Poell', aliases: ['carol christian poell', 'ccp'], ja: ['キャロルクリスチャンポエル'] },
]

/**
 * Resolve free-text designer input to a dictionary entry. Exact alias match
 * wins; otherwise the longest alias contained in the input (so "junya watanabe
 * man" resolves to MAN, not mainline). Unknown designers return null and the
 * search simply runs in English — the dictionary sharpens the hunt, it never
 * gates it.
 */
export function resolveDesigner(input: string): Designer | null {
  const needle = compact(input)
  if (!needle) return null
  let best: { designer: Designer; len: number } | null = null
  for (const designer of DESIGNERS) {
    const forms = [designer.name, ...designer.aliases, ...designer.ja].map(compact)
    if (forms.includes(needle)) return designer
    for (const form of forms) {
      if (form.length >= 4 && needle.includes(form) && (!best || form.length > best.len)) {
        best = { designer, len: form.length }
      }
    }
  }
  return best?.designer ?? null
}

/** Every folded form a listing might use for this designer (romanized + Japanese). */
export function designerForms(input: string): string[] {
  const d = resolveDesigner(input)
  const forms = d ? [d.name, ...d.aliases, ...d.ja] : [input]
  // Very short aliases ("jw", "uc", "cdg") are search shorthands, not proof:
  // "uc" appears inside plenty of unrelated words. Keep them out of matching.
  return forms.map(fold).filter((f) => f.replace(/ /g, '').length >= 4 || /[^\x00-\x7f]/.test(f))
}

// ─── Garments ────────────────────────────────────────────────────────────────

/**
 * English garment word → how Japanese listings name it. Longest English key
 * wins ("leather jacket" before "jacket"), and the first Japanese term is the
 * one the query uses.
 */
export const GARMENTS: Array<[en: string, ja: string[]]> = [
  ['leather jacket', ['レザージャケット', 'ライダース']],
  ['bomber jacket', ['ボンバージャケット', 'MA-1']],
  ['bomber', ['ボンバージャケット', 'MA-1']],
  ['denim jacket', ['デニムジャケット', 'Gジャン']],
  ['trench coat', ['トレンチコート']],
  ['blazer', ['テーラードジャケット', 'ブレザー']],
  ['jacket', ['ジャケット', 'ブルゾン']],
  ['coat', ['コート']],
  ['parka', ['パーカー']],
  ['hoodie', ['パーカー', 'フーディー']],
  ['cardigan', ['カーディガン']],
  ['sweater', ['ニット', 'セーター']],
  ['knit', ['ニット']],
  ['vest', ['ベスト']],
  ['t-shirt', ['Tシャツ']],
  ['tee', ['Tシャツ']],
  ['shirt', ['シャツ']],
  ['cargo pants', ['カーゴパンツ']],
  ['jeans', ['デニムパンツ', 'ジーンズ']],
  ['denim', ['デニム']],
  ['trousers', ['スラックス', 'パンツ']],
  ['pants', ['パンツ']],
  ['shorts', ['ショートパンツ', 'ハーフパンツ']],
  ['skirt', ['スカート']],
  ['dress', ['ワンピース']],
  ['boots', ['ブーツ']],
  ['sneakers', ['スニーカー']],
  ['bag', ['バッグ']],
]

/** Japanese term for the garment named somewhere in `piece`, or null. */
export function garmentJa(piece: string): string[] | null {
  const p = ` ${fold(piece)} `
  let best: [string, string[]] | null = null
  for (const [en, ja] of GARMENTS) {
    if (p.includes(` ${fold(en)} `) && (!best || en.length > best[0].length)) best = [en, ja]
  }
  return best ? best[1] : null
}

// ─── Sizes ───────────────────────────────────────────────────────────────────

/**
 * Letter size → the numeric labels Japanese houses and Italian-sized European
 * houses print instead. Undercover, Number (N)ine and Yohji run 1–4/5;
 * Margiela, Raf and Dior Homme use 44–52. These are equivalences a buyer
 * reasons with, not a fit guarantee — they inform scoring, never a hard filter.
 */
const SIZE_EQUIV: Record<string, string[]> = {
  xs: ['xs', '0', '44'],
  s: ['s', '1', '46'],
  m: ['m', '2', '48'],
  l: ['l', '3', '50'],
  xl: ['xl', '4', '52'],
  xxl: ['xxl', '5', '54'],
}

/** Size labels equivalent to the user's size input (always includes the input). */
export function sizeAliases(size: string | undefined): string[] {
  const s = fold(size ?? '')
  if (!s) return []
  for (const group of Object.values(SIZE_EQUIV)) {
    if (group.includes(s)) return group
  }
  return [s]
}
