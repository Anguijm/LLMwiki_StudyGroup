# Session handoff: CSP + auth fix arc shipped, framework persona is next session's opener

## What landed this session

Three sequential PRs on `main` closing out the production blank-page →
dead-button bug:

| PR | Commit | Scope |
|---|---|---|
| **#13** | `eb707b0` | Per-request CSP nonce via `apps/web/middleware.ts`. Replaced static `script-src 'self'` (which blocked Next.js 15's inline Flight-payload scripts) with nonce + `'strict-dynamic'`. `Cache-Control: private, no-store, max-age=0` to prevent Vercel Edge serving stale HTML with mismatched nonces. Matcher excludes `/api/inngest` and `/auth/callback`. Removed `https://*.vercel.app` wildcard from `connect-src`. Council arc r1→r4 PROCEED. |
| **#16** | `ffec953` | `export const dynamic = 'force-dynamic'` on `apps/web/app/layout.tsx`. Per-request nonces can't stamp on prerendered HTML (baked at build time before middleware runs); layout-level `force-dynamic` forces every route to render per-request so Next.js reads `x-nonce` and stamps scripts correctly. Note: Next.js's layout-level `force-dynamic` overrides child `force-static`, so `/diag` is now dynamic too (acceptable — no DB calls, no interactivity). |
| **#17** | `f4fc657` | New rate-limited server-side `apps/web/app/api/auth/magic-link/route.ts`; client `/auth/page.tsx` now `fetch()`es it. `packages/db/src/browser.ts` reads `process.env.NEXT_PUBLIC_*` via literal property access (Next.js can't inline dynamic `process.env[name]`). New Tier C limiter in `@llmwiki/lib-ratelimit` (per-IP 5/hr, per-email 3/hr). Open-redirect protection (required `APP_BASE_URL`, no Host-header fallback). Email alias stripping in rate-limit key. UX hardening on `/auth` (pending state, aria-live regions, "Sending…" copy swap). Council arc r1→r4, two REVISEs (security at r2, bugs at r3) both folded in. |

Verified in prod via curl:
- CSP header carries per-request nonce.
- All `<script>` tags carry matching `nonce="..."` attributes.
- `/api/auth/magic-link` returns 400 on bad JSON, bad email shape,
  missing email, whitespace-only email, oversize email, missing
  `x-forwarded-for`.
