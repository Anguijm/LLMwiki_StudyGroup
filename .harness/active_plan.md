# Plan: fix auth callback flow (implicit → PKCE + cookie-writing adapter)

**Status:** draft, awaiting council + human approval.
**Branch:** `claude/plan-session-agenda-rRwWN`.
**Scope:** auth surface — non-negotiable council run required.
**P0:** without this, no user can complete sign-in.

## Problem

First real magic-link email sent after the PR #13/#16/#17 arc landed. The
email arrives correctly, but clicking the "Confirm" link redirects the
user back to `/auth` with the session tokens sitting in a URL fragment:

```
https://llmwiki-study-group.vercel.app/auth#access_token=<JWT>&expires_at=...&refresh_token=...&type=signup
```

Refreshing `/auth` shows the user still logged out. The session is never
persisted.

## Root cause (two bugs stacked)

1. **Flow mismatch — implicit vs PKCE.** Supabase is on the default
   `flowType: 'implicit'` (tokens in the URL fragment for client-side
   parsing). Our `/auth/callback` is written for PKCE (`?code=...` query
   param + server-side `exchangeCodeForSession`). The email also renders
   as "Confirm signup" rather than "Magic Link" — both templates can
   diverge in the Supabase dashboard and both need the PKCE redirect
   form.
2. **Cookie adapter is read-only.** `packages/db/src/server.ts:27-34`
   builds the server client with `@supabase/supabase-js`'s `createClient`
   and a Cookie-header string. It can READ cookies but has no way to
   WRITE `Set-Cookie` on the response. Even once PKCE is enabled and
   `/auth/callback?code=...` fires, `exchangeCodeForSession` succeeds
   against Supabase Auth and then drops the resulting session on the
   floor — no cookie is written, so the dashboard's "no session" guard
   bounces the user straight back to `/auth`.

Both must be fixed together; fixing either alone leaves the user
broken.

## Fix (TDD order, single PR)

### A. Failing integration test first

New file `apps/web/app/auth/callback/route.integration.test.ts`. Stubs
`exchangeCodeForSession` and asserts each branch:

- **Success:** 302 to `/`, with a `Set-Cookie` carrying `HttpOnly`,
  `Secure`, `SameSite=Lax`.
- **Already-used / expired / server error:** 302 to
  `/auth?error=<kind>` for `kind ∈ {token_used, token_expired,
  server_error}`. No `Set-Cookie`. No raw `code`, `access_token`, or
  `refresh_token` in any `console.error` output (assert via
  `vi.spyOn(console, 'error')`).
- **Missing / empty / whitespace `code`:** 302 to
  `/auth?error=invalid_request` before any Supabase call is made
  (assert the stub is not invoked).

### B. New cookie-writing factory in `packages/db/src/server.ts`

Rename the existing read-only `supabaseServer` → `createSupabaseClientForJobs`
(Inngest + cookie-less server contexts). Add
`createSupabaseClientForRequest(adapter)` using `@supabase/ssr`'s
`createServerClient` with a full `getAll` / `setAll` cookies adapter and
`flowType: 'pkce'`. Header comment in `server.ts` documenting when to
pick which — prevents a future consumer from silently re-using the
read-only factory on a cookie-writing surface (council's naming
concern).

Update all call sites (one-line import swap each).

Pin `@supabase/ssr` in `packages/db/package.json`; regenerate
`pnpm-lock.yaml`.

### C. Wire the Next.js adapter in `apps/web/lib/supabase.ts`

`supabaseForRequest()` calls `createSupabaseClientForRequest` with the
`next/headers` `cookies()` adapter. Wrap `setAll` in try/catch —
Server Components can't set cookies (Next throws), so the catch runs
there; route handlers and server actions write normally. On catch,
log at `debug` level with no cookie values (council bugs r1) so the
swallow isn't silent and a future maintainer misusing the adapter in
a Server Component can find it.

Debug log message must explicitly state the expected cause (council
security r2): `"supabase: setAll failed — expected in Server Component
context, ignoring"`. Never include cookie values or names in the log
line.

### D. Harden `apps/web/app/auth/callback/route.ts`

Catch `exchangeCodeForSession` failures explicitly. Map known Supabase
error shapes to kinds:

- consumed code → `token_used`
- expired code → `token_expired`
- 5xx / network → `server_error`
- 200 OK with `data.session: null` → `server_error` (council bugs r1)
- 200 OK with unparseable JSON body → `server_error` via the final
  catch-all (council bugs r2)
