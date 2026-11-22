/**
 * Every tunable in one place. Shared by the worker (scan job) and the browser
 * (labels, form limits), so nothing in here may import server-only code.
 *
 * Anything that is a fact about the outside world — an exchange rate, a proxy
 * fee, a model price — carries the date it was checked. Those numbers go stale;
 * the date tells the next reader how stale.
 */

// ─── Marketplaces ────────────────────────────────────────────────────────────

export const MARKETPLACE_IDS = [
  'grailed',
  'ebay',
  'mercari',
  'yahoo-auctions',
  'rakuma',
  '2nd-street',
] as const
export type MarketplaceId = (typeof MARKETPLACE_IDS)[number]

export interface Marketplace {
  label: string
  /** Registrable domain used for `site:` and for mapping a hit back to its source. */
  domain: string
  /** Which query language the marketplace's own listings are written in. */
  lang: 'en' | 'ja'
  /** Currency the listing price is quoted in. */
  currency: 'USD' | 'JPY'
  /** Japanese domestic sites ship abroad only through a proxy (Buyee, ZenMarket…). */
  viaProxy: boolean
  /**
   * Pathname shape of a single listing. Search engines return category and
   * search pages too; anything not matching this is not a listing and is dropped
   * before it costs a model call.
   */
  listingPath: RegExp
}

export const MARKETPLACES: Record<MarketplaceId, Marketplace> = {
  grailed: {
    label: 'Grailed',
    domain: 'grailed.com',
    lang: 'en',
    currency: 'USD',
    viaProxy: false,
    listingPath: /^\/listings\/\d+/,
  },
  ebay: {
    label: 'eBay',
    domain: 'ebay.com',
    lang: 'en',
    currency: 'USD',
    viaProxy: false,
    listingPath: /^\/itm\/(?:[^/]+\/)?\d{9,}/,
  },
  mercari: {
    label: 'Mercari JP',
    domain: 'jp.mercari.com',
    lang: 'ja',
    currency: 'JPY',
    viaProxy: true,
    listingPath: /^\/(?:item|shops\/product)\/[A-Za-z0-9]+/,
  },
  'yahoo-auctions': {
    label: 'Yahoo! Auctions',
    domain: 'auctions.yahoo.co.jp',
    lang: 'ja',
    currency: 'JPY',
    viaProxy: true,
    listingPath: /^\/jp\/auction\/[a-z]?\d+/,
  },
  rakuma: {
    label: 'Rakuma',
    domain: 'item.fril.jp',
    lang: 'ja',
    currency: 'JPY',
    viaProxy: true,
    listingPath: /^\/[0-9a-f]{32}/,
  },
  '2nd-street': {
    label: '2nd Street',
    domain: '2ndstreet.jp',
    lang: 'ja',
    currency: 'JPY',
    viaProxy: true,
    listingPath: /^\/goods\/detail\/goodsId\/\d+/,
  },
}

// ─── Money ───────────────────────────────────────────────────────────────────

/**
 * Fixed conversion rate, not a live feed. The platform has no FX integration,
 * and a scan only needs to be right to a few percent to decide "inside budget
 * or not". USD/JPY traded ~157–160 through mid-November 2026.
 */
export const FX = {
  asOf: '2026-11-20',
  jpyPerUsd: 159.5,
} as const

/**
 * What it actually costs to get a Japanese domestic listing to a US door.
 * Buyee raised its per-order fee from ¥300 to ¥500 on 2026-04-01. Shipping is
 * a mid-weight apparel estimate (one jacket/knit, ~1–1.5 kg boxed); heavy
 * outerwear and boots run higher, which is why the budget check has slack.
 */
export const PROXY_COSTS_JPY = {
  asOf: '2026-11-20',
  serviceFee: 500,
  domesticShipping: 900,
  internationalShipping: 4500,
} as const

/** Flat domestic shipping guess for US marketplaces when the snippet doesn't say. */
export const US_SHIPPING_USD = 15

/**
 * Landed cost may exceed the user's max by this much before the listing is
 * dropped. Estimates are estimates; a $310 landed cost on a $300 budget is
 * worth a look, a $600 one isn't.
 */
