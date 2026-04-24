# Rate-limiter audit

Per CLAUDE.md non-negotiable: *"Rate limiters on state-changing endpoints (mutations, RPC writes, server actions) MUST fail-closed."* This document tracks every tier's posture + justification.

Audit cadence: re-verify whenever a new tier is added OR an existing tier's fail-mode changes.

## Tier table (audit performed 2026-04-25 during PR #50 r3 fold)

| Tier | Surface | Endpoint type | Quota | Fail-mode (quota exceeded) | Fail-mode (limiter unavailable) | Justification |
|------|---------|---------------|-------|----------------------------|--------------------------------|---------------|
| **A** | ingest events | authenticated mutation (PDF upload) | 5/user/hour | fail-closed (`RateLimitExceededError`) | **fail-closed** (`RatelimitUnavailableError` propagates) | Mutation; matches default secure posture. |
| **B** | token budget | authenticated AI calls | 100k tokens/user/hour | fail-closed (with refund of attempted claim) | **fail-closed** (`RatelimitUnavailableError`) | Mutation + cost control; budget integrity is the whole point. |
| **C** | magic-link auth | anonymous mutation (auth send) | 5/IP/hour + 3/email/hour | fail-closed | **fail-closed** (`Promise.all` propagates throws) | Anonymous endpoint with strong abuse motive (email bombing); fail-closed is essential. |
| **D** | auth-callback | anonymous click-through (PKCE callback) | 20/IP/minute | fail-closed | **fail-OPEN (DOCUMENTED EXCEPTION)** | Time-boxed magic-link click-through — a Redis outage blocking the callback would prevent ALL legitimate sign-ins for the duration; Supabase's own project-level rate limits provide the backstop. Failed-open events log a structured `{alert: true, tier: 'auth_callback_ip', ...}` line for ops monitoring. See `packages/lib/ratelimit/src/index.ts:160-220`. |
| **E** | rating submits | authenticated mutation (FSRS rate) | 30/user/minute | fail-closed (`rate_limited` errorKind) | **fail-closed** (`limiter_unavailable` errorKind) | Mutation; was originally fail-open in PR #48 due to misread of pattern; corrected in PR #51 (hot-fix). Now matches A/B/C posture. |

## Source-of-truth pointers

- All tier implementations: `packages/lib/ratelimit/src/index.ts`.
- Tier A: `makeIngestEventLimiter` (line 56).
- Tier B: `makeTokenBudgetLimiter` (line 89).
- Tier C: `makeMagicLinkLimiter` (line 242).
- Tier D: `makeAuthCallbackLimiter` (line 161).
- Tier E: `makeRatingLimiter` (line 297).

## How to add a new tier

1. Implement in `packages/lib/ratelimit/src/index.ts` following the existing pattern.
2. Add to the table above with surface, endpoint type, quota, fail-modes, and justification.
3. Default fail-mode for both branches is **fail-closed**. If you propose fail-open for either branch, justify in the plan AND get explicit council endorsement.
4. Wire the new tier's `RateLimitExceededError.kind` into the discriminated union at `packages/lib/ratelimit/src/index.ts:17-28`.
5. Add tests covering both fail-modes (per the §"Rebutting council findings" rule's "consistently passing test" requirement).

## Pattern justification (when is fail-open OK?)

**Default is fail-closed.** Fail-open is acceptable ONLY when ALL of the following hold:

1. The endpoint is a click-through whose blocking would visibly break a legitimate user flow that the user has already committed to (e.g., clicking a time-boxed link in an email).
2. There is a separate independent control that bounds abuse during the limiter outage (e.g., Supabase project-level limits, a short TTL on the underlying token).
3. Fail-open events emit a structured monitoring log line so ops can detect prolonged outages.
4. The choice is explicitly justified in the plan AND endorsed by council.

Tier D meets all four. No other current tier qualifies.

## Audit log

- 2026-04-25 — initial audit (this doc), during PR #50 r3 fold. All 5 tiers verified fail-closed except Tier D (documented exception).
- Next re-audit: when a new tier is added OR Tier D's justification changes.
