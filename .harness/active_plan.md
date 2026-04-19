# Plan: CSP-nonce middleware to unblock Next.js App Router hydration

## Problem

Production pages (`/`, `/auth`, `/diag`) render their server HTML, paint
briefly in the browser, then go blank. The handoff plan hypothesised a
client-side `requireEnv` issue in `/auth`. That hypothesis was wrong:
`/diag` (pure server component, zero workspace imports, inline styles,
no client JS of its own) reproduces the same blank-page symptom on the
user's device.

## Root cause (confirmed this session)

`apps/web/next.config.js:12-23` ships a static CSP header:

```
default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; ...
```

Next.js 15 App Router emits inline `<script>` tags to ship the React
Flight payload to the client (verified by `curl -sL` against `/diag`):

```html
<script>(self.__next_f=self.__next_f||[]).push([0])</script>
<script>self.__next_f.push([1,"1:\"$Sreact.fragment\"\n..."])</script>
```

`script-src 'self'` (no `'unsafe-inline'`, no nonce, no hash) blocks
every one of those inline scripts. Resulting chain:

1. Server sends valid HTML → page paints briefly.
2. Browser parses inline scripts → CSP violation → scripts are dropped.
3. External `main-app.js` (allowed by `'self'`) runs, expects
   `self.__next_f` populated → it's empty.
4. React client attempts hydration against a missing Flight payload →
   mismatch / throw → App Router tears down the tree to client-render
   → client render also fails (no hydration data) → DOM is blank.

Error boundaries don't trigger because the failure happens below React's
error-boundary reach (Flight payload bootstrap is pre-hydration).

## Proposed fix

Replace the static CSP with a **per-request nonce** generated in a new
`apps/web/middleware.ts`. Next.js 15 reads the `x-nonce` request header
and automatically stamps that nonce on every inline script it emits.
Result: inline scripts have `nonce="<value>"`, CSP header whitelists
that exact nonce for this request, browser executes them, hydration
completes.