- any other thrown `Error` → `server_error` via a final catch-all so
  the route can never return a 500 (council bugs r1)

**Redirect rules (non-negotiable, council bugs r2):** the success
redirect destination is **hardcoded to `/`**. No query parameter
(including `redirect_to`, `next`, `returnTo`, or any other caller-
supplied value) may influence the destination URL. This closes the
open-redirect vector the bugs persona flagged.

**Input validation (defense-in-depth, council security r2):** before
invoking `exchangeCodeForSession`, validate the `code` param against a
plausible charset (URL-safe base64 alphabet: `[A-Za-z0-9_\-]`) and
length bound (reject `<16` or `>2048` chars). Fail to `invalid_request`.
This is belt-and-suspenders; Supabase also validates, but a malformed
code should never reach the network.

**Logging rules (non-negotiable):** never log `code`, `access_token`,
or `refresh_token` under any branch. Log only the error kind + a
sanitized Supabase error message. Redirect to `/auth?error=<kind>` on
every failure branch.

### E. Surface the error on `/auth/page.tsx`

Read `?error=` via `useSearchParams`; render an `aria-live="assertive"`
message with kind-specific copy selected by an **allowlist** (switch /
object map) on the parameter value. The raw query-param value is
NEVER rendered into the DOM — any unknown kind falls through to a
generic "Sign-in failed. Request a new link." message. This closes
the XSS vector the security persona flagged at r1.

Copy:

- `token_used` → "This sign-in link has already been used. Request a new one."
- `token_expired` → "This sign-in link has expired. Request a new one."
- `server_error` → "Could not sign you in right now. Please try again."
- `invalid_request` → "Sign-in link was invalid. Request a new one."
- any other value → "Sign-in failed. Request a new link."

Message text must meet **WCAG AA 4.5:1** contrast against its
background (a11y r1).

Form stays visible below the message so the user can request a fresh
link without extra clicks.

### F. Supabase dashboard (manual, pre-merge)

1. **Auth → URL Configuration → Redirect URLs allowlist:** only
   `https://llmwiki-study-group.vercel.app/auth/callback` plus any
   preview-URL pattern. No wildcards, no non-project origins.
   Complements PR #17's `APP_BASE_URL`-only server policy.
2. **Auth → Email Templates → Confirm signup AND Magic Link:** both
   must use `{{ .SiteURL }}/auth/callback?code={{ .TokenHash }}` (PKCE
   form). Default templates still carry the fragment form; both
   templates need editing.
3. Screenshot both sections; attach to the PR description as
   pre-merge verification.

### G. Runbook update

Add §F to `README.md` "Deploy runbook" so the dashboard steps are in
the checklist for any future environment.

## Test matrix

| Branch | Expected |
|---|---|
| valid `code`, stub returns session | 302 `/`, `Set-Cookie` HttpOnly+Secure+SameSite=Lax, `Path=/` |
| stub throws `token_used` | 302 `/auth?error=token_used`, no Set-Cookie |
| stub throws `token_expired` | 302 `/auth?error=token_expired`, no Set-Cookie |
| stub throws 5xx / network | 302 `/auth?error=server_error`, no Set-Cookie |
| stub returns 200 with `data.session: null` | 302 `/auth?error=server_error`, no Set-Cookie (council r1) |
| stub throws generic `Error` | 302 `/auth?error=server_error`, no Set-Cookie, no 500 (council r1) |
| missing `code` param | 302 `/auth?error=invalid_request`, stub NOT called |
| empty `code` | same as missing |
| whitespace-only `code` | same as missing |
| `code` >4KB | 302 `/auth?error=invalid_request`, stub NOT called (council r1) |
| `code` contains null byte / non-URL-safe chars | 302 `/auth?error=invalid_request`, stub NOT called (council r1) |
| `code` outside URL-safe base64 alphabet (e.g. `foo'bar"baz<qux>`) | 302 `/auth?error=invalid_request`, stub NOT called (council bugs r2) |
| `code` valid + extraneous `redirect_to=https://evil.com` | 302 to `/` (hardcoded), NOT to the supplied URL (council bugs r2 — open-redirect guard) |
| stub returns 200 with unparseable JSON body | 302 `/auth?error=server_error` via final catch-all (council bugs r2) |
| any failure branch | `console.error` spy sees no call whose args contain `code` / `access_token` / `refresh_token` (council r1) |

## Non-negotiables (inherited + council r1)

