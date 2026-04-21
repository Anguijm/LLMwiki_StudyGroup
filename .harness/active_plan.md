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
- `token_used` via double-click: first call with code X returns a session; second call with code X throws a Supabase error whose message contains `already.*used` → second response is 307 `/auth?error=token_used`, no Set-Cookie on the second response.
- Regression: missing / empty / whitespace code branches still land at `invalid_request` after the refactor.

**`packages/lib/ratelimit/src/index.test.ts`** — new or extended:

- `makeAuthCallbackLimiter().reserve(ip)` when the underlying `limiter.limit` throws → resolves without error (fail-open preserved) AND `console.error` was called with an object argument that deep-equals `{ alert: true, tier: 'auth_callback_ip', errorName: <name>, ip_bucket: <prefix-or-hash> }`. No raw IP anywhere in the log.
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
    if (prop === 'getCookieWriteNames') return () => [...writtenNames];
    return Reflect.get(target, prop, receiver);
  }
});
```

Proxy avoids any collision with Supabase's surface.

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
cookie_failure: 'We couldn't save your sign-in. Please try again.',
```

Contrast still meets WCAG AA 4.5:1 — uses the same `text-danger` class as existing entries. The existing `aria-live="assertive"` region announces it automatically; no wiring change. Unknown kinds continue to fall through to `GENERIC_CALLBACK_ERROR` (XSS allowlist semantics preserved).

### E. Fail-open alerting in `packages/lib/ratelimit/src/index.ts`

Change `makeAuthCallbackLimiter().reserve` to log on the fail-open branch:

```ts
async function reserve(ip: string): Promise<void> {
  let result: Awaited<ReturnType<typeof limiter.limit>>;
  try {
    result = await limiter.limit(ip);
  } catch (err) {
    // Fail-OPEN by design — a transient Upstash outage must not deny a legit
    // link-click. But a SILENTLY disabled DOS guard is worse than no guard;
    // a future monitor will grep for `alert: true, tier: 'auth_callback_ip'`
    // in log drain and page the on-call. Shape is stable — do not rename
    // these keys without a search across monitoring config.
    // eslint-disable-next-line no-console
    console.error('[rate-limit] fail-open triggered', {
      alert: true,
      tier: 'auth_callback_ip',
      errorName: err instanceof Error ? err.name : typeof err,
      ip_bucket: ip.slice(0, 3), // coarse prefix; never the full IP
    });
    return;
  }
  if (!result.success) {
    throw new RateLimitExceededError('auth_callback_ip', new Date(result.reset));
  }
}
```

`ip_bucket` as a short prefix (3 chars) is a PII-safe coarse locality signal — enough to spot "wave from a /16 subnet" while not re-identifying a user. NO raw IP in the log. Shape-stable keys (`alert`, `tier`, `errorName`, `ip_bucket`) are documented inline as the monitor-grep contract.

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
| ratelimit: limiter.limit rejects | reserve resolves (fail-open) AND console.error called once with `{ alert: true, tier: 'auth_callback_ip', errorName, ip_bucket }` |
| ratelimit: fail-open log never contains raw `ip` value | assert `ip` NOT in any console.error arg |
| any failure branch (all rows) | console.error spy sees no call whose args contain `code`, `access_token`, `refresh_token` (preserved from PR #22) |

### H. Runbook note

Add one line to the `README.md` "Monitoring" section (or create a stub `## Monitoring` §) describing the `alert: true, tier: 'auth_callback_ip'` log shape as the grep target for fail-open alerting. No infra yet — this is the seam for a future Vercel log drain + Datadog rule.

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
- **No raw IPs in fail-open logs.** Enforced by test.
- **Proxy-wrap the Supabase client.** Do NOT mutate the `@supabase/ssr` return value — library internals can collide on version bumps.

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

(empty — awaiting r1)
