# Plan: hot-fix Tier E rate limiter to fail-closed (PR #50 r2 council fold)

**Status:** draft, awaiting council + human approval.
**Branch:** `claude/hotfix-tier-e-fail-closed`.
**Scope:** flip Tier E (rating submits) from fail-open to fail-closed on `RatelimitUnavailableError`. Adds new `'limiter_unavailable'` errorKind + client copy. ~25-line code change + 1 test + 1 i18n key.

## Problem

PR #48 shipped Tier E with the comment *"matches Tier B/D pattern — better to let a real user through than block on Upstash outage."* That comment was wrong. Re-checking the existing tiers (`packages/lib/ratelimit/src/index.ts`):

- **Tier A** (ingest events): throws `RatelimitUnavailableError` on Upstash failure → **fail-closed**.
- **Tier B** (token budget): catches and re-throws as `RatelimitUnavailableError` → **fail-closed**.
- **Tier C** (magic link): `Promise.all` propagates throws → **fail-closed**.
- **Tier D** (auth callback): explicitly fails OPEN with documented justification (*"Contrast with every other tier (which fails closed). The callback is a click-through from a time-boxed magic-link email; a 503 on Redis outage is a worse UX than dropping the rate-limit briefly, and Supabase's own project-level rate limits provide the backstop."*).

So the codebase pattern for authenticated mutations is **fail-closed**; Tier D is the documented exception for time-boxed click-through auth. **Tier E is a server-action mutation; it should follow A/B/C, not D.** PR #50 council r1 + r2 sustained REVISE on this with security DROPPING from 9 → 4 between rounds. Per the §"Rebutting council findings" rule #4 ("sustained REVISE on the same finding across rounds is a signal to fold"), this is a fold.

## Goal

`apps/web/app/review/actions.ts` — when `ratingLimiter.reserve(user.id)` throws `RatelimitUnavailableError`, the action MUST return `{ ok: false, errorKind: 'limiter_unavailable' }` and SKIP the database call. The client renders a distinct copy ("Rating service is briefly unavailable. Please try again in a moment.") so the user sees a specific error rather than a silent success or generic failure.

## Scope

**In:**

- `apps/web/app/review/actions.ts` — change the catch block: instead of swallowing `RatelimitUnavailableError` with a fall-through comment, return `{ ok: false, errorKind: 'limiter_unavailable' }` + log PII-safe + counter `review.rating.failed{reason: 'limiter_unavailable', user_id}`. Add `'limiter_unavailable'` to the `SubmitReviewResult.errorKind` union.
- `apps/web/app/review/ReviewDeck.tsx` — extend the existing error-copy mapping: `'limiter_unavailable'` → `t('review.rating_limiter_unavailable_error')` instead of falling through to generic `review.rating_error`.
- `apps/web/lib/i18n.ts` — add 1 new key: `review.rating_limiter_unavailable_error`.
- `apps/web/app/review/actions.test.ts` — UPDATE the existing "fail-open on RatelimitUnavailableError: continues to DB" test → REPLACE with "fail-CLOSED on RatelimitUnavailableError: skips DB + returns limiter_unavailable + counter fires." This is a test inversion — the prior test asserted the (incorrect) fail-open behavior; the new test asserts the correct fail-closed behavior.

**Out:**

