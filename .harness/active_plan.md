# Session handoff: deploy-readiness landed, /auth blank-page bug under diagnosis

## Status

- r1: REVISE. a11y 7 / arch 9 / bugs 5 / cost 10 / product 10 / security 9.
  Council synthesis added 8-step ordered execution plan, three security
  non-negotiables, and concretized the likely root cause (dynamic
  `process.env[key]` not inlined by Next.js client bundle).
- r2 folds:
  - Council's 8-step execution order into §Next-session roadmap (below).
  - README runbook amended this session with Vercel Root Directory +
    Framework Preset (council non-negotiable; own learnings flagged).
  - error.tsx + global-error.tsx: `aria-live="assertive"` added (a11y gap).
  - GH tracking issue for `/diag` removal + error-boundary production
    hardening (council security non-negotiable).

## What shipped this session (PRs merged to `main`)

1. **PR #8** (`06ae4da`) — **deploy-readiness**:
   - New `@llmwiki/lib-utils` workspace package with `requireEnv` helper
     (rejects nullish, empty, whitespace-only incl. `\n`, `\t`).
   - `packages/db/src/{server,browser}.ts`: env guards moved from module
     top-level into factory-invocation time. Vercel build failure
     ("NEXT_PUBLIC_SUPABASE_URL missing at Collecting page data") fixed.
   - `packages/lib/ai/pdfparser.ts`: `resolvePdfParser()` with
     config-aware key validation and `.toLocaleLowerCase('en-US')`.
   - `packages/lib/ratelimit` + `inngest/src/functions/ingest-pdf.ts`:
     `requireEnv` adoption.
   - `apps/web/tests/unit/route-module-load.test.ts`: CI guardrail.
   - README "Deploy runbook" section (A–G).
   - Council arc: r1 REVISE → r2 PROCEED → r3 PROCEED → **r4 PROCEED
     10/10/10/10/10/10** on executed diff.

2. **PR #9** (`951299d`) — **error boundaries** (`error.tsx`, `global-error.tsx`).
   Merged `[skip council]` as live-incident diagnostic.

3. **PR #10** (`db31445`) — **/diag static control page** for isolating
   the blank-page bug. Merged `[skip council]`.

## Live-environment state at handoff

### Supabase (✅ fully provisioned)

- Project created; URL, anon key, service-role key, project ref collected.
- 5 migrations applied via SQL Editor, 8 tables present in `public`.
- `ingest` bucket: private, 4 RLS policies, 25 MB limit.
- `cohorts` seeded (id `00000000-...-000001`, name `Default Cohort`).
- **Auth redirects set**: production `/auth/callback`, preview
  wildcard `/auth/callback`, `localhost:3000/auth/callback`, Site URL
  = `https://llmwiki-study-group.vercel.app`.

### Vercel (partially provisioned)

- Project: `llmwiki-study-group` (`anguijms-projects`).
- **Settings applied this session**:
  - Root Directory → `apps/web`.
  - Framework Preset → **Next.js**.
  - "Include files outside of the Root Directory" → ON.
- **Env vars set** (9 of 13):
  `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`,
  `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_PROJECT_REF`,
  `ANTHROPIC_API_KEY`, `PDF_PARSER=llamaparse`, `LLAMAPARSE_API_KEY`,
  `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`.
- **Env vars missing** (must be set before smoke test):
  - ❌ `VOYAGE_API_KEY` — voyageai.com.
  - ❌ `APP_BASE_URL=https://llmwiki-study-group.vercel.app`.
  - ❌ `INNGEST_EVENT_KEY` — auto-populates.
  - ❌ `INNGEST_SIGNING_KEY` — auto-populates.
- **Inngest Vercel marketplace integration**: NOT INSTALLED.
  Install at vercel.com/integrations/inngest — auto-populates both
  `INNGEST_*` keys + registers `/api/inngest`.

## Active bug at handoff

**Symptom**: `/auth` renders form briefly, then goes blank. URL stays at
`/auth`. Reproduces in normal AND incognito. Site-data clearing doesn't
fix. PR #9's error boundaries do NOT trigger → React isn't throwing
during render/hydration → something else is wiping the DOM.

**Ruled out**:

- Server-side HTML serves correctly (6976 bytes with full form, correct
  CSP, Supabase URL baked in).
- All `_next/static/chunks/*.js` and CSS assets return 200.
- CSP permissions adequate.
- Tailwind `brand-*` compiled with correct RGB.
- No service-worker registration in HTML.
- No edge-injected external scripts.
- No mobile-user-agent variance.
- React error boundaries don't trigger (so not a render-time throw).

**Likely root cause candidates** (ranked by council synthesis):

1. **Unhandled promise rejection** from Supabase's
   `@supabase/ssr/createBrowserClient` session check firing outside
   React's lifecycle. Async errors in event handlers / effects escape
   error boundaries. **First thing to check next session.**
