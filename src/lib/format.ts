/** Small display helpers shared by the hunt pages. */

const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' })
const STEPS: Array<[Intl.RelativeTimeFormatUnit, number]> = [
  ['year', 365 * 24 * 3600],
  ['month', 30 * 24 * 3600],
  ['week', 7 * 24 * 3600],
  ['day', 24 * 3600],
  ['hour', 3600],
  ['minute', 60],
]

/** "3 minutes ago", "yesterday" — or '' for a missing/invalid timestamp. */
export function timeAgo(iso: string | undefined, now: number = Date.now()): string {
  const t = iso ? Date.parse(iso) : NaN
  if (Number.isNaN(t)) return ''
  const secs = Math.round((t - now) / 1000)
  for (const [unit, size] of STEPS) {
    if (Math.abs(secs) >= size) return rtf.format(Math.round(secs / size), unit)
  }
  return 'just now'
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`
}
