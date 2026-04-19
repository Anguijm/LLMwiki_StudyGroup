# Plan: inline NEXT_PUBLIC_* env reads in client-bundled supabaseBrowser

## Status

PRs #13 + #16 shipped: per-request CSP nonce middleware + force-dynamic
root layout. Verified end-to-end in prod:

- CSP header carries per-request nonce
- Script tags carry matching `nonce="<value>"` attributes
- `cache-control: private, no-store, max-age=0` ✅
- `/auth` page renders and stays interactive

User-tested the magic-link button: **still unresponsive**. No visible
error, no "Check your email" message, no error message.

## Root cause (verified this session)

`packages/db/src/browser.ts:14-17`:

```ts
export function supabaseBrowser() {
  const supabaseUrl = requireEnv('NEXT_PUBLIC_SUPABASE_URL');
  const anonKey = requireEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY');
  return createBrowserClient(supabaseUrl, anonKey);
}
```

`requireEnv` (in `packages/lib/utils/src/env.ts:11`) reads:

```ts
const v = process.env[name];
```

**Dynamic key.** Next.js's compile-time `process.env.NEXT_PUBLIC_*`
inliner only replaces literal property accesses (`process.env.NEXT_PUBLIC_FOO`),
not dynamic ones (`process.env[name]`). Server-side this is fine —
real Node.js `process.env` is populated. **Client-side it's not** —
Next.js ships only an empty-ish shim with `NODE_ENV` set, so
`process.env['NEXT_PUBLIC_SUPABASE_URL']` returns `undefined`.

Confirmed by curling the deployed auth chunk:

```
$ curl -s …/_next/static/chunks/app/auth/page-32aa280cf1604825.js \
    | grep -oE 'lhxokbbcojqtwvibbqfj'
(empty — Supabase URL is NOT inlined)

$ … | grep -oE 'missing or empty'
missing or empty   ← requireEnv error string IS shipped
```

So clicking "Send magic link" runs:

1. `onSubmit` async handler.
2. `supabaseBrowser()` → `requireEnv('NEXT_PUBLIC_SUPABASE_URL')` →
   throws `"NEXT_PUBLIC_SUPABASE_URL missing or empty"`.
3. Throw propagates out of the async handler, becomes a swallowed
   promise rejection. `setErr` never runs (the throw is before any
   try/catch). `setSent` never runs.
4. Button looks dead. No error visible to user.

This was flagged in the previous session's handoff plan as
"roadmap step 4" but deferred because it wasn't believed to be the
root of the blank-page bug. Now confirmed: it IS the root of the
post-CSP-fix dead-button bug.

## Fix

Replace the two `requireEnv` calls in `packages/db/src/browser.ts`
with direct, statically-analyzable reads:

```ts
import { createBrowserClient } from '@supabase/ssr';

export function supabaseBrowser() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!supabaseUrl || !anonKey) {
    throw new Error(
      'Supabase env vars missing in client bundle. ' +
        'NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY ' +
        'must be set at build time, not just runtime.',
    );
  }
  return createBrowserClient(supabaseUrl, anonKey);
}
```

Direct property access (`process.env.NEXT_PUBLIC_SUPABASE_URL`)
gets inlined by Next.js at build time → the actual URL string is
in the client bundle → `supabaseBrowser()` works.

Defensive runtime guard kept (the values are `string | undefined`
in TS strict mode, and we want a clear error if someone deploys
without the env vars set at build time).

`requireEnv` stays in use for all SERVER-side callers (server.ts,
inngest, ratelimit, ai/pdfparser). Those run in real Node.js
contexts where dynamic `process.env[name]` works fine.

## Why not "make `requireEnv` smarter"?

Tempting: detect at runtime if we're in a Next.js client bundle
and pull from `__NEXT_DATA__` or some inlined map. Council will
(rightly) reject:

- Next.js doesn't expose `NEXT_PUBLIC_*` values via any documented
  client API. The only contract is "literal `process.env.X` gets
  inlined at build time."