2. **`process.env[dynamic_key]` not inlined** by Next.js client bundle.
   My `requireEnv(name)` helper uses `process.env[name]` with a variable
   key, which the Next.js compiler cannot replace at build time. On the
   client, `process.env` is an empty shim → `requireEnv('NEXT_PUBLIC_SUPABASE_URL')`
   returns `undefined` → throws "missing or empty". Currently only
   triggers on form submit, but worth validating this isn't running
   during hydration too.
3. Client-side clock skew causing Supabase JWT validation failures
   (less likely; flagged as edge case).

**Pending diagnostic**: `/diag` static page (PR #10) — does it render
on user's mobile browser?
- renders → bug in `/auth` client code (#1 or #2 above).
- also blank → bug in `layout.tsx` / globals.css / browser environment.

## Next-session roadmap (council-approved r1 synthesis, 8 steps)

### 1. README runbook: Vercel settings
**Done this session** in r2 of this plan. Root Directory + Framework
Preset documented in README §C.

### 2. GH tracking issue: `/diag` removal + error-boundary hardening
**Done this session** — [issue #12](https://github.com/Anguijm/LLMwiki_StudyGroup/issues/12). Covers:
- Delete `apps/web/app/diag/page.tsx` post-fix.
- Harden `error.tsx` / `global-error.tsx` to production UX (i18n
  strings via `t()`, AA contrast confirmed, focus management).

### 3. Diagnose root cause via browser console
Next session's first action after reading the `/diag` test result:
- Check user's browser console (or iterate remotely) for unhandled
  promise rejections.
- Check `window.onerror` / `window.onunhandledrejection` handlers.
- Check Network tab for failed requests during the blank-page
  transition.
- Document findings in a PR comment.

### 4. Refactor client-side env var access
Replace `requireEnv('NEXT_PUBLIC_SUPABASE_URL')` with a direct,
statically-analyzable `process.env.NEXT_PUBLIC_SUPABASE_URL` in client
code paths. The generic `requireEnv` helper stays for server-only
code. New unit test: simulate a Next.js client bundle (`process.env`
is NOT the full system env) and assert the client factory still
works.

Files:
- `packages/db/src/browser.ts`
- `packages/db/src/browser.test.ts` (new assertion)
- Audit any other client-side code that imports `requireEnv`.

### 5. Accessibility hardening on error boundaries
- `role="alert"` + `aria-live="assertive"` — **DONE this session**.
- Confirm WCAG AA contrast of the red palette (manual check or axe).
- Consider i18n of error copy (defer if scope balloons; flag issue).

### 6. Implement the `/auth` fix
Based on step 3's diagnosis. Runs through council (new plan, not
`[skip council]`). Must pass security review (council
non-negotiable: auth regression risk).

### 7. Smoke test expansion: failure + idempotency modes
New `inngest/src/functions/ingest-pdf.test.ts` (or amended):
- Corrupted/0-byte PDF → job transitions to `failed`.
- Re-triggering event for same file → no duplicate note (unique
  constraint on `source_ingestion_id` holds).

### 8. Remove diagnostic scaffolding
- `git rm apps/web/app/diag/page.tsx`.
- Decide: keep `error.tsx` + `global-error.tsx` as production error
  screens (hardened per step 5) or strip back.
- Runtime check: `/diag` on production returns 404.

## Open tracking items (v1+)

- Issue **#6**: Storage RLS metadata refactor (v0 deferral).
- Issue **#7**: `db-tests` pgTAP flake (continue-on-error).
- Issue **#4**: restore `.harness/council/product.md`.
- **Issue #12**: `/diag` removal + error-boundary production hardening.
  Created this session per council must-do.

## Next-session opening protocol (per CLAUDE.md)

1. Read `.harness/session_state.json`.
2. Read last ~20 lines of `.harness/yolo_log.jsonl`.
3. Read the 2026-04-19 block in `.harness/learnings.md`.
4. Read this plan (§Active bug + §Next-session roadmap).
5. Human will provide the `/diag` test result in their opening message.
6. Branch off the step in §Next-session roadmap that matches the test
   outcome. Default: full plan + council round for the fix (step 6).

## Non-goals for the next session

- Feature work. v1 kickoff waits until blank-page is fixed AND smoke
  test passes.
- Descoping any of the council's 8 steps without a new council review.
- Gold-plating the error boundaries beyond WCAG AA + i18n.

## Non-negotiables carried forward

- The eventual `/auth` fix PR must receive its own security review
  (council must-do, auth-regression risk).
- The README runbook is now the source of truth for Vercel setup;
  any drift from it (e.g., Vercel UI changes) must be PR'd against
  the doc, not worked around locally.
- Diagnostic routes (`/diag`) are NOT production surface; must be
  removed before any user-facing launch.