- `APP_BASE_URL` confirmed set in Vercel All-Environments.
- Human tested the button: first deploy (post PR #17) response
  unverified as of handoff — user to confirm next session.

## Live bug at handoff (verified after merge)

**Symptom:** Magic-link email arrives and looks correct. Clicking the
"Confirm" link in the email redirects the user back to `/auth` with
the tokens in a URL fragment:

```
https://llmwiki-study-group.vercel.app/auth#access_token=<JWT>&expires_at=...&refresh_token=...&token_type=bearer&type=signup
```

Session is NOT persisted — refresh `/auth` and the user is still
logged out.

**Root cause (two separate bugs):**

1. **Flow mismatch — implicit vs PKCE.** Supabase is configured with
   the default `flowType: 'implicit'` (tokens posted to the URL
   fragment for client-side JS to parse). Our `/auth/callback`
   expects `flowType: 'pkce'` (a `?code=...` query param that the
   server exchanges via `exchangeCodeForSession`). `type=signup` in
   the fragment also indicates Supabase treated this as a
   first-time signup, not a returning magic-link sign-in — the
   "Confirm signup" template runs by default, not "Magic Link". The
   two templates can be configured separately in the Supabase
   dashboard.

2. **Cookie adapter is read-only.** Even once PKCE is enabled and
   `/auth/callback?code=...` gets hit, the existing `supabaseServer`
   factory (`packages/db/src/server.ts:27-34`) uses
   `@supabase/supabase-js`'s `createClient` with `persistSession:
   false` and a cookies-as-string input. It can READ the Cookie
   header but has no way to WRITE Set-Cookie on the response. So
   `exchangeCodeForSession` succeeds against Supabase Auth, gets a
   valid session back, and drops it on the floor. The user bounces
   right back to `/auth` via the dashboard's "no session → redirect
   to /auth" guard.

**Fix (all required; TDD order; one PR):**

A. **Write the failing integration test first.** New file
   `apps/web/app/auth/callback/route.integration.test.ts` that stubs
   `exchangeCodeForSession` and asserts, for each branch:
   - **Success:** response is a 302 to `/`, with a `Set-Cookie`
     header whose attributes include `HttpOnly`, `Secure`, and
     `SameSite=Lax`.
   - **Already-used / expired / network error:** response is a 302
     to `/auth?error=<kind>` (kind ∈ `token_used`, `token_expired`,
     `server_error`), NO Set-Cookie, NO session tokens or raw `code`
     value in any log output (assert via a vi.spy on `console.error`).
   - **No `code` / empty / whitespace `code`:** 302 to
     `/auth?error=invalid_request` before any Supabase call is made.

B. In `packages/db/src/server.ts`, add a new factory
   `createSupabaseClientForRequest(adapter)` that uses `@supabase/ssr`'s
   `createServerClient` with a full getAll/setAll cookies adapter and
   `flowType: 'pkce'`. Rename the existing `supabaseServer` to
   `createSupabaseClientForJobs` (read-only; used by Inngest and
   cookie-less server contexts) so a future consumer can't silently
   pick the read-only one for a cookie-writing surface — the council's
   naming concern. Update all call sites (one-line import swap each).
   Add a comment block at the top of server.ts explaining which
   factory to pick and why. Pin the new `@supabase/ssr` dependency
   version in `packages/db/package.json` + regenerate `pnpm-lock.yaml`.

C. In `apps/web/lib/supabase.ts`, have `supabaseForRequest()` use
   `createSupabaseClientForRequest` with the `next/headers`
   `cookies()` adapter. Wrap `setAll` in try/catch — Server Components
   can't set cookies; swallow the throw there and let route handlers
   + server actions write normally.

D. In `apps/web/app/auth/callback/route.ts`, explicitly catch
   `exchangeCodeForSession` failures. Map known Supabase error shapes
   to error kinds (`token_used` if the code was consumed,
   `token_expired` if the code is past TTL, `server_error` for
   5xx / network). DO NOT log the incoming `code` query parameter,
   the `access_token`, or the `refresh_token` under any branch. DO
   log the error kind + sanitized error message (Supabase error kind,
   no tokens). Redirect to `/auth?error=<kind>` on any failure.

E. In `apps/web/app/auth/page.tsx`, read the `?error=` query param
   (via `useSearchParams`) and render an `aria-live="assertive"`
   error message with a kind-specific copy:
   - `token_used` → "This sign-in link has already been used. Request a new one."
   - `token_expired` → "This sign-in link has expired. Request a new one."
   - `server_error` → "Could not sign you in right now. Please try again."
   - `invalid_request` → "Sign-in link was invalid. Request a new one."
   The form remains visible below so the user can request a fresh
   link without extra clicks.

F. In the Supabase dashboard:
   1. **Authentication → URL Configuration → Redirect URLs allowlist:**
      confirm it contains ONLY `https://llmwiki-study-group.vercel.app/auth/callback`
      + any preview-URL pattern. Remove any wildcards or non-project
      origins. This is the open-redirect guard that complements the
      server-side `APP_BASE_URL`-only policy in PR #17's magic-link
      route.
   2. **Authentication → Email Templates → Confirm signup + Magic
      Link:** both must use the PKCE redirect URL format,
      `{{ .SiteURL }}/auth/callback?code={{ .TokenHash }}`. Default
      templates send tokens in the URL fragment; PKCE requires the
      code-query form. Verify and fix both templates.
   3. Screenshot both dashboard sections and attach them to the PR
      description as the pre-merge verification.

G. Update `README.md` "Deploy runbook" with the §F dashboard steps so
   the checklist catches this in future environments.

**Rollback:** Revert the PR. User is back to current state (email
delivers, but sign-in never completes). No additional regressions.

**Why this was never caught until now:** The magic-link button itself
was broken all session (PRs #13 → #17 were fixing the send side).
This is the FIRST successful magic-link email we've ever sent, so the
callback flow has been untested since v0 scaffold (PR #5).

## Non-negotiables for the next session's fix PR

Council r1 on PR #21 spelled these out explicitly; re-stated here so
the fix PR's plan can mark them as already-inherited constraints:

- **No logging of `code` or session tokens.** Server-side logs must
  redact both under every branch.
- **Pin the `@supabase/ssr` version.** New dependency, lockfile must
  reflect the pinned version.
- **Supabase Redirect URLs allowlist** locked to `APP_BASE_URL`
  before merge. Screenshot attached to PR description.
- **Callback errors surface as user-facing messages**, not silent
  redirects.
- **Auth surface → council required.** No `[skip council]`.

## Next session's opener (priority order)

### 1. Fix the callback flow (implicit → PKCE + cookie adapter)

See §Live bug at handoff above for the full diagnosis. This is the
P0: without it, no user can complete a sign-in. Fix is auth surface
→ plan + council required. Scope ~30-50 LoC across two files plus a
Supabase dashboard config change.

### 2. Framework specialist council persona (issue #18)

**Why:** Three sequential PRs this session all landed on
Next.js / Vercel framework-boundary issues (static vs dynamic rendering;
middleware vs prerender timing; client-bundle inlining semantics). The
existing six personas (a11y, arch, bugs, cost, product, security) reason
about general code quality, not framework-specific footguns. Adding a
seventh persona collapses the three-PR arc into one. Would ideally
also catch the callback bug above before it hits production.

Draft `.harness/council/framework.md` covering:
- App Router static vs dynamic (`○` vs `ƒ`) and how it interacts with
  middleware / cookies / headers / CSP.
- Build-time vs runtime `process.env` access (literal vs dynamic).
- Edge runtime vs Node.js runtime differences.
- Hydration error reach (async / pre-hydration failures bypass
  `error.tsx`).
- RSC / Flight payload flow and inline-script nonce stamping.
- Cache-Control × Vercel Edge interaction.
- `NEXT_PUBLIC_` prefix semantics (the "accidental client secret"
  class).
- Server Component vs Client Component module-graph implications
  (`server-only`, `'use client'`).

Include an explicit escape hatch: "if this diff does not touch
Next.js / Vercel / React-server semantics, return `Score: 10` and
`No framework concerns.`" — mitigates noise on DB migrations, pure
styling changes, etc.

Plan → PR → council r1 (the persona file is the thing being reviewed,
so r1 will be self-referential but that's fine) → human approval →
merge. `council.py` glob already scans `.harness/council/*.md` so no
wiring change needed.

### 3. Complete the sign-in → dashboard round trip

Once the button works:
- Click magic link in email.
- Land on `/auth/callback` (redirect-only route, excluded from
  middleware).
- Session cookie set; redirect to `/`.
- Dashboard renders (cohort upsert, notes list, ingestion jobs).
- Test a PDF upload end-to-end.

This is the first real smoke test of the v0 vertical slice shipped
in PR #5. If anything breaks on this path, it's the first real bug
since the auth-flow blocker.

## Open issues queued by this session

- **#18** — Framework persona (above; next session's #1).
- **#19** — Five PR #17 council r4 nice-to-haves: client `AbortSignal`
  timeout, null-byte email test, case-variant bucket test, multi-IP
  XFF test, serial IP→email rate check.
- **#20** — Playwright nonce smoke test. Would have prevented the
  PR #17 dead-button bug if it had existed.
- **#14** — CSP `report-uri` endpoint.
- **#15** — `style-src` hardening (remove `'unsafe-inline'`).
- **#12** — `/diag` removal + error-boundary production hardening.
  Now that the full fix arc is green, `/diag` can be deleted.
  Low-effort cleanup.
- **#7** — `db-tests` pgTAP flake (still `continue-on-error`).
- **#6** — Storage RLS metadata refactor (v0 deferral).

## Non-goals for next session

- Feature work (v1 kickoff waits for confirmed end-to-end sign-in
  + a PDF upload smoke test).
- Merging any of the open issues above without their own plan +
  council round.
- Re-opening the CSP nonce design.

## Opening protocol (per CLAUDE.md)

1. Read `.harness/session_state.json`.
2. Read last ~20 lines of `.harness/yolo_log.jsonl`.
3. Read the 2026-04-19 16:55 UTC block in `.harness/learnings.md`.
4. Read this plan (§Next session's opener).
5. Human will provide the end-to-end sign-in test result.
6. If sign-in works → go to roadmap item #1 (framework persona).
7. If sign-in fails → diagnose via Vercel Runtime Logs + `[magic-link]`
   server-side error lines before spinning new council.
