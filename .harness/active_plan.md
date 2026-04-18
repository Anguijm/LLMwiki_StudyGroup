# Deploy-readiness: env-var resilience + runbook (v0-to-live)

## Status

- r1: REVISE. a11y 10 / arch 10 / bugs 9 / cost 10 / product 10 / security 10. One blocker (empty-string env passes the guard); two security must-dos (regression test + factory throw asserts must actually land, not just be proposed).
- r2: PROCEED. Same scores, 0 non-negotiables. Lead Architect's synthesis added two improvements:
  - Extract `requireEnv` to a shared `packages/lib/utils/env.ts` utility (was module-local duplicate).
  - PDF parser factory must validate the *specific* key matching `PDF_PARSER`, not just "any one of the two."
- r3 folds both into the written plan so plan-on-disk matches what gets executed. No other changes.
- Nice-to-have `pnpm setup:env` interactive script: deferred to v1 (out of scope here).

## Symptom (concrete)

Vercel build on `main` @ `9c67668` fails at the "Collecting page data" phase:

```
apps/web build: Error: NEXT_PUBLIC_SUPABASE_URL missing
  at 42009 (.next/server/app/auth/callback/route.js:1:1457)
  ...
apps/web build: > Build error occurred
apps/web build: [Error: Failed to collect page data for /auth/callback]
```

## Root cause

`packages/db/src/server.ts:16-21` and `packages/db/src/browser.ts:5-9` read
`process.env.NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY` at
module top-level and `throw` if unset. Next.js's "Collecting page data" phase
loads every route module to gather metadata; `/auth/callback/route.ts` →
`apps/web/lib/supabase.ts` → `@llmwiki/db/server` chain evaluates the top-level
guard on a build machine without the env vars populated, killing the build.

This conflates build-time env-validation (a separate concern, best handled by a
dedicated check script) with runtime validation (which should fire when the
factory is actually called).

Compounding: Vercel env vars are literally unset in the current project. GitHub
Actions secrets and Codespaces secrets do NOT flow to Vercel — each platform
has its own store. So even after the code fix, the runtime will still fail
until Vercel's env-var store is populated. Both problems must be solved.

## Goal

1. Unblock the failing Vercel build: code no longer throws at module-load time.
2. Produce a complete, self-serve runbook so the human can provision
   Supabase + Vercel + Inngest + Upstash + the one chosen PDF parser and
   complete a successful PDF-upload → rendered-note smoke test.

## Non-goals (tracked as follow-ups, not this PR)

- Actually performing the deploy (human action in dashboards — provided as
  runbook steps, not executed by the agent).
- A dedicated `env-check` CLI that validates the full env-var surface at
  build-time start (nice-to-have; v1).
- Upstash and LlamaParse account creation (human-only steps in the runbook).
- Migrating `/inngest` into a named workspace package (deferred unless the
  audit in §3 determines the current relative-import path actually breaks on
  Vercel).

## Scope of this PR

### 1. Shared `requireEnv` utility

**File: `packages/lib/utils/env.ts` (new)**

Single shared helper consumed by every package that lazy-reads env vars.
Rejects nullish, empty, and whitespace-only values. An env var pasted as
`""` (a common Vercel UI mistake) is functionally equivalent to missing —
surfacing it cleanly at the factory call beats failing opaquely deep inside
the Supabase SDK three frames later.

```ts
export function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v || v.trim().length === 0) {
    throw new Error(`${name} missing or empty`);
  }
  return v;
}
```

**File: `packages/lib/utils/env.test.ts` (new)**

`it.each`-style matrix: `undefined` → throw, `''` → throw, `'   '` → throw,
`'  value  '` → returns `'  value  '` unchanged (no trim of valid values;
trim is only used to detect all-whitespace). Error message includes the
variable name.

**Package wiring**: `packages/lib/utils` becomes a thin workspace package
(`@llmwiki/lib-utils`) so `@llmwiki/db`, `@llmwiki/lib-ai`, `@llmwiki/lib-ratelimit`, and `inngest/src` can import it. Added to `transpilePackages` in
`apps/web/next.config.js`.