This is the officially documented Next.js pattern for App Router + CSP
([nextjs.org/docs/app/building-your-application/configuring/content-security-policy](https://nextjs.org/docs/app/building-your-application/configuring/content-security-policy)).

### Why not `'unsafe-inline'`?

Tempting one-line fix. Council will (rightly) reject it:
- `'unsafe-inline'` on script-src = XSS defense-in-depth collapses.
- `rehype-sanitize` is the primary XSS backstop on Markdown, but
  defense-in-depth is a council non-negotiable on any auth-adjacent
  surface. `/auth` sets the Supabase session; any XSS there is a full
  account takeover.

### Why not per-request hashes?

Hashes of Next.js's Flight payload change every request (payload
includes timestamps, session-specific data). Recomputing SHA-256
per request is strictly worse than nonces: same security guarantee,
more CPU, harder to audit.

## Files changed

1. **`apps/web/middleware.ts`** *(new)*
   - Generates 16-byte nonce via `crypto.getRandomValues` → base64.
   - Builds CSP string with `'nonce-<value>' 'strict-dynamic'` in
     `script-src`. `'strict-dynamic'` lets nonced scripts transitively
     load the `_next/static/chunks/*.js` files without each chunk
     needing its own nonce — the modern CSP Level 3 pattern Next.js
     recommends.
   - Sets `x-nonce` on the *request* (so server components can read
     it if needed) and the `content-security-policy` header on the
     *response*.
   - Config: `matcher` excludes `_next/static`, `_next/image`,
     `favicon.ico`, and anything in `/api/inngest` (Inngest's webhook
     signing check shouldn't interact with our CSP). Include everything
     else.
   - Runtime: default (edge). Nonce generation is ~1µs; no measurable
     latency cost.

2. **`apps/web/next.config.js`** *(modified)*
   - Delete the static CSP block (lines 9-22 + the CSP entry in
     `async headers()`).
   - Keep the other response headers (`X-Content-Type-Options`,
     `Referrer-Policy`, `Permissions-Policy`) — those don't need
     per-request values, stay in `next.config.js`.

3. **`apps/web/middleware.test.ts`** *(new)*
   - Unit test: import the middleware default export, call with a mock
     `NextRequest`, assert:
     - Response has a `content-security-policy` header.
     - That header contains `script-src` with `nonce-` prefix and a
       base64-ish value of ≥22 chars.
     - That header contains `'strict-dynamic'`.
     - Two successive invocations produce different nonces
       (cryptographic randomness sanity check).
     - The request-side `x-nonce` header is set to the same value as
       the CSP nonce.
   - No Next.js server runtime required for this test — `NextRequest`
     is constructible from `vitest`.

4. **`apps/web/tests/unit/route-module-load.test.ts`** *(audit only)*
   - Existing regression test. Confirm no breakage: the module-load
     test already imports routes with scrubbed env; middleware isn't
     a route, won't affect it. No change expected.

## Verification plan

Pre-push (local):

1. `pnpm -r run typecheck` passes.
2. `pnpm -r run test` passes (new middleware test + existing tests).
3. `pnpm --filter web run lint` passes.
4. `env -i PATH="$PATH" HOME="$HOME" npx next build` inside
   `apps/web/` passes (same scrubbed-env trick used in PR #8 to catch
   `Collecting page data` bugs).

Post-deploy (production):

5. `curl -sI https://llmwiki-study-group.vercel.app/diag` shows a
   `content-security-policy` header with `nonce-` in `script-src`.
6. `curl -sL https://llmwiki-study-group.vercel.app/diag | grep -oE 'nonce="[^"]+"' | head` shows Next.js's inline scripts now carry the nonce.
7. Human visits `/diag` and `/auth` on their mobile device. Both
   render stably (no blank-out).
8. Human completes one magic-link sign-in end-to-end. Session lands;
   dashboard renders; upload button responds.

## Non-goals

- Removing `/diag`. Keep until (7) is confirmed on the user's
  device — issue #12 tracks its eventual removal in a follow-up PR.
- Any `/auth` code changes. Root cause is layout-layer, not `/auth`.
- Hardening `style-src` away from `'unsafe-inline'`. Tailwind emits
  inline styles at runtime; nonceing them is a separate plan with
  its own tradeoffs. Out of scope here.
- Refactoring `requireEnv` client-side. The previous handoff listed
  this as roadmap step 4. Since `requireEnv` is not the root cause,
  it's a pure code-quality improvement; defer to v1 or a dedicated
  plan. File issue if not already tracked.
- Adding Vercel Analytics or any third-party inline script. Would
  require CSP extensions with its own review.
- Any database / RLS / migration work.

## Non-negotiables (carry-over from CLAUDE.md)

- **Auth-adjacent security surface.** CSP on a page that sets a
  Supabase session cookie. Council security must-review. No
  `[skip council]` on this PR.
- **Nonce must be CSPRNG.** `crypto.getRandomValues` is the only
  correct primitive. `Math.random()` would be a critical bug.
- **Nonce must be per-request.** A module-level or ISR-cached nonce
  re-uses the same token across users / sessions → defeats the
  purpose. Generation must live inside the middleware function body,
  not outside it.
- **Middleware matcher must exclude static assets.** Matching
  `_next/static/*` would add CSP overhead to every chunk request
  and potentially break Vercel's edge cache for immutable assets.
- **`strict-dynamic` must be paired with the nonce**, not used as
  a standalone crutch. If `strict-dynamic` is present without a
  valid nonce, CSP-L2-only browsers (older Safari) fall back to
  `'self'` behaviour, which would re-trigger the blank-page bug on
  those clients. Mitigation: ship the nonce. The `'strict-dynamic'`
  is additive, not a substitute.

## Rollback

If deploy regresses anything:
- Revert the PR on `main` → CSP reverts to the current (broken-but-
  deployed) static version.
- User's symptom returns (blank page) but no new regressions
  introduced elsewhere — nothing outside this PR's three files
  changes.

Rollback path is clean because the change is self-contained:
middleware + next.config + one test.

## Cost posture

- Zero API calls added. No Claude / Gemini / Voyage / AssemblyAI /
  Reducto spend.
- One edge-function invocation per request (middleware). Vercel
  Hobby plan: 1M middleware invocations/month free. Well within
  budget for v0.

## Open questions for council

1. **Should middleware also scrub the cached Flight payload?**
   Vercel's edge cache can HIT the same HTML across users. If the
   HTML embeds the nonce and CSP is regenerated per request, an
   edge-cache HIT would serve stale HTML with an old nonce against
   a fresh CSP header — browser rejects the scripts again. Mitigation:
   either (a) set `Cache-Control: private, no-store` on responses
   passing through middleware (kills edge cache but safe), or (b)
   ensure the middleware runs on every edge cache miss + hit so CSP
   and HTML stay paired. Next.js 15's default is (b) — middleware
   runs on every request including cache hits, and the cached HTML
   is regenerated per-request when middleware adds headers. Worth
   council verification.

2. **Should `/api/inngest` be excluded from middleware?**
   Inngest's inbound webhook from their infrastructure does a
   signature check on the raw body; middleware shouldn't mutate
   the request or add Vary headers that break Inngest's signature
   verification. Proposed matcher excludes `/api/inngest`; council
   to confirm whether other `/api/*` routes also need exclusion
   (e.g., Supabase auth callback `/auth/callback`).

3. **Should we report CSP violations somewhere?**
   Adding `report-uri` / `report-to` would surface future CSP
   breakage before users hit blank pages. Out of scope for this
   PR (would need a new endpoint + storage), but worth a follow-up
   issue.

## Execution order (if approved)

Single batch — the three files are tightly coupled. No intermediate
push is safe:

1. Write `apps/web/middleware.ts`.
2. Edit `apps/web/next.config.js` (remove static CSP).
3. Write `apps/web/middleware.test.ts`.
4. Run full local verification (typecheck + test + lint + scrubbed-
   env next build).
5. Commit with `fix(web): per-request CSP nonce via middleware`.
6. Push. Council re-runs on the diff.
7. If council PROCEEDs on the diff, await human approval for merge.
8. After merge, verify (5)-(8) from §Verification plan.
9. Reflect in `.harness/learnings.md` (KEEP: curl-from-sandbox
   caught the CSP header; IMPROVE: should have caught this in the
   original CSP PR; INSIGHT: `unsafe-inline` vs nonce tradeoff
   for Tailwind vs Next.js inline scripts; COUNCIL: synthesis
   outcome).

## Why this is the right plan (not a premature abstraction)

- Smallest change that fixes the bug: three files, no new deps, no
  architectural shift.
- Uses the documented Next.js pattern — council won't flag this as
  a DIY reinvention.
- Reversible: one revert commit undoes the whole thing.
- No `[skip council]` shortcut: auth-adjacent security change, rules
  are rules.
- Does not bundle unrelated cleanup (`/diag` removal, `requireEnv`
  refactor, error-boundary hardening) into the fix. Those belong in
  their own plans per CLAUDE.md "Don't add features, refactor, or
  introduce abstractions beyond what the task requires."