Pre-existing (PR #21 handoff):

- **No logging** of `code` or session tokens in any branch.
- **Pin** `@supabase/ssr`; lockfile updated.
- **Redirect URLs allowlist** locked to `APP_BASE_URL` pre-merge,
  screenshot in PR body.
- **Error surfacing** on `/auth` — no silent redirect.
- **Council required** on this surface. No `[skip council]`.
- **RLS unchanged.** Anon key only; no service-role exposure.

Added by council r1:

- **[security]** Integration test MUST `vi.spyOn(console, 'error')`
  and assert no call's arguments contain `code`, `access_token`, or
  `refresh_token` substrings under any failure branch. Single most
  important safeguard per the security persona.
- **[security]** `/auth/page.tsx` error rendering MUST use an
  allowlist (switch / object map) on the `error` query-param value.
  The raw param value is never rendered; unknown kinds fall through
  to a generic message. Closes the XSS vector.
- **[security]** Supabase dashboard screenshots (Redirect URLs
  allowlist AND both email templates on the PKCE redirect form) must
  be in the implementation PR body before merge.
- **[a11y]** Error message MUST meet WCAG AA 4.5:1 contrast against
  background. Verify at implementation.

Added by council r2:

- **[bugs]** Success-redirect destination is **hardcoded to `/`**.
  No caller-supplied query param (`redirect_to`, `next`, etc.) may
  influence the target URL. Tested by the extraneous-param row in
  the matrix above. Open-redirect guard.
- **[bugs]** Unparseable JSON from `exchangeCodeForSession` maps to
  `server_error` via the final catch-all; explicit test row required.

## Rollback

Revert the PR. User returns to current state: email delivers, sign-in
never completes. No additional regressions — this PR only touches the
auth callback + its server-client factory; it does not migrate schema
or change RLS.

## Out of scope for this PR

- Framework specialist persona (#18) — queued as next priority after
  this P0 lands.
- Playwright nonce smoke test (#20).
- `/diag` removal (#12), CSP `report-uri` (#14), `style-src`
  hardening (#15).
- **i18n of the new error strings.** Hard-coded English copy is
  acceptable for the P0 fix; externalization is a follow-up
  (council a11y r1 noted this as a nice-to-have, not a blocker).
- `pnpm audit` in CI. Council security r1 nice-to-have; separate
  issue if we want it.
- **`Set-Cookie` header exceeding browser max size.** Council bugs
  r2 flagged this as a theoretical failure mode (browser silently
  drops oversize cookies). Cookie name and size are controlled by
  `@supabase/ssr`, which splits large sessions into chunked cookies
  under the 4KB-per-cookie browser limit. Not mitigable in our code.
  If sessions routinely exceed limits, that's a Supabase-library
  issue to escalate — out of scope for this P0.
- Any v1 feature work.

## Success + kill criteria (council product r1)

- **Success metric:** count of 302s from `/auth/callback` to `/` per
  day (successful sign-ins). Track via existing server logs — no new
  telemetry infra.
- **Failure metric:** count of 302s from `/auth/callback` to
  `/auth?error=<kind>` bucketed by kind.
- **Kill criteria:** if total failure rate > 1% of sign-in attempts
  24h after merge, revert the PR.
- **Cost:** $0 marginal. Supabase Auth is MAU-billed, not per-call.

## Council history

- **r1** (PR #22 @ commit `1ae040f`, 2026-04-19T18:48:54Z) — PROCEED,
  a11y 8 / arch 10 / bugs 9 / cost 10 / product 10 / security 9. Four
  new non-negotiables folded into this plan.
- **r2** (PR #22 @ commit `ea3fc8a`, 2026-04-19T18:56:52Z) — PROCEED,
  a11y **9** / arch 10 / bugs 9 / cost 10 / product 10 / security 9.
  Five additions folded: open-redirect guard, unparseable-JSON test,
  special-char code test, debug-log wording, defense-in-depth
  charset/length validation on `code`. Full report:
  [PR #22 council comment](https://github.com/Anguijm/LLMwiki_StudyGroup/pull/22#issuecomment-4276576994).

## Approval checklist (CLAUDE.md gate)

Before writing implementation code, all three must be true:

1. This file is committed on `claude/plan-session-agenda-rRwWN` and
   pushed to origin.
2. A PR is open against `main`; the latest `<!-- council-report -->`
   comment from `.github/workflows/council.yml` was posted against a
   commit SHA ≥ the commit that last modified this plan.
3. The human has typed an explicit `approved` / `ship it` / `proceed`
   after seeing (1) and (2).

If any gate fails, stop and surface the gap.