### 1a. Code: lazy env-var guards (`packages/db`)

**File: `packages/db/src/server.ts`**

- Remove top-level reads at lines 16-21.
- Import `requireEnv` from `@llmwiki/lib-utils`.
- `supabaseServer(cookieHeader)`: read `NEXT_PUBLIC_SUPABASE_URL` and
  `NEXT_PUBLIC_SUPABASE_ANON_KEY` inside the function body via `requireEnv`.
- `supabaseService()`: read `NEXT_PUBLIC_SUPABASE_URL` and
  `SUPABASE_SERVICE_ROLE_KEY` inside via `requireEnv`.
- No change to fail-closed semantics at call sites — an invocation still
  throws loudly if the var is missing. Only the import-time throw is removed.

**File: `packages/db/src/browser.ts`**

- Same transformation: import `requireEnv` from `@llmwiki/lib-utils`, factory
  `supabaseBrowser()` reads env vars lazily at invocation.

**Test: `packages/db/src/server.test.ts` (new)**

Uses `vi.stubEnv()` to control `NEXT_PUBLIC_SUPABASE_URL`,
`NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` before
`import('./server')`. Asserts:

- `import('./server')` does NOT throw with all three env vars unset.
- `import('./server')` does NOT throw with all three env vars set to `''`.
- `import('./server')` does NOT throw with all three env vars set to `'   '`.
- Three rows of `it.each([['unset', undefined], ['empty', ''], ['whitespace', '   ']])`:
  - With `NEXT_PUBLIC_SUPABASE_URL` in that state, `supabaseServer('cookie=x')`
    throws an `Error` whose message contains `NEXT_PUBLIC_SUPABASE_URL`.
  - With `SUPABASE_SERVICE_ROLE_KEY` in that state, `supabaseService()` throws
    an `Error` whose message contains `SUPABASE_SERVICE_ROLE_KEY`.
- All required env vars set to valid values: `supabaseServer()` returns a
  client object (smoke).

**Test: `packages/db/src/browser.test.ts` (new)**

Symmetric: same `it.each` matrix. `import('./browser')` never throws.
`supabaseBrowser()` throws on any of {missing, empty, whitespace}.

**Regression test: `apps/web/tests/unit/route-module-load.test.ts` (new)**

Discovers every `apps/web/app/**/route.{ts,tsx}` and every
`apps/web/app/**/page.{ts,tsx}` via a glob. For each file, runs the
import in a `describe.each` block under two env conditions:
- All app env vars **unset** (`vi.stubEnv(name, undefined)`).
- All app env vars **set to empty string** (`vi.stubEnv(name, '')`).

Asserts the dynamic `import()` resolves without throwing in both states.
Implementation note: must use `vi.resetModules()` between iterations so
each import re-runs module-top-level code; otherwise the first import's
result is cached and subsequent stub changes don't take effect.

This catches the class of bug this PR fixes at CI time, not just Vercel
build time, AND catches the council-flagged empty-string variant.

### 2. Code: audit other top-level env reads

`rg -n "process\\.env\\." packages/ inngest/ apps/web/lib/ apps/web/app/` and
inspect every match. For any that live at module top-level AND throw/error on
missing values, apply the same move-guard-into-function transform using the
shared `requireEnv`. Scope is limited to load-time throws; in-function
validation stays as-is. Expected surface (from plan-time audit, to be verified
at implementation time):

- `packages/lib/ai/anthropic.ts` — `ANTHROPIC_API_KEY` (lazy via `requireEnv`)
- `packages/lib/ai/voyage.ts` — `VOYAGE_API_KEY` (lazy via `requireEnv`)
- `packages/lib/ai/pdfparser.ts` — see §2a below (config-aware, not a plain `requireEnv`)
- `packages/lib/ratelimit/*.ts` — `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` (lazy)
- `inngest/src/client.ts` — `INNGEST_EVENT_KEY` (lazy)
- `apps/web/app/api/inngest/route.ts` — `INNGEST_SIGNING_KEY` (read inside
  `serve({...})` invocation; this one is likely fine)