- Tier B / C / D pattern review — they're already correct (B and C fail-closed; D fail-open is intentional and documented). No changes.
- Monitoring / alerting on `RatelimitUnavailableError` events — separate ticket if desired (#34 Pino logger would be the natural surface).
- `concurrent_update`-specific copy (PR #50 r1 item 5 deferred-polish) — not part of this hot-fix.

## Data isolation model (per CLAUDE.md §"Plan-time required content")

**No new tables.** This is a behavior change to an existing rate-limiter call. RLS unchanged. The `srs_cards` + `review_history` per-user model from PR #48 is unchanged.

## Design

### A. Server action change — `apps/web/app/review/actions.ts`

```ts
// BEFORE (PR #48 shipped):
try {
  await getRatingLimiter().reserve(user.id);
} catch (err) {
  if (err instanceof RateLimitExceededError) {
    counter('review.rating.failed', {
      reason: 'rate_limited',
      user_id: user.id,
    });
    return { ok: false, errorKind: 'rate_limited' };
  }
  if (err instanceof RatelimitUnavailableError) {
    // Fail-open: continue.  ← INCORRECT per Tier A/B/C pattern.
  } else {
    throw err;
  }
}

// AFTER (this hot-fix):
try {
  await getRatingLimiter().reserve(user.id);
} catch (err) {
  if (err instanceof RateLimitExceededError) {
    counter('review.rating.failed', {
      reason: 'rate_limited',
      user_id: user.id,
    });
    return { ok: false, errorKind: 'rate_limited' };
  }
  if (err instanceof RatelimitUnavailableError) {
    // Fail-CLOSED — matches Tier A/B/C pattern; Tier D is the
    // documented exception for time-boxed click-through auth.
    // A server-action mutation must not run unguarded during
    // limiter outage (DoS exposure on fn_review_card).
    console.error('[/review submitReview] limiter_unavailable', {
      errorName: 'RatelimitUnavailableError',
      user_id: user.id,
    });
    counter('review.rating.failed', {
      reason: 'limiter_unavailable',
      user_id: user.id,
    });
    return { ok: false, errorKind: 'limiter_unavailable' };
  }
  throw err;
}
```

### B. Client — `apps/web/app/review/ReviewDeck.tsx`

Extend the existing rate-limit-distinct-copy branch:

```ts
// Inside handleRate's !result.ok branch:
const copyKey =
  result.errorKind === 'rate_limited'
    ? 'review.rating_rate_limit_error'
    : result.errorKind === 'limiter_unavailable'
    ? 'review.rating_limiter_unavailable_error'
    : 'review.rating_error';
setRatingError(t(copyKey));
```

### C. i18n — `apps/web/lib/i18n.ts`

```ts
'review.rating_limiter_unavailable_error':
  'Rating service is briefly unavailable. Please try again in a moment.',
```

### D. Test inversion — `apps/web/app/review/actions.test.ts`

Replace the existing "fail-open on RatelimitUnavailableError" test:

```ts
it('limiter_unavailable: RatelimitUnavailableError → no DB call + distinct errorKind', async () => {
  getUserMock.mockResolvedValue({ data: { user: TEST_USER } });
  const { RatelimitUnavailableError } = await import('@llmwiki/lib-ratelimit');
  reserveMock.mockRejectedValueOnce(new RatelimitUnavailableError());

  const { submitReview } = await import('./actions');
  const result = await submitReview(TEST_CARD_ID, 3, VALID_KEY);

  expect(result).toEqual({ ok: false, errorKind: 'limiter_unavailable' });
  expect(fromMock).not.toHaveBeenCalled();
  expect(rpcMock).not.toHaveBeenCalled();
  expect(counterMock).toHaveBeenCalledWith('review.rating.failed', {
    reason: 'limiter_unavailable',
    user_id: TEST_USER.id,
  });
});
```

## Non-negotiables (must hold; council will not override)

- **No DB call when limiter is unavailable.** The `from('srs_cards')` call MUST NOT execute on the `RatelimitUnavailableError` branch. Test asserts negatively.
- **PII-safe logging.** Log shape `{errorName, user_id}` only — no card content, no error.message.
- **Distinct errorKind.** `limiter_unavailable` ≠ `rate_limited` ≠ `persist_failed`. Three distinct user-facing copies for three distinct failure modes.
- **Tier B / C / D unchanged.** Only Tier E flips; do NOT touch other tiers' fail-mode posture.

## Tests

- Updated `actions.test.ts` test (inversion described in §D above).
- Existing `actions.test.ts` "fail-closed on RateLimitExceededError" + "RLS blocks card load" + idempotency tests all stay unchanged and should continue to pass.

## Risks

1. **UX degradation during Upstash outage.** Users see "Rating service is briefly unavailable" instead of a successful rating. This is the correct posture for a security control — temporary inconvenience > DoS exposure. Documented in the change rationale.
2. **Cache effects.** None — no caches involved.
3. **Migration.** None — pure application-layer behavior change.

## Cost

Zero net cost change. Same Upstash call cadence; same DB cadence (ratings count is unchanged in expectation; only the outage path changes from "through" to "blocked").

## Acceptance criteria

- [ ] On `RatelimitUnavailableError`, the action returns `{ ok: false, errorKind: 'limiter_unavailable' }` and makes NO `from('srs_cards')` call (test asserts).
- [ ] On `RatelimitUnavailableError`, the action logs `{errorName: 'RatelimitUnavailableError', user_id}` only (PII-safe negative-sentinel test asserts).
- [ ] On `RatelimitUnavailableError`, the action fires `counter('review.rating.failed', {reason: 'limiter_unavailable', user_id})`.
- [ ] Client renders distinct copy on `limiter_unavailable` (test asserts the i18n key is referenced; manual verification of the copy itself).
- [ ] All existing tests still pass (no regressions on `rate_limited`, `persist_failed`, `concurrent_update`, RLS-block, idempotency, happy path).
- [ ] `npm run lint`, `npm run typecheck`, `npm test` pass.
- [ ] Council PROCEED on the impl-diff round.

## Why this hot-fix and not a bigger redesign

The PR #50 r2 council also asked for monitoring/alerting on fail-open events generally. That's a real concern for Tier D (which still fails open), but it's a separate change with its own surface (logging infrastructure / alert routing). This hot-fix is scoped to one concrete change: flip Tier E to fail-closed. Broader rate-limit-monitoring work belongs in a follow-up that touches `#34` (Pino structured logger) plus a monitoring config.