export const BUDGET_SLACK = 0.1

// ─── Models ──────────────────────────────────────────────────────────────────

/**
 * Pinned, never "latest". Scoring is a classification task with a strict
 * output schema — the smallest current model is the right tool, and pinning it
 * means a platform default change can't silently 40x the bill.
 */
export const MODELS = {
  scorer: 'claude-haiku-5-5',
} as const

/** USD per million tokens, prompts ≤100K tokens (ours are ~2K). Checked 2026-11-21. */
export const MODEL_PRICING_PER_MTOK: Record<string, { input: number; output: number }> = {
  'claude-haiku-5-5': { input: 0.1, output: 0.5 },
}

/** Bump whenever the scoring prompt changes; stored on every match row. */
export const PROMPT_VERSION = 'v2' // v2: appearsSold field, availability instruction

// ─── Scan funnel ─────────────────────────────────────────────────────────────

export const FUNNEL = {
  /** Search queries per scan (each is one owner-billed firecrawl/search). */
  maxQueries: 12,
  /** Results requested per query. */
  resultsPerQuery: 10,
  /** Listings sent to the model per scan, after deterministic filtering. */
  maxScoredPerScan: 30,
  /** Listings scored concurrently. Small: the proxy is shared and rate-limited. */
  scoreConcurrency: 4,
  /** Listing pages fetched concurrently (availability + photo + price). */
  pageConcurrency: 4,
  /** Pieces already on the board re-checked for "still for sale" at the start of each scan. */
  maxRechecksPerScan: 20,
  /** Score at or above which a listing is written to the board. */
  matchThreshold: 60,
  /** Stop the scan after this many consecutive provider failures. */
  maxConsecutiveFailures: 2,
  /**
   * Wall-clock budget for one alarm slice before the job checkpoints with
   * ctx.continue. Far below the 15-minute ceiling so a slow provider can't
   * push a slice over it.
   */
  sliceMs: 60_000,
} as const

/**
 * firecrawl/search list price per call, and what a call that FAILS bills: a
 * provider 402 is charged a flat $0.65 — ~300x a real search — and it sticks
 * (measured by the ThreadHunt example app, 2026-08-25, where ~1,000 failed
 * calls became 98% of a $681 bill). That asymmetry is why two failures in a
 * row abort the scan instead of retrying through an outage.
 */
export const SEARCH_COST_USD = { ok: 0.00216, failed: 0.65 } as const

/**
 * firecrawl/scrape, one listing page. The integration returns the real cost
 * (`costUsd`) with every successful call and the engine uses that; `ok` is the
 * fallback estimate (1 credit × $0.00083 × 1.3 platform markup). Failures
 * return no cost, so they're assumed to bill like failed searches — the
 * conservative choice for the budget gate.
 */
export const PAGE_COST_USD = { ok: 0.00108, failed: 0.65 } as const

/**
 * Hard ceiling on what one scan may spend, in USD, checked before every paid
 * call. A healthy scan costs about a cent (12 searches + 30 Haiku calls); the
 * ceiling sits above one failed search so a single blip doesn't end the scan,
 * while the consecutive-failure rule stops a real outage at two.
 */
export const SCAN_BUDGET_USD = 1.5

// ─── Scan admission (enforced by the startScan action) ──────────────────────

export const SCAN_ADMISSION = {
  /** Scans one user may have queued or running at once, across all hunts. */
  maxActivePerUser: 2,
  /** Minimum gap between two scans of the same hunt. */
  rescanCooldownMs: 2 * 60_000,
  /**
   * A hunt that says 'queued'/'scanning' but hasn't been touched in this long
   * is treated as a dead lease (the job died without cleaning up), so the user
   * isn't locked out of their own hunt forever. The job writes progress at
   * least once per query, so a live scan is never this quiet.
   */
  staleLeaseMs: 20 * 60_000,
} as const

// ─── Form limits (mirror the schema's maxLength) ────────────────────────────

export const HUNT_LIMITS = {
  designer: 80,
  piece: 120,
  season: 20,
  size: 20,
  maxPriceUsd: 100_000,
} as const
