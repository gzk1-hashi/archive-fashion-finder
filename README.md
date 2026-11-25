# Archive Fashion Finder

Finds specific archive designer pieces (think Undercover SS03, Number (N)ine,
CDG Homme Plus) across US **and Japanese** resale sites, keeps only listings
that are still for sale and inside your budget *after* proxy fees and
shipping, and puts them on a live board with a photo, a price and a short
reason for each match.

Built on the DeepSpace SDK (0.44.2) for the DeepSpace Summer 2027 intern build
task.

## Why this exists

Most archive pieces surface in Japan first, on Mercari, Yahoo! Auctions,
Rakuma and 2nd Street. Those listings are written in Japanese, priced in yen,
and only reach the US through a proxy like Buyee, so the sticker price is
misleading. Searching them by hand means translating the designer's name into
katakana, guessing season spellings, converting yen, adding fees, and then
finding out the piece already sold. This app does that work for you.

## What it does

1. You create a **hunt**: designer, piece, optional season and size, and a max
   price in USD.
2. You click **Scan**. A background job searches six marketplaces:
   - English queries for Grailed and eBay.
   - Japanese queries for Mercari JP, Yahoo! Auctions, Rakuma and 2nd Street,
     with katakana designer names and Japanese season spellings.
3. A free, rule-based filter throws out anything you've already seen, obvious
   replicas, listings that don't name the designer, sold listings, and
   anything over budget on **landed cost** (item + proxy fee + domestic and
   international shipping).
4. Each survivor's page is fetched to confirm it is **still for sale** and to
   pull its photo and real price.
5. Claude Haiku 5.5 scores each confirmed listing against the hunt with a
   strict output schema. Scores of 60+ go on the board.
6. Matches stream onto the board in real time while the scan runs. You can
   save or dismiss them. Each new scan rechecks pieces already on the board and
   moves any that sold to a **Sold** tab.

## How it's built

| Part | Where |
|---|---|
| Data model (hunts, matches, seen listings) | `src/schemas/` |
| Query building, Japanese designer names, season spellings | `src/lib/queries.ts`, `designers.ts`, `season.ts` |
| Landed-cost pricing (FX, proxy fee, shipping) | `src/lib/pricing.ts`, `src/config.ts` |
| Free filter before any paid call | `src/lib/filter.ts` |
| "Is it still for sale?" checks | `src/lib/availability.ts`, `structured-data.ts`, `verify.ts` |
| AI scoring contract (Zod schema + prompt) | `src/lib/verdict.ts`, `src/server/score.ts` |
| Scan engine (phases, budget, resume) | `src/server/scan-engine.ts` |
| Platform wiring for the job | `src/server/scan-job.ts`, `src/jobs.ts` |
| Actions (start scan, delete hunt) | `src/actions/index.ts` |
| UI | `src/pages/(app)/(protected)/hunts/`, `src/components/hunts/` |

The code is layered, and each layer only depends on the one below it:

| Layer | What it is | Files |
|---|---|---|
| Presentation | React pages and components; reads live data, never decides business rules | `src/pages/`, `src/components/` |
| Application | Server actions (permission and admission checks) and the job adapter | `src/actions/`, `src/server/scan-job.ts` |
| Domain | Pure logic with no platform or network code: queries, pricing, filtering, availability, verdict rules, the scan state machine | `src/lib/`, `src/server/scan-engine.ts` |
| Infrastructure | Database access, AI calls, search and scrape integrations | `src/server/records.ts`, `src/server/score.ts`, DeepSpace SDK |
| Data model | Schemas, which double as the permission rules | `src/schemas/` |

A scan runs through phases: **recheck → search → filter → verify → score →
done**. It runs in slices of about 60 seconds and checkpoints between them with
`ctx.continue`, so it survives restarts. Writes are idempotent (`uniqueOn`
huntId + url), so a replayed slice can't create duplicate matches.

`scan-engine.ts` imports no platform or AI code. Every side effect (search,
page fetch, scoring, database reads and writes, the clock) is passed in. That
lets the tests simulate outages, a budget blow-out, cancellation and a
ten-slice resume without any network.

## Decisions

- **Users only ever see their own data.** Hunts and matches use `read: 'own'`.
  The job writes matches *as the hunt's owner*, so there's no owner column a
  client could spoof.
- **The job queue is closed to browsers.** If a client could enqueue jobs, it
  could scan any hunt on someone else's bill. If it could subscribe, it would
  see everyone's job payloads. Progress reaches the UI through the hunt row
  instead, which permissions already scope. Ownership is checked in the action
  *and* again inside the job.
- **Money guardrails.** Each scan has a budget ($1.50), checked before every
  paid batch. A failed provider call can bill a flat $0.65, so two failures
  in a row stop the scan instead of retrying through an outage. A healthy scan
  costs about a cent. The model is pinned, never "latest".
- **Sold evidence wins.** A listing is shown only if its page *positively* says
  it's available, through schema.org data or the site's own "buy" wording. Any
  sold signal (a 404, "sold out", 売り切れ, オークションは終了) overrides that. If
  the page is unclear, the listing isn't shown and isn't marked seen, so the
  next scan tries again.
- **No stuck hunts.** A "scanning" status that nobody has touched for 20
  minutes counts as dead, so a crashed job can't lock a hunt forever.

## Running it

Requires Node 22/24/26 and npm 11.6+.

```bash
npm ci
npx deepspace login
npm run dev            # local dev server
npm run validate       # type-check + unit tests
npm run lint
npx deepspace test run e2e --port 5174   # Playwright (needs 2 test accounts)
npx deepspace deploy
```

No API keys are needed. Search, page scraping and the model all go through
DeepSpace's built-in integrations.

## Tests

- **194 unit tests in 17 files (Vitest).** They cover query building, katakana
  and season handling, landed pricing, the filter, sold/available detection on
  real page snippets, schema.org parsing, the verdict contract, and the scan
  engine (budget, failures, cancellation, resume).
- **Playwright:** a hunt created by one user is invisible to a second user, and
  the hunt form rejects bad input with a message instead of saving it.

## Known limitations

- FX and proxy fees are dated constants in `src/config.ts`, not live rates.
  The platform has no FX integration.
- Two scan clicks in the same instant can both start. That costs one extra
  scan, and `uniqueOn` still prevents duplicate matches.
- Some marketplace pages give no clear availability signal. Those listings are
  held back rather than shown, so a few real matches may take more than one
  scan to appear.

## Next steps

- Compare listing photos against a reference photo you upload. The field is
  already in the hunt schema.
- A custom theme in place of the scaffold default.
- Scheduled scans that notify you when a new match appears.

See `NOTES.md` for the full build log.