- Adding a runtime detect-and-fallback path masks the real fix:
  "client-bundle code must read env vars literally, not by name."
- Server-side `requireEnv` is correct as-is. Two distinct constraints
  → two distinct call patterns. Don't bloat the helper.

## Why not "fix it in `requireEnv` with a build-time codemod"?

Even more tempting if we had multiple client-side callers. We don't —
only `browser.ts` is client-bundled. Two-line surgical fix beats
codemod plumbing.

## Files changed

1. **`packages/db/src/browser.ts`** *(modified)*
   - Drop `requireEnv` import.
   - Read both env vars via direct property access.
   - Inline guard with a clear error message.

2. **`packages/db/src/browser.test.ts`** *(if it exists; new otherwise)*
   - Stub `process.env` with both vars set → `supabaseBrowser()`
     returns a client without throwing.
   - Stub `process.env` with `NEXT_PUBLIC_SUPABASE_URL` unset → throws
     with the documented error message.
   - Same with anon key unset.

## Verification plan

Local (pre-push):

1. `pnpm --filter @llmwiki/db run typecheck` clean.
2. `pnpm --filter @llmwiki/db run test` passes (new browser tests).
3. `pnpm --filter web run typecheck` clean.
4. `pnpm --filter web run test` still 58/58.
5. `env -i PATH="$PATH" HOME="$HOME" NEXT_PUBLIC_SUPABASE_URL='https://x.supabase.co' NEXT_PUBLIC_SUPABASE_ANON_KEY='anon' NODE_ENV=production npx next build` in `apps/web/` succeeds.
6. After build, `grep -r 'x.supabase.co' apps/web/.next/static/chunks/app/auth/` finds the URL string in the auth chunk — confirms inlining happened.

Post-deploy (prod):

7. `curl -s …/_next/static/chunks/app/auth/page-*.js | grep lhxokbbcojqtwvibbqfj` returns matches (currently zero).
8. **Human clicks "Send magic link"** → either receives email or
   sees a "Check your email" message. **Real test of the fix.**
9. Human completes full sign-in round-trip and lands on dashboard.

## Non-goals

- Refactoring all `requireEnv` callers. Only browser.ts is broken.
- Adding a lint rule to forbid client-side `requireEnv`. Worth a
  follow-up issue but not blocking.
- Removing `/diag` (issue #12).
- Hardening `style-src` (issue #15).
- CSP `report-uri` (issue #14).
- Playwright nonce smoke test (queued from PR #16's council r2).

## Non-negotiables

- **Auth surface change.** Council required. No `[skip council]`.
- Service-role key stays server-only (this fix touches only
  the browser client; service-role is in server.ts, untouched).
- Direct `process.env.NEXT_PUBLIC_*` access in client bundle is the
  ONLY supported pattern. Future client-bundled env reads must
  follow the same pattern; lint enforcement is a follow-up.

## Rollback

Revert the single commit on `main`. Browser auth returns to the
current dead-button state — no worse, no better. The CSP nonce
infrastructure (PRs #13, #16) is not affected.

## Cost posture

Zero new API calls. Zero new dependencies. The code path that runs
when the user clicks "Send magic link" is unchanged in shape — only
the env-read mechanism changes. Pure correctness fix.

## Open question for council

1. **Should we add a build-time assertion that `NEXT_PUBLIC_*`
   vars resolve to non-empty strings, failing the build if not?**
   Today, missing build-time vars surface only as a runtime click
   failure. A failing build would be a stronger guard. Out of scope
   here (would need a custom Next.js plugin or build script), but
   worth a follow-up issue if the cohort grows.

## Execution order

Single small commit:

1. Edit `packages/db/src/browser.ts` (the two-line replacement).
2. Add `packages/db/src/browser.test.ts` (success + missing-url +
   missing-key cases).
3. Local verification (steps 1-6 above).
4. Commit `fix(db): inline NEXT_PUBLIC_* env reads in client bundle`.
5. Push → council r2.
6. On PROCEED → human approval → merge.
7. Post-merge prod verification (steps 7-9).
8. Reflect in `.harness/learnings.md`.