If the route-module-load test from §1a passes across the whole surface, no
further changes needed.

### 2a. PDF parser factory: config-aware key validation

**File: `packages/lib/ai/pdfparser.ts`**

The pdfparser factory is a switch on `PDF_PARSER`. Only the key matching the
selected parser is required — requiring both would force users to provision
two accounts for no reason, and treating them as interchangeable hides a
misconfigured `PDF_PARSER`.

```ts
type PdfParserKind = 'reducto' | 'llamaparse';

function resolvePdfParser(): { kind: PdfParserKind; apiKey: string } {
  const kind = requireEnv('PDF_PARSER').toLowerCase();
  if (kind !== 'reducto' && kind !== 'llamaparse') {
    throw new Error(
      `PDF_PARSER must be 'reducto' or 'llamaparse' (got '${kind}')`,
    );
  }
  const keyName = kind === 'reducto' ? 'REDUCTO_API_KEY' : 'LLAMAPARSE_API_KEY';
  const apiKey = process.env[keyName];
  if (!apiKey || apiKey.trim().length === 0) {
    throw new Error(
      `PDF_PARSER is '${kind}' but ${keyName} is missing or empty`,
    );
  }
  return { kind: kind as PdfParserKind, apiKey };
}
```

This is called lazily inside the exported `parsePdf(input)` function, not at
module top-level. The unused key (e.g. `REDUCTO_API_KEY` when `PDF_PARSER=llamaparse`)
is explicitly not checked — pragmatic for the "one parser at a time" v0 posture.

**File: `packages/lib/ai/pdfparser.test.ts` (amend)**

Add four new test cases:
1. `PDF_PARSER='reducto'` + `REDUCTO_API_KEY` unset/empty/whitespace → throws
   with message containing both `'reducto'` and `REDUCTO_API_KEY`.
2. `PDF_PARSER='llamaparse'` + `LLAMAPARSE_API_KEY` unset → throws symmetrically.
3. `PDF_PARSER='reducto'` + `LLAMAPARSE_API_KEY` set but `REDUCTO_API_KEY` unset
   → still throws (provisioning the other key does NOT satisfy the guard).
4. `PDF_PARSER='unknown_parser'` → throws with message listing the valid values.

### 3. Code: verify Inngest route import path

**File: `apps/web/app/api/inngest/route.ts` line 10**

Current:
```ts
import { inngest, ingestPdf, ... } from '../../../../../inngest/src';
```

The path traverses 5 directories up from
`apps/web/app/api/inngest/route.ts` to the repo root, then into `/inngest/src`.
The failing Vercel build log shows `cwd=/vercel/path0` at the workspace root
and `pnpm -r run build` executed at that root — meaning the repo root IS the
build root, and this relative import resolves correctly. Confirmed: the
current build gets past module bundling and fails only at page-data collection
on the env throw. No Inngest-path change needed for this PR.

If implementation-time verification reveals otherwise (e.g., `apps/web` is
later set as the Vercel "root directory"), the fix is to promote `/inngest`
to a workspace package `@llmwiki/inngest` and add it to `transpilePackages`
in `next.config.js`. Tracked as a follow-up issue if it bites.

### 4. README: complete deploy runbook

Rewrite the README's "Environment & Deployment" and "Setup" sections as an
explicit step-by-step checklist. All other README content untouched.

**4a. Account + key checklist**

| service | required for v0? | key(s) | where to get |
|---|---|---|---|
| Supabase | yes | URL + anon key + service-role key + project ref | dashboard → Project Settings → API |
| Vercel | yes | (no key, just the project) | vercel.com/new |
| Anthropic | yes | `ANTHROPIC_API_KEY` | console.anthropic.com |
| Voyage | yes | `VOYAGE_API_KEY` | voyageai.com |
| LlamaParse **or** Reducto (pick ONE) | yes | one of `LLAMAPARSE_API_KEY`, `REDUCTO_API_KEY` + set `PDF_PARSER` accordingly | llamaindex.ai (recommended; 2-min signup) or reducto.ai |
| Upstash | yes | REST URL + REST token | upstash.com → create Redis db |
| Inngest | yes | `INNGEST_EVENT_KEY` + `INNGEST_SIGNING_KEY` | **auto-populated by the Inngest Vercel marketplace integration — no CLI needed** |

