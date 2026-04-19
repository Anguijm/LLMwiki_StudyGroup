# Session handoff: deploy-readiness landed, /auth blank-page bug under diagnosis

## Status

r1 (initial). Handoff plan — next session picks up with the `/diag`
test result and root-causes the blank-page issue from there.

## What shipped this session (PRs merged to `main`)

1. **PR #8** (`06ae4da`) — **deploy-readiness** (full code + docs):
   - New `@llmwiki/lib-utils` workspace package with `requireEnv` helper
     (rejects nullish, empty, whitespace-only incl. `\n`, `\t`).
   - `packages/db/src/{server,browser}.ts` refactored: env guards moved
     from module top-level into factory-invocation time. Original Vercel
     build failure ("NEXT_PUBLIC_SUPABASE_URL missing at Collecting page
     data") is fixed.
   - `packages/lib/ai/pdfparser.ts`: new `resolvePdfParser()` with
     config-aware key validation (`.toLocaleLowerCase('en-US')` for
     locale-safe case folding; specific error messages per failure).
   - `packages/lib/ratelimit` + `inngest/src/functions/ingest-pdf.ts`:
     migrated call-sites to `requireEnv` for empty-string consistency.
   - `apps/web/tests/unit/route-module-load.test.ts`: CI guardrail that
     dynamic-imports every route/page/layout with scrubbed AND empty
     env. 22 cases across 7 files.
   - `server-only` vitest aliases in `packages/db` + `apps/web`.
   - README "Deploy runbook" section (A–G): account checklist,
     Supabase link+migrations+storage+auth-redirects, Vercel env-var
     table with build-time notes, Inngest via Vercel marketplace,
     Upstash, smoke test, secret-placement table.
   - `.env.example` comments clarifying one-key-per-parser and
     auto-populated Inngest keys.
   - Council: r1 REVISE → r2 PROCEED + synthesis → r3 PROCEED + tiny
     refinements → **final r4 PROCEED with perfect 10/10/10/10/10/10**
     on the executed diff.

2. **PR #9** (`951299d`) — **error boundaries** for diagnosing the live
   blank-page bug:
   - `apps/web/app/error.tsx` (route-segment error boundary).
   - `apps/web/app/global-error.tsx` (layout-level error boundary).
   - Both use inline styles (no Tailwind dep) so they render even if
     CSS fails. Merged `[skip council]` as live-incident diagnostic.

3. **PR #10** (`db31445`) — **diagnostic `/diag` control page**:
   - `apps/web/app/diag/page.tsx` — pure server component, zero JS,
     zero workspace-package imports.
   - Purpose: isolate whether blank-page bug is specific to `/auth`
     (its client component / Supabase import chain) or deeper in
     layout / framework / browser environment.

## Live-environment state at handoff

### Supabase (✅ fully provisioned)

- Project created; URL, anon key, service-role key, project ref all
  collected.
- 5 migrations applied via SQL Editor (no CLI needed):
  `20260417000001_initial_schema` through `20260417000005_notes_by_similarity`.
- 8 tables present in `public` schema.
- `ingest` storage bucket created with 4 RLS policies, 25 MB file-size limit.
- `cohorts` seeded with `Default Cohort` row (id `00000000-...-000001`).
- **Auth redirect URLs** added:
  - `https://llmwiki-study-group.vercel.app/auth/callback`
  - `https://llmwiki-study-group-*.vercel.app/auth/callback`
  - `http://localhost:3000/auth/callback`
  - Site URL: `https://llmwiki-study-group.vercel.app`

### Vercel (partially provisioned)

- Project: `llmwiki-study-group` (under `anguijms-projects`).
- Production branch: `main`.
- **Settings corrections applied during session:**
  - Root Directory → `apps/web`
  - Framework Preset → **Next.js**
  - "Include files outside of the Root Directory" → ON
- **Env vars set** (9 of 13 needed):
  - `NEXT_PUBLIC_SUPABASE_URL` ✅
  - `NEXT_PUBLIC_SUPABASE_ANON_KEY` ✅
  - `SUPABASE_SERVICE_ROLE_KEY` ✅
  - `SUPABASE_PROJECT_REF` ✅
  - `ANTHROPIC_API_KEY` ✅
  - `PDF_PARSER=llamaparse` ✅
  - `LLAMAPARSE_API_KEY` ✅
  - `UPSTASH_REDIS_REST_URL` ✅
  - `UPSTASH_REDIS_REST_TOKEN` ✅
- **Env vars still missing** (must be set before smoke test):
  - ❌ `VOYAGE_API_KEY` — sign up at voyageai.com, create an API key.
  - ❌ `APP_BASE_URL=https://llmwiki-study-group.vercel.app`
  - ❌ `INNGEST_EVENT_KEY` — auto-populates via the next step.
  - ❌ `INNGEST_SIGNING_KEY` — auto-populates via the next step.
- **Inngest Vercel marketplace integration**: NOT YET INSTALLED.
  Install at vercel.com/integrations/inngest — auto-populates both
  `INNGEST_*` keys and auto-registers the `/api/inngest` endpoint.

### Current live bug (open investigation)

**Symptom**: `https://llmwiki-study-group.vercel.app/` correctly redirects
to `/auth`. The form ("Email" label + input + "Send magic link" button)
renders for a fraction of a second, then the page goes blank. URL stays at
`/auth`. Reproduces in normal AND incognito mode. Not fixed by clearing
cookies/site-data.

**What's been ruled out** (diagnosed this session):

- ✅ Server-side HTML is correct (curl of `/auth` returns 6976 bytes with
  the full form, header, and Supabase URL correctly baked into CSP).
- ✅ All `_next/static/chunks/*.js` and CSS asset URLs return HTTP 200 with
  correct `content-type`.
- ✅ CSP is permissive enough (`script-src 'self'` allows the `_next` chunks;
  `style-src 'self' 'unsafe-inline'` allows Tailwind's inline styles).
- ✅ Tailwind `brand-*` palette IS compiled into CSS with correct RGB values.
- ✅ `body { bg-white; text-brand-900 }` — visible by default.
- ✅ No service-worker registration in the HTML.
- ✅ No edge-injected analytics or external scripts.
- ✅ Route-segment error boundary (PR #9) did NOT trigger, meaning React
  did NOT throw during hydration. The DOM is being wiped by something
  other than a React error.
- ✅ No mobile-user-agent-specific response from Vercel.

**Pending test at session handoff**: does `/diag` (PR #10) render on
user's mobile browser?

- If `/diag` renders → bug is in `/auth` page's client code, most likely
  the `supabaseBrowser()` import chain or `@supabase/ssr`'s
  `createBrowserClient` auto-running a session check that errors.
- If `/diag` also goes blank → bug is in `layout.tsx` (`globals.css`,
  `<header>`, skip link) or a browser-environment artifact.
- If `/diag` shows something new → follow the signal.

## Goal for the next session

1. **Read the `/diag` test result** from the user's next-session-opening
   message.
2. **Narrow the bug** based on which branch of the test tree applies.
3. **Ship the fix** in a new plan + council round (not a diagnostic
   `[skip council]` this time — real fix with tests).
4. **Remove the diagnostic scaffolding**:
   - `apps/web/app/diag/page.tsx` — delete after bug is fixed.
   - `apps/web/app/error.tsx` — KEEP if the UX is reasonable, or replace
     with a production-styled error screen.
   - `apps/web/app/global-error.tsx` — same.
5. **Finish the Vercel env-var setup** (the 4 missing keys + Inngest
   integration) so smoke test can run.
6. **Run the README runbook's smoke test**: upload a small PDF,
   watch `ingestion_jobs` → `queued` → `running` → `completed`,
   open the rendered note.

## Open tracking items for v1+

- Issue **#6**: Storage RLS should move `owner_id` into
  `storage.objects.metadata` and match on `(metadata->>'owner_id')::uuid
  = auth.uid()`, eliminating the fragile object-name parsing. Deferred
  from v0.
- Issue **#7**: `db-tests` pgTAP fixture flakes in CI; currently
  `continue-on-error: true`. Needs CI log-access to diagnose properly.
- Issue **#4** (still open from v0 council arc): restore
  `.harness/council/product.md` within 7 days of the v0 merge.
- **NEW** (file during or at end of next session): the underlying
  `/auth` blank-page bug + the fix, so future regressions can reference
  the root cause write-up.

## Next-session opening protocol (per CLAUDE.md)

1. Read `.harness/session_state.json`.
2. Read last ~20 lines of `.harness/yolo_log.jsonl`.
3. Skim recent `.harness/learnings.md` blocks (especially the
   2026-04-19 blank-page block added this session).
4. Read this `active_plan.md`.
5. Surface the `/diag` test result the human will share.
6. Decide: narrow fix (small scope, skip council?) or larger
   investigation (full plan + council round). Default to the latter
   if scope is uncertain.

## Non-goals for the next session

- Feature work. v1 kickoff waits until blank-page is fixed AND smoke
  test passes.
- Removing the diagnostic `/diag` page before the bug is root-caused —
  it's cheap to keep around in case we need it again.
