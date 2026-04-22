# Plan: stale-link classification fix — mapSupabaseError regex + redirect-error channel (issue #30)

**Status:** draft, awaiting council + human approval.
**Branch:** `claude/issue-30-stale-link-classification`.
**Scope:** auth surface — non-negotiable council run required. No `[skip council]`.
**Priority:** P1 follow-up from PR #27's B.2 smoke test. Non-blocking for any other work but user-visible every time a stale magic link gets re-clicked.

## Problem

PR #27 smoke test B.2 (2026-04-22 04:37 UTC) demonstrated: clicking a consumed magic link produces `/auth?error=server_error` with the copy *"Could not sign you in right now. Please try again."* That copy is literally wrong — the PKCE code was consumed, so "try again" (re-click) produces the exact same failure. The correct recovery action is request a NEW link.

Evidence in `.harness/evidence/pr-27/07-smoke-b2-auth-page-error-copy.jpg` and `08-smoke-b2-supabase-auth-logs.jpg`. Supabase Auth log shows `/verify | 403: Email link is ...` at 04:37:55 UTC — the 403 happened upstream of our callback. Our callback received whatever Supabase redirected to and classified the result as `server_error` through one of three possible paths below.

## Root cause (three possible channels; all three should be handled)

The Supabase `/verify` 403 can land in our callback via at least three routes, and without reproducing the exact request in staging it's unclear which one fired:

### Channel A — error query param, no `code`
Supabase redirects to `/auth/callback?error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired`. Our current handler calls `validateCode(null)` → returns `invalid_request` → user sees *"Sign-in link was invalid. Request a new one."*

**Symptom check:** copy would be `invalid_request`, not `server_error`. Not a match for B.2 unless validation logic had a bug we haven't identified.

### Channel B — stale `code` param, exchange throws
Supabase redirects with a code that doesn't resolve to a flow_state. `exchangeCodeForSession` throws an error whose message includes "Email link is invalid or has expired" or similar. Our `mapSupabaseError` regex (`/\balready\b.*\bused\b|consumed|used_otp|invalid_grant/` → `token_used`, `/expired|otp_expired/` → `token_expired`) should match "expired" and return `token_expired`. **But observed copy was `server_error`, so this path isn't the one either** — OR the error message came through in a different shape (e.g., wrapped in a generic `Error`) that bypassed the regex.

### Channel B' — stale `code` param, exchange returns `{ data: { session: null }, error: null }`
The most likely actual path. The stale code passes Supabase's server-side checks but resolves to no flow_state row. Supabase returns 200 OK with `data.session = null` and `error = null` — no error object for the regex to match. Our `!data?.session` branch at `apps/web/app/auth/callback/route.ts:203-206` unconditionally maps this to `server_error`. **Matches the observed copy.**

## Fix (belt and suspenders; all three channels handled)

### A. Handle Channel A — redirect error-param classification

Before `validateCode`, check if the URL has an `error` query param. Extract `error`, `error_code`, and `error_description`; classify via a new `mapRedirectError` function that applies the same string-matching rules `mapSupabaseError` uses but on `error_description` instead of an `Error.message`. Fall back to `server_error` if nothing matches. No new ErrorKind values.

```ts
function mapRedirectError(params: URLSearchParams): ErrorKind | null {
  const err = params.get('error');
  if (!err) return null;
  const code = params.get('error_code') ?? '';
  const desc = (params.get('error_description') ?? '').toLowerCase();
  // otp_expired / flow_state_expired / magic_link_expired
  if (/otp_expired|flow_state_expired|magic.link.expired/.test(code)) return 'token_expired';
  if (/expired|link.*expired/.test(desc)) return 'token_expired';
  // access_denied (generic) with "already used" / "consumed" / "invalid"
  if (/\balready\b.*\bused\b|consumed|used_otp|invalid_grant/.test(desc)) return 'token_used';
  if (/email.*link.*invalid/.test(desc)) return 'token_used';
  return 'server_error';
}
```

Call site: immediately **after the rate-limit gate** and **before `validateCode`**, in the callback handler. Ordering matters — when Supabase redirects with `?error=...` and no `code`, `validateCode(null)` would short-circuit to `invalid_request` before `mapRedirectError` ever ran. Council r1 security flagged this explicitly as a non-negotiable. If `mapRedirectError` returns non-null, skip `validateCode` + `exchangeCodeForSession` entirely and go straight to the error redirect.

### B. Extend Channel B — regex for additional wordings

Broaden `mapSupabaseError` to cover Supabase PKCE error message variations observed in the wild:

```ts
function mapSupabaseError(err: { message?: string; status?: number; code?: string } | null): ErrorKind {
  if (!err) return 'server_error';
  if (typeof err.status === 'number' && err.status >= 500) return 'server_error';
  const msg = (err.message ?? '').toLowerCase();
  const code = (err.code ?? '').toLowerCase(); // NEW: some Supabase versions expose a stable `code` field
  // Token-used class
  if (/otp_used|used_otp|invalid_grant/.test(code)) return 'token_used';
  if (/\balready\b.*\bused\b|consumed|used_otp|invalid_grant/.test(msg)) return 'token_used';
  if (/email.*link.*invalid|no.*valid.*flow.*state/.test(msg)) return 'token_used';
  // Token-expired class
  if (/otp_expired|flow_state_expired/.test(code)) return 'token_expired';
  if (/\bexpired\b|otp_expired/.test(msg)) return 'token_expired';
  return 'server_error';
}
```

Key additions:
- `err.code` lookup (when Supabase exposes a stable error code, prefer it over substring matching).
- `email.*link.*invalid` pattern for the "Email link is invalid or has expired" case — specifically whichever substring the `/token` endpoint returns.
- `no.*valid.*flow.*state` pattern — the exact string observed in PR #27's smoke test diagnosis when a stale code was passed to `exchangeCodeForSession`.

### C. Handle Channel B' — null-session as probable stale link

Change the `!data?.session` branch from unconditional `server_error` to a best-effort `token_used` classification, scoped narrowly:

```ts
} else if (!data?.session) {
  // Supabase returned 200 OK with no session and no error object. In
  // practice the dominant cause is a stale PKCE code that resolved to
  // no flow_state row (exact B.2 smoke test path). Classify as
  // token_used so the user gets actionable copy ("Request a new one.")
  // rather than misleading retry copy ("Please try again.").
  //
  // Trade-off (documented + expected council review point): the rare
  // case of a genuine null-session response from Supabase (e.g., a
  // Supabase bug, a transient issue) would be mis-labeled as
  // token_used. Acceptable because the recovery action is identical —
  // request a new link — and the copy "This sign-in link has already
  // been used" is an honest approximation of "this sign-in link won't
  // work; get a new one." If the alternative copy is ever deemed
  // important enough, add a dedicated `stale_link` ErrorKind (not in
  // this PR).
  failureKind = 'token_used';
}
```

Documented trade-off. Council will weigh it.

### D. Tests (TDD order — failing tests before impl)

New / extended rows in `apps/web/tests/unit/auth-callback-route.test.ts`:

Channel A (redirect error-param):
- `?error=access_denied&error_description=Email+link+is+invalid+or+has+expired` → 307 `/auth?error=token_used`, stub NOT called.
- `?error=access_denied&error_code=otp_expired` → 307 `/auth?error=token_expired`, stub NOT called.
- `?error=server_error&error_description=database+unavailable` → 307 `/auth?error=server_error`.
- `?error=<empty>` → falls through to normal code validation (current behavior).
- `?error=some_unknown_code&error_description=garbage` → `server_error` fallback.

Channel B (regex extension):
- `exchangeCodeForSession` rejects with message containing "Email link is invalid or has expired" → `token_used`.
- `exchangeCodeForSession` rejects with message containing "no valid flow state found" → `token_used`.
- `exchangeCodeForSession` returns error with `code: 'otp_expired'` → `token_expired`.
- `exchangeCodeForSession` returns error with `code: 'invalid_grant'` → `token_used`.

Channel B' (null-session reclassification):
- `exchangeCodeForSession` returns `{ data: { session: null }, error: null }` → `token_used` (**behavior change**; previously `server_error`).
- Regression: existing "maps a 200 OK with data.session: null to ?error=server_error" test must be UPDATED to `token_used` expectation — explicit test-matrix change documented in the commit.

All existing token-leakage guard rows continue to hold. The new redirect-error path must also be spy-checked.

### E. Optional diagnostic improvement (NOT in this PR)

The IMPROVE line from PR #27's reflection noted: log a sanitized `error.name` + `error.status` + first 80 chars of message when the classification lands on `server_error`, so future incidents surface the actual upstream copy without a Supabase-dashboard round trip. **Deferred to a follow-up diagnostic ticket** to keep this PR focused on UX correction. File after merge.

## Test matrix