**4b. Supabase: project → live**

1. Create project; pick a region near your users.
2. Dashboard → Project Settings → API: copy URL, anon key, service-role key, project ref.
3. Locally: `supabase link --project-ref <ref>` then `supabase db push`.
   *(Replaces the incorrect `npx supabase migration up` line in the current README.)*
4. Dashboard → Storage: confirm the `ingest` bucket exists (created by
   migration `20260417000002_rls_policies.sql`). If it doesn't, the migration
   failed — re-run.
5. Dashboard → Authentication → URL Configuration → Redirect URLs: add your
   production URL (e.g. `https://<your-app>.vercel.app/auth/callback`) AND
   the Vercel preview pattern (`https://<your-app>-*.vercel.app/auth/callback`).
6. Dashboard → Authentication → URL Configuration → Site URL: set to the
   production domain.

**4c. Vercel: env-vars checklist**

Paste this literal table of keys into `Vercel → Project → Settings → Environment Variables`:

| key | Production | Preview | Development | Build-time? |
|---|---|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | yes | yes | yes | **yes** (NEXT_PUBLIC_) |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | yes | yes | yes | **yes** (NEXT_PUBLIC_) |
| `SUPABASE_SERVICE_ROLE_KEY` | yes | yes | yes | runtime-only |
| `SUPABASE_PROJECT_REF` | yes | yes | yes | runtime-only |
| `ANTHROPIC_API_KEY` | yes | yes | yes | runtime-only |
| `VOYAGE_API_KEY` | yes | yes | yes | runtime-only |
| `PDF_PARSER` | yes | yes | yes | runtime-only |
| `LLAMAPARSE_API_KEY` *(if chosen)* | yes | yes | yes | runtime-only |
| `REDUCTO_API_KEY` *(if chosen)* | yes | yes | yes | runtime-only |
| `UPSTASH_REDIS_REST_URL` | yes | yes | yes | runtime-only |
| `UPSTASH_REDIS_REST_TOKEN` | yes | yes | yes | runtime-only |
| `INNGEST_EVENT_KEY` | (auto) | (auto) | yes | runtime-only |
| `INNGEST_SIGNING_KEY` | (auto) | (auto) | yes | runtime-only |
| `APP_BASE_URL` | yes | yes | yes | runtime-only |

- Vercel defaults `NEXT_PUBLIC_*` keys to "available at build time". Nothing to
  toggle unless you've explicitly de-selected them.
- "Where does each key LIVE?" is its own subsection:

| platform store | what lives there |
|---|---|
| Vercel env vars | all runtime keys above; build needs `NEXT_PUBLIC_*` present |
| GitHub Actions secrets (repo) | only keys the CI workflows need: `GEMINI_API_KEY` for council, maybe `ANTHROPIC_API_KEY` if future CI eval uses it |
| GitHub Codespaces secrets (personal) | whatever the human developer wants for local dev in Codespaces; mirror of `.env.example` |

Secrets do not propagate cross-platform. GitHub Actions ≠ Codespaces ≠ Vercel.

**4d. Inngest: via Vercel marketplace integration (no CLI)**

