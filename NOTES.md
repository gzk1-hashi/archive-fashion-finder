# NOTES — Archive Fashion Finder

Running log of what the agent did, what was verified, and what Geah still has
to verify. Newest session on top.

---

## Session 4 — Tue Nov 24, evening (agent review before submission; Geah on the laptop)

### Platform blockers (not code)

- `npx deepspace deploy` fails with `release_in_progress` from both machines;
  `releases` = 0, `status` = "never deployed". Reported via `deepspace feedback`.
- `firecrawl/search` returns Firecrawl 402 `insufficient_credits` ("team has 0
  left") although the account has 459 credits. The engine stopped after two
  failures as designed. Reported via `deepspace feedback` (3e57b4cd…).

### Full code review — one real bug fixed

- **Recheck could burn the scan budget during an outage.** The board recheck
  fetched 4 pages at once; each failed page is booked at $0.65, so one failed
  batch ($2.60) exceeded the $1.50 budget and the search never ran. Now the
  first recheck fetch is a single probe and any failure ends the pass.
  Test: "a full board during a page outage costs one probe, not the search
  budget" (failed before the fix, passes after). `src/server/scan-engine.ts`
- README: layered-architecture table; budget wording ("before every paid
  batch"); test count.

### Verified by the agent

`tsc --noEmit` clean · `vitest` 17 files / 194 tests · `eslint .` clean ·
`vite build` OK.

### Known, left as is (documented)

- If the job throws before its first checkpoint (e.g. the hunt read fails),
  the hunt stays `queued` until the 20-minute lease expires.
- The board's "running" check uses the time of the last render, so a dead
  lease only clears from the UI on the next update or refresh.

---

## Session 2 — Sat Nov 21, 4:00 PM → evening (agent, while Geah was at work)

Goal for the day (from the plan): Friday + Saturday items — schemas, hunt form
and list, `config.ts`, query builder + tests, scan job, filter, verdict with
Zod + tests, live board with scored matches and status updates.

### Status: all of it is written and passes every local check. Nothing is committed, pushed or deployed.

### Verified by the agent (in a Linux copy of the repo, same lockfile)

| Check | Result |
|---|---|
| `npx tsc --noEmit` | clean |
| `npx vitest run` | 14 files, 149 tests pass (146 new + 3 from the scaffold) |
| `npx eslint .` | clean |
| `npx vite build` | builds (worker + client + prerender) |
| SDK `lintSchemas(schemas)` | zero warnings (it's a test now) |

### NOT verified yet — needs you (the agent can't log in as you)

1. **Live scan end to end** in `npx deepspace dev start`: create a hunt → watch
   the bar move → matches appear on the board while it runs.
2. **Firecrawl's real response shape.** `extractHits` handles every shape we've
   seen (`[...]`, `{data:[...]}`, `{data:{data:[...]}}`, `{data:{web:[...]}}`,
   `{results:[...]}`), but no real call has been made from this app yet.
3. **Does a search hit include an image?** With scraping off it may not. If it
   doesn't, cards show "No photo in search result" and scoring is text-only —
   still works. The photo check is Monday's (cuttable) task anyway.
4. **The AI call through the DeepSpace proxy** (`generateText` + `Output.object`
   on `claude-haiku-5-5`). Types check; it hasn't run against the real proxy.
5. **Two users can't see each other's hunts/matches** (Sunday's Playwright test).

### Suggested commit sequence (review each, then commit)

`src/schemas.ts` was still uncommitted from Friday (your `git add src/schemas`
missed it) — it's in commit 1 below.

```bash
# 1 — data model
git add src/schemas.ts src/schemas/ src/types.ts src/schemas.test.ts
git commit -m "Add matches + seen_listings schemas; server-owned scan fields on hunts"

# 2 — the free part of the funnel (pure + tested)
git add src/config.ts src/lib/text.ts src/lib/designers* src/lib/season* src/lib/queries* \
        src/lib/pricing* src/lib/listings* src/lib/filter* src/lib/verdict* src/lib/lease* \
        src/lib/hunt-input* src/lib/format.ts
git commit -m "Add search funnel: bilingual queries, landed pricing, filter, verdict contract"

# 3 — server: job, actions, locked job queue
git add src/server/records.ts src/server/score.ts src/server/scan-engine* src/server/scan-job.ts \
        src/jobs.ts src/actions/ worker.ts
git commit -m "Add resumable scan-hunt job and startScan/deleteHunt actions"

# 4 — UI
git add src/components/hunts/ "src/pages/(app)/(protected)/hunts/" "src/pages/(app)/home.tsx" \
        src/nav.ts src/lib/api.ts
git commit -m "Add hunts list, create form and live board"

# 5 — docs
git add NOTES.md AGENTS.md
git commit -m "Notes and project rules for agents"

git push
```

Run `npm run validate` and `npm run lint` yourself first — on your machine.

### What changed in files you wrote

- **`src/schemas/hunts-schema.ts`** — your columns and permissions are intact. Added:
  - `'queued'` to `status` options (the action claims the hunt before the job starts).
  - `scanProgress`, `scanStage`, `lastScanSummary` — written only by the job.
  - `timestampTrigger: { field: 'status', value: 'done' }` on `lastScannedAt` —
    the RecordRoom stamps it itself when status flips to done.
  - `delete: false` for member/admin — deletes go through the `deleteHunt`
    action so matches + seen rows are removed with the hunt.
  - `maxLength: 300` on `refPhotoKey`; `writableFields` pulled into one exported
    const `HUNT_EDITABLE_FIELDS` (same six fields).
- **`worker.ts`** — `AppJobRoom` now denies every client read and write (see
  "decisions"). Removed the now-unused `resolveAppRole` import.
- **`src/pages/(app)/home.tsx`** — placeholder replaced with a short intro + link.
- **`src/nav.ts`** — added `Hunts`.

### How a scan works (one paragraph you can say out loud)

The user clicks Scan → `startScan` action checks they own the hunt, that no
scan is already running, the cooldown, and their concurrent-scan cap → marks
the hunt `queued` → `enqueueJob(...)`. The JobRoom runs `scan-hunt`: it builds
~12 queries (English for Grailed/eBay, **Japanese** for Mercari, Yahoo!
Auctions, Rakuma, 2nd Street), runs them through `firecrawl/search` with a
`site:` filter each, canonicalizes URLs, then a **free** filter drops
already-seen listings, self-declared replicas, over-budget listings (using
**landed** cost: item + proxy fee + both shipping legs) and listings that don't
name the designer. The best ~30 go to Claude Haiku 5.5 one at a time with a
strict Zod output schema; scores ≥ 60 become match rows, written *as the hunt
owner*, which stream onto the board in real time. Every slice is ~60s; between
slices the job checkpoints with `ctx.continue(state)` so it survives restarts.

### Decisions worth defending in the interview

1. **Job writes as the hunt owner** (`buildCronContext(env, ownerId, scope)`),
   so matches get `createdBy = owner` and plain `read: 'own'` protects them. No
   `ownerField` column = nothing for a client to spoof. (`src/server/records.ts`)
2. **Job queue closed to browsers** (`authorizeWrite/Read: () => false`). A
   client that can enqueue can scan any hunt id on the owner's bill; a client
   that can subscribe sees every user's job payloads in the room snapshot.
   Progress reaches the UI through the hunt row instead, which RBAC already
   scopes. (`worker.ts`)
3. **Confused-deputy guard twice**: the action checks ownership; the job
   re-checks hunt.createdBy against the payload and `job.enqueuedBy`.
4. **Dedupe in the database**: `uniqueOn: ['huntId','url']` on matches and
   seen_listings, with canonical URLs (Grailed slug + tracking params
   stripped). Writes are idempotent (`createIfAbsent`), which is what makes a
   resumed slice safe to replay.
5. **Ports-and-adapters scan engine**: `scan-engine.ts` imports no platform or
   AI code; every side effect is injected. That's why the tests can simulate an
   outage, a budget blow-out, cancellation and a 10-slice resume.
6. **Money guardrails**: budget checked *before* every paid call; two
   consecutive provider failures stop the scan (a failed firecrawl call bills a
   flat $0.65 — ThreadHunt measured it). Model pinned, `temperature: 0`.
7. **Status as a lease** (`src/lib/lease.ts`): `queued/scanning` that nobody
   has touched for 20 min is dead, so a crashed job can't lock a hunt forever.
8. **Niche domain knowledge, all tested**: katakana designer names, season
   spellings (SS02 / 02SS / 2002SS / 2002春夏), CDG `AD` production-year codes
   (SS pieces usually carry the previous year), 〜風 = "-style" red flag but not
   風合い (texture), 定価 = retail price to skip, 万円 = ×10,000, Japanese
   numeric and Italian sizes.

### Known gaps / honest limitations

- Two `startScan` calls in the same instant can both pass the lease check
  (read-then-write, no transaction across the action and the room). Effect:
  one extra scan's cost; `uniqueOn` prevents duplicate matches.
- FX and proxy fees are dated constants (`FX.asOf`, `PROXY_COSTS_JPY.asOf`),
  not live — there's no FX integration on the platform.
- Reference photo (`refPhotoKey`) is stored but not used yet — Monday.
- The theme is still the scaffold default — Monday.
- `zod` adds ~60 KB to the hunts page chunk; `zod/mini` would cut it if it matters.

### Next (Sunday plan)

Save/dismiss is already done (plain `put` on `status`). Remaining: run a real
scan in dev and fix whatever the live Firecrawl/AI responses reveal; Playwright
two-user isolation test; first real deploy after commit + push.

---

## Session 1 — Thu/Fri Nov 19–20 (Geah)

- Scaffolded with DeepSpace SDK 0.44.2, pushed to GitHub before first deploy.
- First deploy hit `release_reconciliation_pending`, then `release_in_progress`;
  placeholder site later loaded. Confirm with `npx deepspace releases`.
- Wrote `src/schemas/hunts-schema.ts` (owner-only reads, writableFields).