| Channel | Input | Expected | Notes |
|---|---|---|---|
| A | `?error=access_denied&error_description=Email link is invalid or has expired` | 307 `?error=token_used` | stub NOT called |
| A | `?error=access_denied&error_code=otp_expired` | 307 `?error=token_expired` | stub NOT called |
| A | `?error=server_error&error_description=database+unavailable` | 307 `?error=server_error` | stub NOT called |
| A | `?error=` (empty string) | falls through | existing validation applies |
| A | `?error=unknown_code&error_description=garbage` | 307 `?error=server_error` | stub NOT called |
| B | exchange rejects with msg containing "Email link is invalid or has expired" | 307 `?error=token_used` | |
| B | exchange rejects with msg containing "no valid flow state found" | 307 `?error=token_used` | |
| B | exchange returns error `{ code: 'otp_expired' }` | 307 `?error=token_expired` | new `code` field lookup |
| B | exchange returns error `{ code: 'invalid_grant' }` | 307 `?error=token_used` | |
| B' | exchange returns `{ data: { session: null }, error: null }` | 307 `?error=token_used` | **behavior change from server_error** |
| — | all failure branches | `console.error` spy sees no `code` / `access_token` / `refresh_token` substring | |

## Non-negotiables (inherited + new)

Inherited from PR #22 / #28 / #29:
- **No logging** of `code`, `access_token`, or `refresh_token` under any branch. Test suite spy enforces.
- **`/auth` allowlist rendering** (unchanged) — raw `?error=<value>` never interpolated; unknown values fall through to the generic message.
- **Hardcoded success redirect** to `/` (unchanged).
- **RLS unchanged.** Anon key only.
- **Council required.** No `[skip council]`.

New in this plan:
- **`!data?.session` reclassification to `token_used`** is a behavior change — explicitly documented trade-off. Council will review.
- **Query-param error handling** happens BEFORE `validateCode` so a URL with both `?error=...` and `?code=...` prefers the error path (indicates Supabase already rejected; no point calling `exchangeCodeForSession`).

## Rollback

Revert the PR. Behavior returns to current state: stale link → `server_error` copy. No schema / RLS / dependency change.

## Out of scope

- Adding a dedicated `stale_link` ErrorKind with copy like *"This sign-in link is no longer valid. Request a new one."* — considered and rejected for this PR. The existing `token_used` copy is an acceptable approximation; adding a kind increases the `/auth` page allowlist surface and the `CALLBACK_ERROR_MESSAGES` map for marginal copy improvement.
- Logging sanitized upstream error details on `server_error` fallthrough (diagnostic improvement from PR #27 reflection IMPROVE). Deferred — file as follow-up issue after this PR merges.
- Issue #32 (Set-Cookie rollback header assertion) — separate test-harness upgrade, independent of this fix.
- i18n of the existing allowlist copy. Explicitly deferred across all auth PRs.
- Migrating to `verifyOtp` primitive (Fix B architectural change) — would eliminate the `/verify` error-redirect channel entirely but is a full re-architecture, not scope.

## Success + kill criteria

- **Success metric:** after merge + smoke-retest, clicking a consumed magic link produces `/auth?error=token_used` with copy *"This sign-in link has already been used. Request a new one."* OR `?error=token_expired` with equivalent copy — NEVER `server_error`.
- **Failure metric:** count of fresh-link sign-ins (first click) that redirect to `/auth?error=token_used` instead of `/` — should stay at zero. Classification false-positives would indicate the null-session reclassification is too aggressive.
- **Kill criteria:** revert if fresh-link sign-in success rate drops by >0.1% in the 48h post-merge window. Monitor via Vercel log count of `[auth/callback] sign-in failed { kind: 'token_used' }` against total `/auth/callback` hits.
- **Cost:** $0 marginal. No new API calls.

## Council history

- **r1** (plan @ `d30f7cf`, 2026-04-22T08:45Z) — PROCEED 9/10/9/10/9/10. Two folds:
  - Call-site ordering clarified: `mapRedirectError` runs BEFORE `validateCode`, not after (council security non-negotiable). Plan wording was internally inconsistent; fixed.
  - Diagnostic-logging follow-up filed as an issue before impl begins (council step 5).
  No scope changes; three-channel approach explicitly accepted over the smaller null-session-only alternative.

## Approval checklist (CLAUDE.md gate)

Before writing implementation code, all three must be true:

1. This file is committed on `claude/issue-30-stale-link-classification` and pushed to origin.
2. A PR is open against `main`; the latest `<!-- council-report -->` comment from `.github/workflows/council.yml` was posted against a commit SHA ≥ the commit that last modified this plan.
3. The human has typed an explicit `approved` / `ship it` / `proceed` after seeing (1) and (2).

If any gate fails, stop and surface the gap.