1. [vercel.com/integrations/inngest](https://vercel.com/integrations/inngest) → Install → pick the project.
2. The integration auto-populates `INNGEST_EVENT_KEY` and `INNGEST_SIGNING_KEY`
   in the Vercel env-var store for all three environments.
3. On the next deploy, Vercel emits a webhook to Inngest containing the
   `/api/inngest` endpoint URL; Inngest auto-registers the app.
4. Verify: Inngest dashboard → Apps → you should see `llmwiki-studygroup`
   (the `id` from `inngest/src/client.ts:20`) with 4 functions listed.
5. No `inngest-cli` or `npx` commands required for production. The CLI is only
   for running `inngest-cli dev` against a local Next.js server.

**4e. Upstash**

1. upstash.com → Create Database → Regional → pick region near Vercel.
2. Copy REST URL + REST token → Vercel env vars.

**4f. First deploy + smoke test**

1. Push the PR that lands this plan. Merge to `main`.
2. Vercel auto-deploys on merge. Watch build logs.
3. Visit `https://<your-app>.vercel.app/auth` → enter email → receive magic
   link → click → should land on `/` (dashboard).
4. Upload a small PDF. Watch the "Recent ingestion jobs" status table.
5. Expect `queued` → `running` → `completed`. Open the note by slug; the
   simplified body renders.
6. If stuck in `queued` > 30s: Inngest dashboard → App → Functions → check
   for errors. Most common cause at this step: Inngest integration didn't
   auto-register; redeploy.

### 5. `.env.example` comments

Annotate to reduce future confusion:

- Line before `PDF_PARSER`: add
  `# Pick ONE parser. Set PDF_PARSER and populate the matching key. Leave the other blank.`
- Line before `INNGEST_EVENT_KEY`: add
  `# Auto-populated by the Inngest Vercel marketplace integration in production.`
  `# For local dev via inngest-cli, generate from the Inngest dashboard → Settings → Keys.`

No keys added or removed.

### 6. `.harness/learnings.md` reflection

Append a KEEP/IMPROVE/INSIGHT/COUNCIL block per the CLAUDE.md protocol at
end-of-task, covering:

- KEEP: env-guards-at-invocation-time is a pattern, not a one-off. Apply to any
  lib package that talks to an external API.
- IMPROVE: v0 plan should have specified lazy guards from the start. The
  council caught 8 rounds of security issues but missed this Vercel-build
  class of bug because no round simulated a "build runs with no env".
- INSIGHT: `Collecting page data` evaluates every route module's top-level
  code. Any import-time throw is a deploy blocker. Next.js-specific.

## Security surface

- No new secret surfaces introduced.
- No change to fail-closed runtime semantics: calling any factory without the
  required env still throws loudly. Only the import-time throw is removed.
- No raw secrets touch git in any step.
- Runbook guides the human to add production URLs to Supabase Auth redirect
  allowlist — explicit hardening step.

## Cost posture

- No new API callsites, no new dependencies, no new infra. $0 impact.

## Rollout

- Single PR on `claude/fix-vercel-deployment-iXGlc`.
- Council runs on `opened` + each `synchronize` of the PR.
- CI gates: `pnpm lint`, `pnpm typecheck`, `pnpm test` (includes new regression
  test), `pnpm --filter web test:a11y` (no UI changes; should be a no-op).
- Post-merge rollout is a HUMAN action: follow the README runbook end-to-end.

## Risks

1. **Inngest Vercel-integration UX may have drifted** from the steps in 4d.
   Mitigation: verify each step against the current Inngest docs at
   implementation time; update runbook prose to match. If the integration
   requires post-install manual steps (e.g. re-authorizing the app), document
   those.
2. **Supabase Storage bucket creation via migration** depends on the
   `insert into storage.buckets` line in `20260417000002_rls_policies.sql`
   running on a fresh project. Mitigation: the runbook's step 4b.4 tells the
   human to verify the bucket exists and re-run if not.
3. **Inngest relative-import path** (`../../../../../inngest/src`): current
   build log confirms it resolves. If Vercel's root-directory setting gets
   changed later (apps/web), this breaks. Mitigation: follow-up issue to
   promote `/inngest` to a workspace package; not in this PR unless we
   observe the break.
4. **Ratelimit lib reads Upstash config at top-level**: plausible; the §2
   audit catches it. If found, fix in the same PR.

## Metrics / success

- CI on the PR is green (lint + typecheck + test including the new regression).
- Council verdict PROCEED with no outstanding non-negotiables.
- After merge + human-side runbook execution: `/auth/callback` route on the
  live domain returns a redirect (not an error page), and a smoke-test PDF
  ingests end-to-end.
