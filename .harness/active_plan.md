# Plan: auth hardening — transactional cookie-write + rate-limit fail-open alerting (issue #26)

**Status:** draft, awaiting council + human approval.
**Branch:** `claude/issue-26-auth-hardening`.
**Scope:** auth surface — non-negotiable council run required. No `[skip council]`.
**P0:** council r2 on PR #25 explicitly designated #26 as top-priority; its kill criterion was "the next session begins with a task other than the P0-designated issue #26."

## Problem

Two shipped-code bugs that council r1 on PR #25 flagged via reflection review of PR #22 (`e9fc1b4`):

1. **`setAll` in `apps/web/lib/supabase.ts` is best-effort in an auth context.** The adapter's `setAll` iterates `cookiesToSet`, catches per-write failures, discriminates expected RSC read-only throws (swallow) from unexpected throws (accumulate), and emits a single post-loop summary log for the unexpected ones. For non-auth batch writes that pattern is fine. For session-cookie writes it is not: if one chunk fails and the rest succeed, the route handler's success branch still redirects to `/`, the browser holds a partial/invalid session, the next request bounces through the auth guard back to `/auth`, and the user sees a silent failure after clicking a valid link.

2. **Tier D rate limiter (`packages/lib/ratelimit/src/index.ts` → `makeAuthCallbackLimiter`) fails open silently on Upstash outage.** Fail-open is the correct tradeoff (a Redis blip must not 503 a legitimate magic-link click); silence is not. If Upstash stays down, the `/auth/callback` DOS guard is gone with zero visibility and no future monitor can alert on it. Council security r2 on PR #25: *"A silently disabled control is not a control."*

Plus three edge cases the council surfaced on PR #25 r2 that must be covered in the same PR:

3. **Double-click / mail-client prefetch** — Outlook Safe Links and similar consume the single-use PKCE code before the user clicks; the second request hits `exchangeCodeForSession` with a consumed code and should cleanly map to `token_used`. `mapSupabaseError` already targets this (`/\balready\b.*\bused\b|consumed|used_otp|invalid_grant/`), but the code path has no explicit test and no prefetch-as-first-GET scenario exists in the suite.

4. **Supabase 200 OK with missing / malformed session payload** — Today this maps to `server_error` via the `!data?.session` branch. Council r2 suggested either (a) adding a dedicated `exchange_failed` error kind, or (b) documenting the explicit decision to keep the mapping. This plan chooses **(b): keep `server_error`**. Rationale: `server_error` copy ("Could not sign you in right now. Please try again.") correctly invites a retry, which is the right user action for any "Supabase replied but something's off" case — whether the session is null, the body is malformed, or a generic Error was thrown. Splitting into `exchange_failed` adds a user-facing kind that produces identical copy, leaks Supabase internals into our error taxonomy, and expands the `/auth` allowlist for no user benefit. Documented at the `!data?.session` branch in `route.ts` so the non-choice is explicit.

5. **Cross-tab auth state sync** — Explicitly out of scope per the issue; tracked separately.

## Root cause

Both code bugs trace to reasonable-at-the-time decisions that didn't anticipate the auth failure mode:

- The `setAll` accumulator pattern was written assuming best-effort is acceptable because the RSC case dominates. It isn't — Route Handlers and Server Actions both call through this adapter, and for those a partial write IS a real failure.
- The rate-limiter fail-open was chosen deliberately (`reserve`'s internal docstring: *"a transient Redis outage must not deny a legit user's link-click"*). The design was correct; the observability affordance was missed.

## Fix (TDD order, single PR)

### A. Failing tests first

New and extended tests in `apps/web/lib/supabase.test.ts`, `apps/web/tests/unit/auth-callback-route.test.ts`, and `packages/lib/ratelimit/src/index.test.ts` (new file if it doesn't exist). Run before any implementation; all must fail against current `main`.

**`apps/web/lib/supabase.test.ts`** — extend existing suite:

- RSC read-only throw from `store.set` → `setAll` returns normally; `getCookieWriteFailure()` returns `null`; no `console.error` call.
- Unexpected throw on cookie #2 of 3 → `getCookieWriteFailure()` returns `{ errorName: <throw.name> }`; `getWrittenCookieNames()` returns only cookie #1's name (successful write BEFORE the failure); no further writes attempted after the failure (assert via call count on a spy `store.set`).
- Multiple unexpected throws → first unexpected error name is reported; subsequent writes are NOT attempted (transactional halt).
- Existing partial-write summary-log behavior should be REMOVED (`console.error` is no longer called from setAll — rollback is now the caller's job).

**`apps/web/tests/unit/auth-callback-route.test.ts`** — extend:

- `cookie_failure` branch: stub `exchangeCodeForSession` to succeed AND stub the cookie adapter to produce a non-RSC failure → 307 to `/auth?error=cookie_failure`; any cookie successfully written during the transaction is deleted (assert via `store.delete` spy or a Set-Cookie with expired `Max-Age=0`); `console.error` never sees the code, `access_token`, `refresh_token`.
- `token_used` via double-click / mail-client prefetch (council security r1 must-do): simulate two sequential `GET` calls to the route handler with the SAME code — the first returns a session (302 `/`), the second hits `exchangeCodeForSession` which throws a Supabase error whose message contains `already.*used` → second response is 307 `/auth?error=token_used`, no `Set-Cookie` on the second response. This is an integration-style test of the full route flow, not a direct stub of the `token_used` path.
- **Rollback-fail edge case** (council bugs r1): stub the cookie adapter to fail AND stub `cookies().delete` on the rollback path to throw → the route's final catch-all runs, returning a 500 (NextResponse behavior) rather than a 307. Explicit behavior documentation: a failure-within-a-failure-handler is allowed to 500 because the user is already on a degraded path and 500 is greppable; swallowing the secondary throw would hide the bug. Assert status 500 and no token substrings in `console.error`.
- **Proxy passthrough** (council security r1 top-risk #1): assert that accessing a symbol property (`client[Symbol.iterator]`) and a non-existent string property (`client.__nonexistent__`) returns whatever the underlying Supabase client returns (usually `undefined` for non-existent; whatever `Reflect.get` yields for symbols). Covers the blast-radius concern that a bad Proxy handler could break unrelated auth calls.
- Regression: missing / empty / whitespace code branches still land at `invalid_request` after the refactor.

**`packages/lib/ratelimit/src/index.test.ts`** — new or extended:

- `makeAuthCallbackLimiter().reserve(ip)` when the underlying `limiter.limit` throws (string IP) → resolves without error (fail-open preserved) AND `console.error` was called with an object arg containing `{ alert: true, tier: 'auth_callback_ip', errorName: <name>, ip_bucket: <first-3-chars-of-ip> }`.
- **PII substring guard** (council security r1 must-do): under the fail-open branch, spy on `console.error` and assert that the RAW `ip` string is NOT a substring of ANY argument to ANY call — stringify objects via `JSON.stringify` + scan. Stronger than "ip not passed directly": this catches a future refactor that accidentally includes `ip` inside a nested debug key.
- `reserve(undefined)` + `limiter.limit` throws → resolves; `ip_bucket === 'unknown'`; no `TypeError`.
- `reserve(null)` + `limiter.limit` throws → resolves; `ip_bucket === 'unknown'`; no `TypeError`.
- `reserve('')` + `limiter.limit` throws → resolves; `ip_bucket === 'unknown'`; no `TypeError`.
- Happy-path (`limit` resolves `success: true`) → resolves; no `console.error`.
- Over-limit (`limit` resolves `success: false`) → throws `RateLimitExceededError('auth_callback_ip', ...)`; no `console.error`.

### B. Transactional `setAll` in `apps/web/lib/supabase.ts`

Change the factory return shape from `SupabaseClient` to a discriminated object. Two new exported helpers on the returned object expose the adapter's transactional state to the caller:

```ts
interface CookieWriteState {
  getCookieWriteFailure(): { errorName: string } | null;
  getWrittenCookieNames(): readonly string[];
}

export async function supabaseForRequest(): Promise<
  SupabaseClient & CookieWriteState
> { … }
```

**Method names are STABLE across the plan.** Council arch r1 flagged an
inconsistency in the first draft (interface used `getWrittenCookieNames`,
Proxy example used `getCookieWriteNames`). Single source of truth, used
by every reference in this document and every test assertion:

- `getCookieWriteFailure(): { errorName: string } | null`
- `getWrittenCookieNames(): readonly string[]`

Behaviorally:

- Keep the existing RSC read-only discriminator (`/cookies.*modif|server\s*action|route\s*handler/i`). That branch silently returns, same as today.
- On an UNEXPECTED throw, record `{ errorName }` on a closure-scoped `failure` variable AND **stop iterating** further cookies. This is the transactional part: no partial writes after a failure.
- On a successful `store.set`, push the cookie name into a `writtenNames` array.
- Expose `getCookieWriteFailure()` (reads `failure`) and `getWrittenCookieNames()` (snapshot copy of `writtenNames`) on the returned object.
- DELETE the post-loop `console.error` summary log. Rollback is now the caller's job; the adapter is quiet on both happy and sad paths (the caller logs on rollback).
- Callers that DON'T care about cookie-write transactionality (dashboard, note page, magic-link route, ingest route) ignore the new methods — zero-behavior-change refactor for them. They get the returned client as before via the spread.

**Attach via Proxy, not by mutating the Supabase client.** `createSupabaseClientForRequest` returns a `SupabaseClient` from `@supabase/ssr`; adding properties to that object risks clobbering library internals across version bumps. Instead wrap it:

```ts
return new Proxy(client, {
  get(target, prop, receiver) {
    if (prop === 'getCookieWriteFailure') return () => failure;
    if (prop === 'getWrittenCookieNames') return () => [...writtenNames];
    return Reflect.get(target, prop, receiver);
  }
});
```

Proxy avoids any collision with Supabase's surface. The handler intercepts
only our two sentinel property names (string keys); every other access —
including `Symbol.iterator`, `Symbol.toPrimitive`, `then` (Supabase client
is thenable-free but future versions might add), and any unknown property
— flows through `Reflect.get` unchanged. Council security r1 top-risk
#1: the test suite must exhaustively assert that symbol properties and
non-existent properties reach the underlying client (see test matrix row
"proxy — symbol + unknown key passthrough").

### C. Rollback path in `apps/web/app/auth/callback/route.ts`

After `exchangeCodeForSession` returns (or throws), BEFORE the success redirect, call `supabase.getCookieWriteFailure()`. If non-null:

1. Iterate `supabase.getCookieWriteNames()` and for each name, call `(await cookies()).delete(name)`. This clears any partially-written session cookies from the current response.
2. `console.error('[auth/callback] sign-in failed', { kind: 'cookie_failure', errorName: failure.errorName })`. Token-leak guard still applies — `errorName` is a class name, never a value.
3. 307 to `/auth?error=cookie_failure`.

Ordering nuance: a failure on cookie #1 means `writtenNames` is empty and the rollback loop is a no-op — correct. A failure mid-stream means we clear the cookies we did write. The route MUST check `getCookieWriteFailure()` AFTER `exchangeCodeForSession` regardless of whether that call succeeded or threw — a throw from setAll bubbles up as a generic Error through the supabase call, and the existing catch-all would currently mis-map it to `server_error`. We want `cookie_failure` precedence.

Concretely: in the `try { exchangeCodeForSession } catch (err) { … }` block, add a pre-check in the `catch` branch:

```ts
} catch (err) {
  const failure = supabase.getCookieWriteFailure?.();
  if (failure) {
    // Rollback + redirect flow below.
  } else {
    console.error('[auth/callback] unexpected exchange failure', {
      kind: 'server_error',
      errorName: err instanceof Error ? err.name : typeof err,
    });
    failureKind = 'server_error';
  }
}
```

And on the success path (after the try/catch):

```ts
if (failureKind === null) {
  const failure = supabase.getCookieWriteFailure?.();
  if (failure) {
    failureKind = 'cookie_failure';
    console.error('[auth/callback] sign-in failed', {
      kind: 'cookie_failure',
      errorName: failure.errorName,
    });
    // rollback below
  }
}
```

Centralize rollback: one helper `rollbackPartialCookies(supabase)` called before the error-redirect `return`.

`ErrorKind` union gets a new `'cookie_failure'` member; `mapSupabaseError` does NOT emit it (cookie_failure is not a Supabase-origin error kind).

### D. `/auth` page copy for `cookie_failure`

`apps/web/app/auth/page.tsx` — add to `CALLBACK_ERROR_MESSAGES`:

```ts
cookie_failure: "We couldn't save your sign-in. Request a new link.",
```

**Copy choice (council bugs r1):** the first-draft copy ("Please try
again") is misleading because the PKCE code was successfully consumed
during the exchange — clicking the same link a second time will map to
`token_used`, not retry. The user's actual recovery action is to request
a NEW magic link. This copy matches the sibling messages' cadence
("Request a new one." / "Request a new link.") and tells the user what
to do without implying "just click again."

Contrast still meets WCAG AA 4.5:1 — uses the same `text-danger` class
as existing entries. The existing `aria-live="assertive"` region
announces it automatically; no wiring change. Unknown kinds continue to
fall through to `GENERIC_CALLBACK_ERROR` (XSS allowlist semantics
preserved).

### E. Fail-open alerting in `packages/lib/ratelimit/src/index.ts`

Change `makeAuthCallbackLimiter().reserve` to log on the fail-open branch:

```ts
async function reserve(ip: string | null | undefined): Promise<void> {
  let result: Awaited<ReturnType<typeof limiter.limit>>;
  try {
    result = await limiter.limit(ip ?? 'no-xff');
  } catch (err) {
    // Fail-OPEN by design — a transient Upstash outage must not deny a legit
    // link-click. But a SILENTLY disabled DOS guard is worse than no guard;
    // a future monitor will grep for `alert: true, tier: 'auth_callback_ip'`
    // in log drain and page the on-call. Shape is stable — do not rename
    // these keys without a search across monitoring config.
    //
    // ip_bucket uses ?. + ?? so a missing header can't throw TypeError and
    // swallow the alert entirely (council bugs r1 top bug — a TypeError
    // here would make fail-open silent again, re-introducing the very gap
    // this plan is closing).
    // eslint-disable-next-line no-console
    console.error('[rate-limit] fail-open triggered', {
      alert: true,
      tier: 'auth_callback_ip',
      errorName: err instanceof Error ? err.name : typeof err,
      ip_bucket: typeof ip === 'string' && ip.length > 0
        ? ip.slice(0, 3)
        : 'unknown',
    });
    return;
  }
  if (!result.success) {
    throw new RateLimitExceededError('auth_callback_ip', new Date(result.reset));
  }
}
```

Signature widens to accept `string | null | undefined` (the route's
`rateLimitBucket` already falls back to `'no-xff'`, but widening the type
signals that the limiter itself is robust to upstream carelessness).

`ip_bucket` as a short prefix (3 chars) is a PII-safe coarse locality
signal — enough to spot "wave from a /16 subnet" while not re-identifying
a user. For a null / undefined / empty `ip`, the bucket becomes the
literal string `'unknown'` — explicit, greppable, and doesn't hide a
bug. NO raw IP in the log under ANY branch. Shape-stable keys (`alert`,
`tier`, `errorName`, `ip_bucket`) are documented inline as the monitor-
grep contract.

**Alerting defense-in-depth:** the `console.error` call itself can throw
only on OOM (argument allocation). A try/catch around the log would be
defending against a fault that, if present, already means the process
is dying. Out of scope; no wrapping.

### F. Update call sites (no behavior change)

Touch every call site of `supabaseForRequest()` to confirm the new return type compiles:

- `apps/web/app/page.tsx` — ignore new methods; uses `.auth.getUser()` only.
- `apps/web/app/note/[slug]/page.tsx` — same.
- `apps/web/app/api/ingest/route.ts` — same.
- `apps/web/app/api/auth/magic-link/route.ts` — same. (Magic-link cookie writes are code-verifier chunks; a failure here would break the subsequent callback. Out of scope to harden this route in the same PR; tracked as a follow-up issue if the proxy surface shows it's useful.)
- `apps/web/app/auth/callback/route.ts` — uses the new methods.

TypeScript's structural types mean "client with extra methods" is assignable to "client" everywhere; no cast needed.

### G. Test matrix (additions to PR #22's matrix)

| Branch | Expected |
|---|---|
| adapter `setAll` throws RSC read-only message | `getCookieWriteFailure()` is null; loop continues; no console.error |
| adapter `setAll` throws unexpected error on cookie #1 | `getCookieWriteFailure()` reports; `getCookieWriteNames()` empty; remaining writes SKIPPED |
| adapter `setAll` throws unexpected on cookie #2 of 3 | failure reported once; names = [#1]; write #3 NOT attempted |
| callback: exchange success + cookie adapter healthy | 302 `/`, Set-Cookie on all chunks |
| callback: exchange success + cookie adapter throws unexpected mid-stream | 307 `/auth?error=cookie_failure`, delete-me Set-Cookie clearing partial, no token substrings in console.error |
| callback: exchange throws, cookie adapter healthy | 307 `/auth?error=<mapped-kind>`, no rollback needed, existing behavior |
| callback: exchange throws a setAll-originated error (bubbled through supabase) | rollback precedence — `cookie_failure` beats the catch-all's `server_error` |
| callback: double-click / prefetch (second GET with consumed code) | 307 `/auth?error=token_used` |
| ratelimit: limiter.limit resolves success | reserve resolves; no console.error |
| ratelimit: limiter.limit rejects (string ip) | reserve resolves (fail-open) AND console.error called once with `{ alert: true, tier: 'auth_callback_ip', errorName, ip_bucket: <3-char-prefix> }` |
| ratelimit: limiter.limit rejects, `ip` is `undefined` | reserve resolves; `ip_bucket === 'unknown'`; no TypeError |
| ratelimit: limiter.limit rejects, `ip` is `null` | reserve resolves; `ip_bucket === 'unknown'`; no TypeError |
| ratelimit: limiter.limit rejects, `ip === ''` | reserve resolves; `ip_bucket === 'unknown'`; no TypeError |
| ratelimit: fail-open log never contains raw `ip` string anywhere | stringify every console.error arg and assert `ip` is NOT a substring of any |
| proxy: access `Symbol.iterator` on client | returns whatever underlying Supabase client returns; no Proxy interception |
| proxy: access unknown string property | returns `undefined` (passes through `Reflect.get`); no Proxy interception |
| callback: cookie adapter fails AND `cookies().delete` throws on rollback | status 500 via final catch-all; no token substrings in console.error; explicit test row |
| callback: double-click — two sequential GETs with same code | first: 302 `/` + Set-Cookie; second: 307 `/auth?error=token_used`, no Set-Cookie |
| any failure branch (all rows) | console.error spy sees no call whose args contain `code`, `access_token`, `refresh_token` (preserved from PR #22) |

### H. Runbook — `README.md` `## Monitoring` section

Create (not just extend — it doesn't exist yet) a `## Monitoring`
section in `README.md` after the "Deploy runbook" section. Content
(exact wording adjustable; the contract is what matters):

> ### Rate-limit fail-open alert
>
> The `/auth/callback` rate limiter (`makeAuthCallbackLimiter`) fails
> OPEN on Upstash outage — a Redis blip cannot be allowed to 503 a
> legitimate magic-link click. When this happens, the limiter emits a
> structured log for monitoring to grep:
>
> ```
> [rate-limit] fail-open triggered { alert: true, tier: 'auth_callback_ip', errorName: '<cls>', ip_bucket: '<3-char-prefix-or-unknown>' }
> ```
>
> **Grep contract** (stable — do NOT rename without a coordinated
> monitoring-config change):
> - `alert: true` — monitor trigger flag
> - `tier: 'auth_callback_ip'` — which limiter fired
>
> A Vercel log drain routing `alert: true` matches to Datadog / Sentry
> / PagerDuty is the intended integration seam. Not yet wired — ship
> the log shape first, wire the drain when a cohort exists.

Council security r1 "must-do before merge" item: this section must
exist wherever alerting will eventually be configured. `README.md` is
the visible default; when a runbooks/ directory is created, this
content moves there and `README.md` links into it.

## Non-negotiables (inherited + new)

Inherited from PR #22:

- **No logging** of `code`, `access_token`, or `refresh_token` in any branch. Tests spy + assert.
- **`@supabase/ssr` pinned.** No version bump in this PR.
- **Redirect URLs allowlist** unchanged. No dashboard edits.
- **Success redirect hardcoded to `/`.** No caller-supplied query param can influence destination.
- **RLS unchanged.** Anon key only.
- **`/auth` error rendering stays allowlist-only** (raw `?error` value never interpolated).
- **WCAG AA 4.5:1** contrast on new error copy.
- **Council required.** No `[skip council]`.

New this plan:

- **Transactional setAll.** First unexpected throw halts the loop; subsequent writes NOT attempted.
- **Rollback precedence.** When both `exchangeCodeForSession` and `setAll` produce failures, `cookie_failure` wins over `server_error` — the cookie-write failure is the proximate, actionable cause.
- **Monitor contract.** `{ alert: true, tier: 'auth_callback_ip' }` key names are a STABLE public contract; renaming requires a coordinated monitoring-config change and a migration note.
- **No raw IPs in fail-open logs.** Enforced by test — raw `ip` NOT a substring of any `console.error` argument.
- **Null-safe `ip_bucket`.** Use `typeof ip === 'string' && ip.length > 0 ? ip.slice(0, 3) : 'unknown'` — never `ip.slice(...)` unguarded. A TypeError here would swallow the very alert this plan is adding (council bugs r1).
- **Proxy-wrap the Supabase client.** Do NOT mutate the `@supabase/ssr` return value — library internals can collide on version bumps.
- **Stable adapter method names.** `getCookieWriteFailure()` and `getWrittenCookieNames()` — single canonical spelling across interface, implementation, tests, and documentation (council arch r1).
- **Accurate error copy.** `cookie_failure` message directs the user to request a NEW magic link, not to retry the consumed one (council bugs r1).

## Rollback

Revert the PR. The system returns to:

- `setAll` best-effort + summary log (the shipped PR #22 behavior).
- Silent fail-open on Upstash outage (the shipped PR #22 behavior).
- No `cookie_failure` kind; a partial-write bug presents as a silent login-loop (the known pre-fix failure mode).

No schema migration, no RLS change, no dashboard edit — pure revert is clean.

## Out of scope

- Magic-link route (`/api/auth/magic-link`) transactional hardening. Tracked as follow-up if the proxy surface proves useful.
- Cross-tab auth state sync (council r2 explicit out-of-scope).
- `exchange_failed` as a distinct user-facing kind (see Problem §4 — decision documented; keep `server_error`).
- Datadog / Sentry / Vercel log drain integration itself. This PR ships the log SHAPE; monitoring wiring is a separate effort with its own cost line.
- Dedicated `pgTAP` migration-flake fix (#7).
- `/diag` removal (#12), Playwright smoke (#20), framework persona (#18).
- i18n of new error copy (council a11y r1 nice-to-have, unchanged decision).

## Success + kill criteria

- **Success metric:** count of 307s from `/auth/callback` to `/auth?error=cookie_failure` per day (should round to zero — when it's non-zero, monitor fires). Alerting signal presence tracked via log-drain grep.
- **Failure metric:** same count, trending up or spiking on a single request hot-path. OR: `alert: true` log fires without a concurrent Upstash incident ticket.
- **Kill criteria:** revert if cookie_failure > 0.1% of sign-ins 48h post-merge AND no Upstash / cookie library incident correlates — that means we introduced a regression in the happy path.
- **Cost:** $0 marginal. No new API calls. `console.error` volume negligible.

## Approval checklist (CLAUDE.md hard gate)

Before writing implementation code, all three must be true:

1. This file committed on `claude/issue-26-auth-hardening` and pushed to origin.
2. PR open against `main`; latest `<!-- council-report -->` comment from `.github/workflows/council.yml` posted against a commit SHA ≥ the commit that last modified this plan.
3. Human typed explicit `approved` / `ship it` / `proceed` after seeing (1) and (2).

If any gate fails, stop and surface the gap.

## Council history

- **r1** (PR #28 @ commit `a46682e`, 2026-04-21T10:34:09Z) — **PROCEED**,
  a11y 9 / arch 10 / bugs 9 / cost 10 / product 9 / security 10. Folded
  into this plan:
  - Adapter method naming standardized to `getCookieWriteFailure` /
    `getWrittenCookieNames` (arch — drift between interface + Proxy
    example).
  - `ip_bucket` guarded against non-string `ip` (bugs — `ip.slice(0,3)`
    on `undefined` would TypeError and swallow the alert).
  - `cookie_failure` copy rewritten to direct user to request a new
    link (bugs — "try again" misleading; code already consumed).
  - Ratelimit test added: raw `ip` string NOT a substring of any
    `console.error` arg (security must-do).
  - Callback test added: two sequential GETs with same code for the
    double-click / prefetch case (security — integration-style, not
    stub-swapped).
  - Callback test added: rollback-itself-fails → 500 via final catch-
    all (bugs — failure-within-failure documented explicitly).
  - Proxy test added: symbol + unknown-key passthrough via
    `Reflect.get` (security top-risk #1 — blast-radius guard).
  - `README.md ## Monitoring` section created with the fail-open log-
    shape grep contract (security must-do + arch).
  - Decisions confirmed and explicitly kept:
    - `server_error` stays as the mapping for 200-OK-with-null-session
      (no new `exchange_failed` kind) — council product r1 noted this
      as a judgement call; plan chose (b).
    - Magic-link-route transactional hardening remains out of scope,
      tracked as a follow-up.
    - i18n / Pino structured logger / Datadog wiring all remain
      out-of-scope nice-to-haves.
