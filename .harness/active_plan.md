# Plan: FSRS rating + scheduling on /review (closes the SRS loop)

**Status:** r2 — folded council r1 REVISE 6/9/3/10/10/3 (8 substantive non-negotiables: idempotency key, optimistic concurrency, Zod validation on `fsrs_state`, per-user rate limit, pinned `ts-fsrs` version, RLS-negative test in `actions.test.ts`, focus management on auto-advance, down-migration). Awaiting council r2 + human approval.
**Branch:** `claude/fsrs-scoring`.
**Scope:** rating UI on `/review` (Again/Hard/Good/Easy) + server action that runs the FSRS algorithm + persists state atomically with idempotency + optimistic concurrency. New runtime dep (`ts-fsrs` pinned exact version). New typed wrappers around `srs_cards.fsrs_state` and `review_history.{prev,next}_state`. New per-user rate-limit Tier (E). **No `[skip council]`** — new external lib + auth-gated mutation surface + the kind of state-machine math council should scrutinize.

## Problem

PR #42 shipped `/review` as a read-only surface — users see their cards but cannot rate them. Without rating, the entire "spaced repetition" value prop is inert: `srs_cards.fsrs_state` is always `{}`, `srs_cards.due_at` is always `null`, `review_history` is always empty, and the user reviews the same N cards forever in `created_at desc` order. The product persona on PR #43 r5 explicitly: *"`/review` UI without scoring is 'look at the same cards forever'; rating closes the loop and validates the entire ingest → flashcards → review → retention pipeline."*

## Goal

After this PR ships, a user on `/review` can:

1. Reveal an answer (existing).
2. Rate the card with one of four buttons: **Again** (forgot completely), **Hard** (recalled with difficulty), **Good** (recalled correctly), **Easy** (trivially correct). Buttons are disabled until the answer is revealed (you can't rate what you haven't tried to recall).
3. On click, the server runs the FSRS algorithm against the card's current `fsrs_state`, computes a new `(state, due_at)` pair, persists both updates to `srs_cards` AND inserts a `review_history` row in a single transaction.
4. The client advances to the next card and re-hides the answer.
5. New cards (with `fsrs_state = {}`) initialize cleanly on first review.

The /review query stays unchanged in this PR — still `order by created_at desc limit 20`. **Due-now filtering** (only show cards where `due_at <= now()`) is explicitly out of scope; this PR's job is to make the FSRS loop *work*, not to reorganize the queue. Due-filtering is a separate ticket once the rating UX is validated.

## Scope

**In:**

- `packages/lib/srs/package.json` — pin `ts-fsrs` to an exact version (no `^` / `~`). Runtime dep declared in this leaf package only; not in `apps/web/package.json` (the app imports the wrapper, not the lib directly). Pinning is a council r1 security non-negotiable: an automatic minor bump could change scheduling intervals; bumps require a council round.
- `packages/lib/srs/` — new tiny package wrapping `ts-fsrs` with our domain types + Zod schema for `FsrsCardState` + a single `nextState(currentState, rating)` pure function. Reasons for a wrapper package:
  1. Keeps `ts-fsrs` import surface narrow — only one file imports it.
  2. Lets us swap the underlying lib later without touching app code.
  3. Provides a single test-target for the algorithm contract (failure-mode tests live here per the new rebuttal-protocol rule).
  4. Hosts the `FsrsCardStateSchema` Zod parser so any DB read of `fsrs_state` validates at the boundary (council r1 bugs fold).
- `apps/web/app/review/actions.ts` — new server action `submitReview(cardId, rating, idempotencyKey)`. RLS-scoped via `supabaseForRequest`; runs `nextState` (with Zod-parsed prev state); persists via a Postgres function (`fn_review_card`) called via Supabase RPC for atomicity + optimistic concurrency. Per-user rate-limited via the new Tier E limiter.
- `packages/lib/ratelimit/src/index.ts` — add **Tier E: rating submits, 30 / user / minute**. Mirrors Tier B's per-user keying + sliding window. Rationale (council r1 security non-negotiable): mutation endpoints need rate-limit per CLAUDE.md non-negotiables; 30/min is well above realistic user behavior (a serious study session is ~5–10 cards/min) and well below abuse rates.
- `supabase/migrations/20260424000001_review_history_idempotency.sql` — new column `review_history.idempotency_key text not null` + `unique (user_id, idempotency_key)` constraint. Council r1 bugs non-negotiable: closes the retry-after-network-drop double-apply gap.
- `supabase/migrations/20260424000002_fn_review_card.sql` — new SQL function `fn_review_card(p_card_id uuid, p_rating smallint, p_next_state jsonb, p_due_at timestamptz, p_prev_state jsonb, p_idempotency_key text)` that:
  - Inserts into `review_history` with `on conflict (user_id, idempotency_key) do nothing returning id` — idempotent retry.
  - If the insert was a no-op (replay): returns success without touching `srs_cards`.
  - Else: updates `srs_cards.fsrs_state` + `due_at` with `WHERE id = p_card_id AND fsrs_state = p_prev_state` (optimistic concurrency — council r1 bugs non-negotiable). If 0 rows updated, raises `40001` (serialization failure) so the server action can return `concurrent_update`.
  - All in a single transaction. RLS via `security invoker`.
- `supabase/migrations/20260424000003_fn_review_card_down.sql` — companion down-migration: `drop function public.fn_review_card`, `alter table public.review_history drop constraint review_history_idempotency_unique, drop column idempotency_key`. Council r1 arch fold.
- `apps/web/app/review/ReviewDeck.tsx` — extend with rating buttons (4 buttons after answer reveal, hidden before reveal); generates an `idempotencyKey = crypto.randomUUID()` per rating click; wires to the server action; on success, calls existing `handleNext`. Auto-advance moves keyboard focus to the new card heading via the existing `headingRef` + `useEffect` pattern from PR #42 — verified by extending the existing focus-management test (council r1 a11y non-negotiable).
- `apps/web/lib/i18n.ts` — 7 new keys: `review.rating.again`, `review.rating.hard`, `review.rating.good`, `review.rating.easy`, `review.rating_error`, `review.rating_pending`, `review.rating_rate_limit_error` (new for the rate-limit failure path).
- `apps/web/tailwind.config.ts` (or `globals.css`) — verify `bg-warning` + `text-brand-900` pair passes WCAG AA 3:1 for UI components. Council r1 a11y fold; if the existing palette fails, the "Hard" button gets a darker amber shade documented in the same diff. The existing `axe-core` smoke test at `apps/web/tests/a11y/smoke.spec.ts` will be extended to include the rating cluster's static markup.
- Tests:
  - `packages/lib/srs/src/index.test.ts` — algorithm contract, Zod parse happy/sad paths, failure-mode coverage (see §Tests).
  - `apps/web/app/review/actions.test.ts` — server-action behavior, **explicit RLS-blocked test** (council r1 security non-negotiable: live in this consistently-passing suite, not just pgTAP), idempotency replay test, concurrent-update / `40001` test, rate-limit-exceeded test, Zod-malformed-state test, PII-safe logging negative-sentinel.
  - `apps/web/components/ReviewDeck.test.tsx` — rating buttons disabled before reveal, enabled after, fire on click with `idempotencyKey` passed, advance card on success, focus moves to next card heading after auto-advance, rate-limit error renders distinct copy.
  - `packages/lib/ratelimit/src/index.test.ts` — extended with Tier E happy-path + boundary cases (allow at limit, deny at limit+1).
  - `supabase/tests/fn_review_card.sql` — pgTAP test for the SQL function (acknowledged-flaky per #7; written but **NOT** load-bearing for the rebuttal protocol per the new CLAUDE.md "consistently passing" rule).

**Out (explicit):**

- **Due-now filtering on `/review`'s initial query** — separate ticket once rating UX is validated.
- **Per-user FSRS parameter tuning** (advanced FSRS feature for personalized intervals) — defaults are fine for v1.
- **Anki-style multi-deck management** — single global deck per user.
- **Review session boundaries** ("review 20 cards then stop") — cards are rated as they come up; user closes the tab to end.
- **Heatmap / streak tracking** — separate analytics surface.
- **Undo last review** — accept the rating once submitted; the lapse counter handles "I clicked wrong" via the next-review's Again rating.
- **Mobile gesture support** (swipe to rate) — keyboard + click only for v1.
- **Keyboard shortcuts** (1/2/3/4 to rate) — nice-to-have follow-up.

## Data isolation model (per CLAUDE.md §"Plan-time required content")

Two tables touched by this PR; neither is new:

- **`srs_cards`** — **per-user** (already shipped at `supabase/migrations/20260417000002_rls_policies.sql:118-121`). Justification: a study group's flashcards are personal study aids — only the owning user reviews their own cards. This PR mutates the row's `fsrs_state` + `due_at`, which are the per-user review state.
- **`review_history`** — **per-user** (already shipped at `supabase/migrations/20260417000002_rls_policies.sql:125-128`). Justification: a user's review history is a personal study log — only the owning user reads/writes their own entries. This PR inserts new rows.

The new SQL function `fn_review_card` runs as `security invoker` so `auth.uid()` flows through to the RLS check on both tables. **No new tables introduced; no new RLS policies needed.**

## Design

### A. FSRS wrapper package — `packages/lib/srs/`

```ts
// packages/lib/srs/src/index.ts
import { z } from 'zod';
import { FSRS, generatorParameters, Rating, type Card } from 'ts-fsrs';

export const RATING_AGAIN = 1;
export const RATING_HARD = 2;
export const RATING_GOOD = 3;
export const RATING_EASY = 4;
export type RatingValue = 1 | 2 | 3 | 4;

export function isValidRating(r: unknown): r is RatingValue {
  return r === 1 || r === 2 || r === 3 || r === 4;
}

/**
 * Our wire shape for srs_cards.fsrs_state and review_history.{prev,next}_state.
 * Matches ts-fsrs's Card serialization 1:1; explicit interface so a future
 * lib swap can target a stable contract.
 *
 * Council r1 bugs fold: the Zod schema below is the runtime validator. Any
 * read of fsrs_state from the DB MUST go through `parseFsrsState` before
 * passing to `nextState` — protects against malformed JSONB from a past bug,
 * manual DB edit, or schema drift.
 */
export interface FsrsCardState {
  due: string;             // ISO timestamp
  stability: number;
  difficulty: number;
  elapsed_days: number;
  scheduled_days: number;
  reps: number;
  lapses: number;
  state: 0 | 1 | 2 | 3;    // 0=new, 1=learning, 2=review, 3=relearning
  last_review?: string;    // ISO timestamp; undefined for never-reviewed
}

export const FsrsCardStateSchema = z.object({
  due: z.string().datetime({ offset: true }),
  stability: z.number().finite().nonnegative(),
  difficulty: z.number().finite(),
  elapsed_days: z.number().finite().nonnegative(),
  scheduled_days: z.number().finite().nonnegative(),
  reps: z.number().int().nonnegative(),
  lapses: z.number().int().nonnegative(),
  state: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]),
  last_review: z.string().datetime({ offset: true }).optional(),
});

/**
 * Parse a value (typically `srs_cards.fsrs_state` from a Supabase select)
 * into a typed `FsrsCardState`. Returns `null` for the empty-state sentinel
 * `{}` (a never-reviewed card) so the caller can branch to `emptyFsrsState()`.
 *
 * Throws `ZodError` on a non-empty malformed shape so the caller can decide
 * whether to fail loud (server action returns persist_failed) or fall back
 * to a fresh empty state. The decision is intentionally NOT made here —
 * this is the validator, not the policy.
 */
export function parseFsrsState(raw: unknown): FsrsCardState | null {
  if (raw && typeof raw === 'object' && Object.keys(raw).length === 0) {
    return null;  // {} sentinel = never-reviewed
  }
  return FsrsCardStateSchema.parse(raw);
}

/**
 * Initial state for a never-reviewed card. Matches ts-fsrs's createEmptyCard()
 * output but spelled out so the contract is readable.
 */
export function emptyFsrsState(now: Date = new Date()): FsrsCardState {
  return {
    due: now.toISOString(),
    stability: 0,
    difficulty: 0,
    elapsed_days: 0,
    scheduled_days: 0,
    reps: 0,
    lapses: 0,
    state: 0,
  };
}

const fsrs = new FSRS(generatorParameters({ enable_fuzz: true }));

/**
 * Pure function: given the current state + a rating + "now", compute the
 * next state and the next due date. Throws on invalid rating (caller must
 * validate first via isValidRating).
 *
 * "Pure" with one caveat: ts-fsrs's enable_fuzz=true adds randomness to the
 * scheduled interval (anti-clustering on cards reviewed in batches). Tests
 * that assert exact intervals must seed Math.random or disable fuzz; tests
 * that assert ordering ("Easy interval > Good interval > Hard interval >
 * Again interval") are fuzz-stable.
 */
export function nextState(
  current: FsrsCardState,
  rating: RatingValue,
  now: Date = new Date(),
): { state: FsrsCardState; due: Date } {
  // Convert FsrsCardState (our wire) → ts-fsrs Card (their internal).
  const card: Card = {
    due: new Date(current.due),
    stability: current.stability,
    difficulty: current.difficulty,
    elapsed_days: current.elapsed_days,
    scheduled_days: current.scheduled_days,
    reps: current.reps,
    lapses: current.lapses,
    state: current.state as Card['state'],
    last_review: current.last_review ? new Date(current.last_review) : undefined,
  };

  const result = fsrs.next(card, now, rating as Rating);
  const next = result.card;

  return {
    state: {
      due: next.due.toISOString(),
      stability: next.stability,
      difficulty: next.difficulty,
      elapsed_days: next.elapsed_days,
      scheduled_days: next.scheduled_days,
      reps: next.reps,
      lapses: next.lapses,
      state: next.state as FsrsCardState['state'],
      last_review: next.last_review?.toISOString(),
    },
    due: next.due,
  };
}
```

**Why a wrapper package:** keeps `ts-fsrs` imports localized to one file. If we later swap to `super-memo` or roll our own, only this file changes. Council can audit the algorithm contract (the test suite below) without combing through call-sites.

**Why `ts-fsrs` over rolling our own:** the FSRS-5 algorithm has subtle math (logarithmic stability decay, retrievability formulas, difficulty drift). `ts-fsrs` is the canonical TypeScript port maintained by the FSRS spec authors; ~10kb min+gz. The cost of getting it wrong (silently scheduling cards incorrectly) is much higher than the dep cost. Council can push back; documented fold path: write a minimal FSRS-5 impl in `packages/lib/srs/src/algorithm.ts` (~200 LOC of pure math) and skip the dep.

### B. SQL function + idempotency column — `supabase/migrations/`

**Two migrations, ordered by file timestamp:**

#### B.1 — `20260424000001_review_history_idempotency.sql` (column + unique constraint)

```sql
-- Council r1 bugs non-negotiable: idempotency key for retry-safe reviews.
-- A client retry after a network drop must NOT double-apply the rating.
--
-- Backfill: existing rows (none in v0 — table is empty post-migration)
-- get a generated UUID via uuid_generate_v4() so the not-null constraint
-- holds. The unique (user_id, idempotency_key) index is the dedup key.
alter table public.review_history
  add column idempotency_key text;

update public.review_history
  set idempotency_key = uuid_generate_v4()::text
  where idempotency_key is null;

alter table public.review_history
  alter column idempotency_key set not null;

create unique index review_history_idempotency_unique
  on public.review_history (user_id, idempotency_key);

comment on column public.review_history.idempotency_key is
  'Client-generated UUIDv4 per rating click. Retries with the same key are no-ops. Council r1 bugs non-negotiable on PR #48.';
```

#### B.2 — `20260424000002_fn_review_card.sql` (the function)

```sql
-- Atomic update: srs_cards.fsrs_state + due_at AND insert review_history,
-- in one transaction. Idempotent on (user_id, idempotency_key); optimistic
-- concurrency on srs_cards.fsrs_state.
--
-- security invoker: caller's auth.uid() flows through to RLS checks on
-- srs_cards_own + review_history_own. A user can only review their own
-- cards.
create or replace function public.fn_review_card(
  p_card_id uuid,
  p_rating smallint,
  p_next_state jsonb,
  p_due_at timestamptz,
  p_prev_state jsonb,
  p_idempotency_key text
) returns void
language plpgsql
security invoker
as $$
declare
  v_user_id uuid;
  v_inserted_id uuid;
  v_updated_count int;
begin
  -- Validate rating range here (defense in depth — server action also checks).
  if p_rating not in (1, 2, 3, 4) then
    raise exception 'invalid rating: %', p_rating using errcode = '22023';
  end if;

  -- Read user_id from the card row, scoped by RLS. If the row is invisible
  -- (RLS blocks: not the user's card) OR doesn't exist, this returns null.
  -- Fail loud with insufficient_privilege so the server action returns
  -- card_not_found rather than producing partial state.
  select user_id into v_user_id
    from public.srs_cards
    where id = p_card_id;
  if v_user_id is null then
    raise exception 'card not found or not accessible: %', p_card_id
      using errcode = '42501'; -- insufficient_privilege
  end if;

  -- Idempotency check: try to insert review_history first. If the
  -- (user_id, idempotency_key) pair already exists, this is a retry —
  -- ON CONFLICT DO NOTHING returns no row, and we short-circuit to a
  -- successful no-op (the original write already advanced the card state).
  -- Council r1 bugs non-negotiable: closes the retry-after-network-drop
  -- double-apply gap.
  insert into public.review_history (card_id, user_id, rating, prev_state, next_state, idempotency_key)
    values (p_card_id, v_user_id, p_rating, p_prev_state, p_next_state, p_idempotency_key)
    on conflict (user_id, idempotency_key) do nothing
    returning id into v_inserted_id;

  if v_inserted_id is null then
    -- Replay: the original review already happened. No state mutation
    -- needed; return success.
    return;
  end if;

  -- Optimistic concurrency: update card state ONLY if fsrs_state matches
  -- what the client computed `next_state` from. If a concurrent
  -- submitReview already advanced the state, this UPDATE matches 0 rows
  -- and we raise serialization_failure so the server action can return
  -- concurrent_update.
  -- Council r1 bugs non-negotiable: prevents lost-update under concurrent
  -- rating attempts.
  update public.srs_cards
    set fsrs_state = p_next_state,
        due_at = p_due_at
    where id = p_card_id
      and fsrs_state = p_prev_state;
  get diagnostics v_updated_count = row_count;
  if v_updated_count = 0 then
    raise exception 'concurrent update on card %', p_card_id
      using errcode = '40001'; -- serialization_failure
  end if;
end;
$$;

comment on function public.fn_review_card(uuid, smallint, jsonb, timestamptz, jsonb, text) is
  'Atomic review: idempotent insert of review_history + optimistic-concurrency update of srs_cards. RLS-scoped via security invoker. Council r1 (PR #48) folded idempotency + optimistic concurrency.';

revoke all on function public.fn_review_card(uuid, smallint, jsonb, timestamptz, jsonb, text) from public;
grant execute on function public.fn_review_card(uuid, smallint, jsonb, timestamptz, jsonb, text) to authenticated;
```

#### B.3 — `20260424000003_fn_review_card_down.sql` (down-migration; council r1 arch fold)

```sql
-- Roll back PR #48 schema changes. Run in reverse order of the up migrations.
drop function if exists public.fn_review_card(uuid, smallint, jsonb, timestamptz, jsonb, text);
drop index if exists public.review_history_idempotency_unique;
alter table public.review_history drop column if exists idempotency_key;
```

**Why a SQL function instead of two sequential Supabase client calls:** atomicity. Two client calls = network-level non-atomicity = a partial state where the card's `fsrs_state` advanced but no `review_history` row exists. That's debt: the audit trail is broken, and re-rating the card would compute from the new state without remembering it was just reviewed. A single transaction inside Postgres is the correct boundary.

**Why `security invoker` not `security definer`:** definer would bypass RLS using the function-owner's permissions — defeats the entire RLS model. Invoker means `auth.uid()` is the calling user, and the existing per-user RLS policies on both tables enforce ownership.

**Why insert-history-first then update-card (not the reverse):** the `on conflict do nothing` on the insert is the cheap idempotency check. If we updated the card first then the insert was a replay, we'd have already moved the card state forward unnecessarily. Insert first → on replay, short-circuit return → card untouched. On a fresh review, the insert succeeds → we proceed to the optimistic-concurrency UPDATE.

**Why `40001` on concurrent-update collision:** matches Postgres's standard serialization-failure SQLSTATE so the Supabase client wraps it predictably. The server action distinguishes `40001` from generic errors and returns `errorKind: 'concurrent_update'` so the client can retry-or-recompute (a future UX could re-fetch the card and replay the rating against the new state).

### C. Server action — `apps/web/app/review/actions.ts`

```ts
'use server';

import { ZodError } from 'zod';
import { counter } from '@llmwiki/lib-metrics';
import {
  isValidRating,
  emptyFsrsState,
  nextState,
  parseFsrsState,
  type FsrsCardState,
  type RatingValue,
} from '@llmwiki/lib-srs';
import { makeRatingLimiter, RateLimitExceededError } from '@llmwiki/lib-ratelimit';
import { supabaseForRequest } from '../../lib/supabase';

export interface SubmitReviewResult {
  ok: boolean;
  errorKind?:
    | 'invalid_rating'
    | 'invalid_idempotency_key'
    | 'card_not_found'
    | 'persist_failed'
    | 'invalid_state'         // Zod parse failure on fsrs_state — council r1 bugs fold
    | 'concurrent_update'     // 40001 from fn_review_card — council r1 bugs fold
    | 'rate_limited'          // Tier E quota exceeded — council r1 security fold
    | 'unauthenticated';
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Tier E limiter: 30 ratings / user / minute. Module-level singleton so the
// underlying Upstash client is reused across server-action invocations.
const ratingLimiter = makeRatingLimiter();

export async function submitReview(
  cardId: string,
  rating: number,
  idempotencyKey: string,
): Promise<SubmitReviewResult> {
  // Validate inputs BEFORE any DB call. Defense in depth — SQL function also
  // checks rating range, but cheap-and-loud rejection at the boundary keeps
  // PostgresError noise out of logs and Tier E quota intact.
  if (!isValidRating(rating)) {
    counter('review.rating.rejected', { reason: 'invalid_rating' });
    return { ok: false, errorKind: 'invalid_rating' };
  }
  if (!UUID_RE.test(cardId)) {
    counter('review.rating.rejected', { reason: 'invalid_card_id' });
    return { ok: false, errorKind: 'invalid_rating' };
  }
  // Idempotency key must be a UUID-shaped string the client generated via
  // crypto.randomUUID(). Reject empty / wrong-shape values so a buggy client
  // can't accidentally collapse all retries onto one bucket.
  if (!UUID_RE.test(idempotencyKey)) {
    counter('review.rating.rejected', { reason: 'invalid_idempotency_key' });
    return { ok: false, errorKind: 'invalid_idempotency_key' };
  }

  const rls = await supabaseForRequest();
  const { data: { user } } = await rls.auth.getUser();
  if (!user) {
    return { ok: false, errorKind: 'unauthenticated' };
  }

  // Per-user rate limit (council r1 security non-negotiable). 30 / user /
  // minute. Fail-closed on quota exceeded; fail-open on limiter unavailable
  // (alert + allow) per the Tier B/D pattern.
  try {
    await ratingLimiter.reserve(user.id);
  } catch (err) {
    if (err instanceof RateLimitExceededError) {
      counter('review.rating.failed', { reason: 'rate_limited', user_id: user.id });
      return { ok: false, errorKind: 'rate_limited' };
    }
    // RatelimitUnavailableError or unexpected — fail-open with alert (logged
    // by the limiter helper itself, matching Tier D fail-open posture).
    // Continue to the rating; better to let a real user through than block on
    // limiter outage.
  }

  // Load the card's current state (RLS-scoped). If the user doesn't own it
  // OR it doesn't exist, the select returns null/error → card_not_found.
  const { data: card, error: loadErr } = await rls
    .from('srs_cards')
    .select('id, fsrs_state')
    .eq('id', cardId)
    .single();
  if (loadErr || !card) {
    console.error('[/review submitReview] card_load_failed', {
      errorName: loadErr?.name ?? 'NotFound',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- supabase error untyped
      code: (loadErr as any)?.code ?? null,
      user_id: user.id,
      card_id: cardId,
    });
    counter('review.rating.failed', { reason: 'card_not_found', user_id: user.id });
    return { ok: false, errorKind: 'card_not_found' };
  }

  // Council r1 bugs non-negotiable: parse fsrs_state through Zod before
  // passing to nextState. Malformed JSONB (from a past bug, manual edit, or
  // schema drift) returns invalid_state instead of crashing.
  let currentState: FsrsCardState;
  try {
    currentState = parseFsrsState(card.fsrs_state) ?? emptyFsrsState();
  } catch (err) {
    if (err instanceof ZodError) {
      console.error('[/review submitReview] invalid_state', {
        errorName: 'ZodError',
        issueCount: err.issues.length,  // count only — never issue.path or issue.message
        user_id: user.id,
        card_id: cardId,
      });
      counter('review.rating.failed', { reason: 'invalid_state', user_id: user.id });
      return { ok: false, errorKind: 'invalid_state' };
    }
    throw err;  // unknown error type — let the framework's error boundary handle it
  }

  // Compute next state. nextState wraps ts-fsrs in a try-equivalent path;
  // any throw here would be a library bug (the algorithm is pure math on
  // validated input). We intentionally do NOT catch — surfacing as an
  // unhandled error makes the bug visible.
  const { state: next, due } = nextState(currentState, rating as RatingValue);

  // Persist atomically via the SQL function (idempotent + optimistic-concurrent).
  const { error: rpcErr } = await rls.rpc('fn_review_card', {
    p_card_id: cardId,
    p_rating: rating,
    p_next_state: next,
    p_due_at: due.toISOString(),
    p_prev_state: currentState,
    p_idempotency_key: idempotencyKey,
  });
  if (rpcErr) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- supabase error untyped
    const code = (rpcErr as any)?.code ?? null;
    // 40001 (serialization_failure) = optimistic-concurrency collision.
    // Distinct error kind so the client can choose to refetch + retry.
    const errorKind = code === '40001' ? 'concurrent_update' : 'persist_failed';
    console.error('[/review submitReview] persist_failed', {
      errorName: rpcErr.name ?? 'UnknownError',
      code,
      user_id: user.id,
      card_id: cardId,
    });
    counter('review.rating.failed', { reason: errorKind, user_id: user.id });
    return { ok: false, errorKind };
  }

  counter('review.rating.submitted', {
    user_id: user.id,
    rating: String(rating),
    is_new_card: currentState.state === 0 ? 'true' : 'false',
  });
  return { ok: true };
}
```

**PII discipline (per CLAUDE.md non-negotiables + the new rebuttal protocol):** error logs include `errorName` + `code` + `user_id` + `card_id` only — never card content, never `error.message` (which can echo query/row text), never `ZodError.issues[].message` or `.path` (path could include card content under deep validation). For Zod, only `issues.length` is logged. Counter labels: `user_id`, `card_id` (UUIDs, pseudonyms not PII), `rating` (small int), `is_new_card` (boolean). Card content is NEVER a label.

**Tier E rate-limit posture:** fail-closed on quota exceeded → user sees "rating saved too fast" copy + can retry after the window. Fail-open on limiter unavailable → user proceeds (an outage of Upstash should not block real study sessions; the alert is logged for ops). Matches Tier B/D pattern from PR #28.

### D. Client wiring — `apps/web/app/review/ReviewDeck.tsx` extension

Add 4 rating buttons after the existing reveal button. They render only when `revealed === true` and `pendingRating === false`. On click, fire the server action; on success, advance via existing `handleNext`; on failure, surface a toast/alert via the existing `aria-live` region.

```ts
// Inside ReviewDeck component, after existing state:
const [pendingRating, setPendingRating] = useState(false);
const [ratingError, setRatingError] = useState<string | null>(null);

const handleRate = async (rating: 1 | 2 | 3 | 4) => {
  if (pendingRating) return; // Double-click guard.
  setPendingRating(true);
  setRatingError(null);
  // Council r1 bugs non-negotiable: client-generated idempotency key.
  // crypto.randomUUID is available in all modern browsers AND in jsdom 22+;
  // server-action validates the shape before any DB call.
  const idempotencyKey = crypto.randomUUID();
  try {
    const result = await submitReview(card.id, rating, idempotencyKey);
    if (!result.ok) {
      // Distinct copy for rate-limit so user knows to slow down vs. retry.
      const copyKey =
        result.errorKind === 'rate_limited'
          ? 'review.rating_rate_limit_error'
          : 'review.rating_error';
      setRatingError(t(copyKey));
      // Council r1 nice-to-have: log a generic, PII-safe debug line for
      // ops visibility (errorKind is a bounded enum, not card content).
      console.error('[ReviewDeck] rating_failed', { errorKind: result.errorKind });
      setPendingRating(false);
      return;
    }
    counter('review.card.rated', { rating: String(rating) });
    handleNext(); // Advances + re-hides answer; existing useEffect on [index]
                  // moves focus to the sr-only heading (council r1 a11y fold —
                  // re-uses the focus-mgmt path PR #42 already shipped + tested).
    setPendingRating(false);
  } catch (err) {
    // Server action threw (network, etc.). Don't log error.message — could
    // contain serialized server state. Log only error class for ops visibility.
    const errorName = err instanceof Error ? err.name : typeof err;
    console.error('[ReviewDeck] rating_threw', { errorName });
    setRatingError(t('review.rating_error'));
    setPendingRating(false);
  }
};
```

**Focus management on auto-advance (council r1 a11y non-negotiable):** the existing `useEffect` on `[index]` in `ReviewDeck` (shipped in PR #42) already moves focus to the sr-only `headingRef` whenever `index` changes — and `handleNext()` increments `index`. So the rating → success → `handleNext()` path automatically triggers the same focus move that PR #42's "Next card" button does. No new code needed; the ReviewDeck.test.tsx test extension simply asserts that calling `handleRate` followed by `submitReview` returning `{ok: true}` results in `headingRef.current.focus()` being called (spied via the existing test seam). The test is the proof per the rebuttal-protocol rule.

```tsx
// JSX additions, rendered only when revealed:
{revealed && (
  <div className="mt-4 flex gap-2 flex-wrap" role="group" aria-label="Rate this card">
    <button type="button" onClick={() => handleRate(1)} disabled={pendingRating}
      className="bg-danger text-white px-4 py-2 rounded-md min-h-[44px]">
      {t('review.rating.again')}
    </button>
    <button type="button" onClick={() => handleRate(2)} disabled={pendingRating}
      className="bg-warning text-brand-900 px-4 py-2 rounded-md min-h-[44px]">
      {t('review.rating.hard')}
    </button>
    <button type="button" onClick={() => handleRate(3)} disabled={pendingRating}
      className="bg-success text-white px-4 py-2 rounded-md min-h-[44px]">
      {t('review.rating.good')}
    </button>
    <button type="button" onClick={() => handleRate(4)} disabled={pendingRating}
      className="bg-brand-900 text-white px-4 py-2 rounded-md min-h-[44px]">
      {t('review.rating.easy')}
    </button>
  </div>
)}
{ratingError && (
  <p role="alert" className="mt-2 text-danger text-sm">{ratingError}</p>
)}
```

**a11y:**
- `role="group"` + `aria-label="Rate this card"` so screen readers announce the rating cluster as a unit.
- `disabled={pendingRating}` prevents double-submit and conveys state to AT.
- `min-h-[44px]` on every rating button (touch target).
- Color tokens: `bg-danger` (Again), `bg-warning` (Hard), `bg-success` (Good), `bg-brand-900` (Easy). All exist in `globals.css`; contrast verified by the existing `axe-core` smoke test (extend the smoke spec to include the rating chrome).
- The "Next card" button is REPLACED by the 4 rating buttons during the rated phase — once a card is rated, we auto-advance, so a separate "Next" is unnecessary in the rated state. The existing "Next card" button remains visible WHEN NOT REVEALED (lets the user skip a card without rating it).

### E. i18n keys

```ts
'review.rating.again': 'Again',
'review.rating.hard': 'Hard',
'review.rating.good': 'Good',
'review.rating.easy': 'Easy',
'review.rating_error': "Couldn't save your rating. Please try again.",
'review.rating_rate_limit_error': "You're rating too quickly. Please wait a moment.",
'review.rating_pending': 'Saving…',
```

## Non-negotiables (must hold; council will not override)

- **Atomicity:** card state update + review_history insert MUST be in a single Postgres transaction. The `fn_review_card` SQL function is the boundary.
- **`security invoker` on `fn_review_card`:** never `security definer`; `auth.uid()` must flow through to RLS.
- **Rating validation BEFORE DB call:** server action rejects non-`{1,2,3,4}` ratings + non-UUID `cardId` shapes before any Supabase call. Defense in depth: SQL function also rejects, but the server-action rejection is the cheap-and-loud path.
- **PII discipline on logging:** server action error logs include `errorName` + `code` + `user_id` + `card_id` only; never `error.message`, never card content. ErrorBoundary log shape preserved.
- **No service-role client in the rating path:** all reads + the RPC call go through `supabaseForRequest`. RLS is the security model.
- **`fsrs_state = {}` is treated as "new card" and initialized via `emptyFsrsState()`:** never passed directly to `nextState()` (would crash on missing fields).
- **Auth gate:** unauthenticated server action calls return `{ok: false, errorKind: 'unauthenticated'}`; client navigates to `/auth`. NEVER mutate without an authenticated `user.id`.

## Tests (per the new rebuttal-protocol failure-mode requirement)

Each component has BOTH happy-path AND failure-mode coverage. Failure-mode coverage is the proof per `CLAUDE.md` §"Rebutting council findings" rule #2.

### `packages/lib/srs/src/index.test.ts` (algorithm contract; ~12 tests)

- **Happy path:**
  - `emptyFsrsState()` produces a state with `state: 0, reps: 0, lapses: 0`.
  - `nextState(empty, RATING_GOOD)` advances `reps` to 1 and sets `due` in the future.
- **Failure modes:**
  - `nextState(empty, RATING_AGAIN)` keeps `reps` low + sets `due` very soon (< 1 day).
  - `nextState(reviewed, RATING_AGAIN)` increments `lapses` (the algorithm's lapse counter).
  - **Ordering invariant:** for any state, `due(EASY) > due(GOOD) > due(HARD) > due(AGAIN)`. Property test across 20 random states. **This is the failure-mode proof for the algorithm: if the math breaks, ordering breaks.**
  - `isValidRating(0)`, `isValidRating(5)`, `isValidRating('3')`, `isValidRating(null)`, `isValidRating(undefined)` all return false. `isValidRating(1..4)` all return true.
  - `nextState(state, 5 as RatingValue)` — passing an invalid rating that's been (incorrectly) cast — does NOT silently produce a result; either throws or returns a sentinel. (ts-fsrs behavior TBD; test pins the contract whichever way it goes.)
  - `nextState` is determinism-tolerant: re-calling with same args + same `now` produces the same `state` shape, same `reps`/`lapses`/`state`. Fuzz-on may vary `due` by ±a small fraction; test asserts ordering, not exact value.

### `apps/web/app/review/actions.test.ts` (server-action behavior; ~16 tests)

- **Happy path:**
  - `submitReview(validId, 3, validKey)` with authed user + valid card → `{ok: true}` + `fn_review_card` RPC called with correct args (incl. `p_idempotency_key`) + `review.rating.submitted` counter fired.
  - `submitReview` on a never-reviewed card (`fsrs_state = {}`) → `parseFsrsState` returns `null` → `emptyFsrsState()` used; `nextState` called with the empty starting point, not `{}` directly.
- **Failure modes (the rebuttal-protocol failure-mode proof for this surface):**
  - `submitReview(validId, 0, validKey)` → `{ok: false, errorKind: 'invalid_rating'}` + `review.rating.rejected` counter + NO Supabase calls.
  - `submitReview(validId, 5, validKey)` → same.
  - `submitReview('not-a-uuid', 3, validKey)` → `{ok: false, errorKind: 'invalid_rating'}` + counter + no Supabase calls.
  - `submitReview(validId, 3, '')` → `{ok: false, errorKind: 'invalid_idempotency_key'}` + `review.rating.rejected` counter (`reason: 'invalid_idempotency_key'`) + no Supabase calls.
  - `submitReview(validId, 3, 'not-a-uuid')` → same.
  - `submitReview(validId, 3, validKey)` with no auth user → `{ok: false, errorKind: 'unauthenticated'}` + no `from('srs_cards')` call + no rate-limiter call.
  - **Council r1 security non-negotiable: explicit RLS-blocked test in this consistently-passing suite.** Stub `getUser` returns User A, stub `from('srs_cards').select().eq().single()` returns `{data: null, error: {code: 'PGRST116', message: 'NotFound'}}` (PostgREST's RLS-block shape) → `{ok: false, errorKind: 'card_not_found'}` + log shape verified PII-safe + counter fired with `reason: 'card_not_found'`. This is the failure-mode proof that User A cannot review User B's card via the RLS-scoped client.
  - **Council r1 bugs non-negotiable: idempotency replay is a no-op success.** Stub `fn_review_card` to return success on FIRST call. Run `submitReview(validId, 3, sameKey)` twice in sequence; assert second call still returns `{ok: true}` (RPC handled the dedup) and the second `submitReview` invocation's RPC call args include `p_idempotency_key: sameKey`. The on-conflict-do-nothing behavior is tested in pgTAP; this test verifies the server action's contract.
  - **Council r1 bugs non-negotiable: concurrent-update collision returns distinct error.** Stub `fn_review_card` to return `{error: {code: '40001', name: 'PostgresError', message: 'serialization_failure'}}` → `{ok: false, errorKind: 'concurrent_update'}` + counter (`reason: 'concurrent_update'`) + log shape PII-safe.
  - **Council r1 bugs non-negotiable: malformed `fsrs_state` returns invalid_state.** Stub the select to return `{data: {id, fsrs_state: {due: 12345}}, error: null}` (numeric `due` instead of ISO string → ZodError) → `{ok: false, errorKind: 'invalid_state'}` + log shape includes `errorName: 'ZodError'` + `issueCount` (a number) + counter; **assert log args do NOT contain `issue.path` or `issue.message`** (negative-assert sentinel: stub a malformed value `{due: 'PII_SENTINEL_DO_NOT_LOG'}` and assert serialized args don't contain the sentinel).
  - **Council r1 security non-negotiable: rate-limit exceeded.** Stub `ratingLimiter.reserve` to throw `RateLimitExceededError` → `{ok: false, errorKind: 'rate_limited'}` + counter (`reason: 'rate_limited'`) + NO `from('srs_cards')` call (rate-limit fires before the DB read).
  - **Rate-limit unavailable (Tier B/D fail-open posture):** stub `ratingLimiter.reserve` to throw `RatelimitUnavailableError` → continues to the rating (does NOT block) + the limiter helper logs the alert internally (verified by spying on the alert path).
  - `fn_review_card` RPC returns generic error (not 40001) → `{ok: false, errorKind: 'persist_failed'}` + log shape PII-safe + `review.rating.failed` counter with `reason: 'persist_failed'`.
  - **PII negative assertion (canonical):** stub the RPC to return an error with `message: 'CARDCONTENT_SECRET_DO_NOT_LOG: relation x'` — assert `JSON.stringify(spy.mock.calls)` does NOT contain the sentinel.
  - Counter labels never include card content (negative assert across all paths).

### `apps/web/components/ReviewDeck.test.tsx` (UI integration; ~9 new tests)

- Rating buttons NOT rendered when `revealed === false` (assert markup absence).
- Rating buttons rendered when `revealed === true`.
- Rating buttons have `min-h-[44px]` + `role="group"` + `aria-label`.
- Clicking Again/Hard/Good/Easy fires `submitReview` with the right rating value AND a `crypto.randomUUID`-shaped `idempotencyKey` (mock the action; assert third arg matches `UUID_RE`).
- On `{ok: false, errorKind: 'rate_limited'}`, error banner renders the rate-limit-specific copy (`review.rating_rate_limit_error`) with `role="alert"`.
- On any other `{ok: false}`, error banner renders the generic copy (`review.rating_error`).
- On `{ok: true}`, advances to next card (index increments + answer re-hides).
- **Council r1 a11y non-negotiable: focus moves to next card heading after auto-advance.** Spy on `headingRef.current.focus`; rate a card; await success; assert focus was called on the new card's heading. Re-uses the focus-mgmt seam shipped in PR #42.
- **Failure-mode:** double-click on a rating button doesn't fire `submitReview` twice (`pendingRating` guard).
- **Failure-mode:** unique idempotency key per click — clicking Again then (after error) clicking Hard generates two DIFFERENT keys (assert via spy on `crypto.randomUUID`).

### `packages/lib/ratelimit/src/index.test.ts` (Tier E extension; ~3 new tests)

- `makeRatingLimiter` returns a limiter that allows the 30th call in a minute.
- 31st call throws `RateLimitExceededError`.
- Different `userId` keys are isolated (User A's quota does not deplete User B's).

### `supabase/tests/fn_review_card.sql` (pgTAP; non-load-bearing per #7)

- Function signature exists.
- User A cannot review User B's card (returns RLS error).
- Invalid rating raises `22023`.
- Idempotency: second call with same `(user_id, idempotency_key)` returns success without creating a duplicate `review_history` row OR re-advancing `srs_cards.fsrs_state`.
- Concurrency: when `p_prev_state` doesn't match the current `srs_cards.fsrs_state`, raises `40001`.
- Atomicity: when called inside a savepoint that we then roll back, neither table changes (proves the function is participating in the transaction).

**Note per the new rebuttal-protocol rule:** the pgTAP suite is `continue-on-error` and known-flaky (#7). It cannot be cited as the proof for the rebuttal protocol. The `supabaseForRequest` server-action tests above ARE the consistently-passing failure-mode proof for the `card_not_found` (RLS-blocked), `concurrent_update` (40001), and idempotency-replay paths. Council r1 security non-negotiable: explicit RLS-blocked test in `actions.test.ts` is the canonical proof; pgTAP is corroborating.

## Risks

1. **`ts-fsrs` runtime dep adds bundle size.** ~10kb min+gz. The lib is server-side only (the algorithm runs in the server action), so the client bundle is unaffected. `ts-fsrs` only needs to be installed in the workspace package that imports it (`packages/lib/srs/`). Confirm via bundle-analyzer post-merge.
2. **Algorithm-correctness risk if `ts-fsrs` has bugs.** Mitigated by the ordering-invariant property test in §Tests (if math breaks, ordering breaks). FSRS-5 is a well-published spec; lib is the canonical TypeScript port.
3. **`security invoker` + RLS interaction subtleties.** The function's `select user_id into v_user_id` runs under the caller's auth context — if RLS blocks the select, `v_user_id` is null and we raise `42501`. Tested via the `card_not_found` server-action test path (consistently passing).
4. **Rapid-rating race conditions.** User clicks Again then immediately Good for the same card before the first server action returns. Mitigated at THREE layers (council r1 bugs fold):
   - **Client:** `pendingRating` state guards against double-clicks within a single tab.
   - **Server idempotency:** if the second click somehow reuses the same `idempotencyKey`, the SQL function's `on conflict do nothing` short-circuits the second to a no-op.
   - **Server optimistic concurrency:** if the second click generates a NEW key but races against the first's commit, the `WHERE fsrs_state = p_prev_state` UPDATE matches 0 rows → raises `40001` → server returns `concurrent_update`. Client re-fetches + re-rates against the new state.
   The three layers cover (a) same-tab double-click, (b) network retry of one click, (c) two-tab concurrent rating respectively. Tested.
5. **`ts-fsrs` API stability.** Pinned to an exact version in `packages/lib/srs/package.json` (council r1 security non-negotiable). Comment in the package.json + a `// VERSION-PINNED` comment in the wrapper file note that bumps require a council round (algorithm changes between FSRS-4 and FSRS-5 mattered; future bumps could too).
6. **Migration ordering.** New migration `20260424000001` runs after the existing `20260422000001_srs_cards_unique.sql`. Idempotent (uses `create or replace function`). Safe to re-run.
7. **No "undo" for an accidental rating.** Acknowledged out-of-scope; the lapse counter recovers from one wrong click via the next review's Again rating. Real undo is a UX feature for v2.

## Cost

Zero net runtime cost. The `submitReview` server action makes 1 Supabase select + 1 RPC per rating click. The FSRS algorithm runs in the server action (no LLM call). Estimate per active user: ~50 ratings/week × 4 ops/rating × $0 (covered by Supabase base fee) = $0/user/month.

`ts-fsrs` is a one-time dep cost (no per-call cost). Bundle size: server-side only, no impact on client.

## Out of scope (for the avoidance of doubt)

- Due-now filter on `/review` initial query (separate ticket; comes after rating UX is validated).
- Per-user FSRS parameter tuning.
- Multi-deck management / Anki-style organization.
- Review session boundaries.
- Heatmap / streak tracking.
- Undo last review.
- Mobile gesture rating (swipe).
- Keyboard shortcuts (1/2/3/4) — small follow-up.

## Acceptance criteria

- [ ] User can click Again/Hard/Good/Easy after revealing an answer; click is disabled when answer is hidden.
- [ ] Click triggers `submitReview` server action with a fresh `crypto.randomUUID()` idempotency key; response advances to next card on success.
- [ ] `srs_cards.fsrs_state` + `srs_cards.due_at` updated atomically with `review_history` insert.
- [ ] Never-reviewed card (`fsrs_state = {}`) initializes via `emptyFsrsState()` on first review.
- [ ] Unauthenticated rating attempts return `unauthenticated` error kind, no DB writes, no rate-limit consumption.
- [ ] User cannot review another user's card (RLS blocks via `security invoker`); explicit test in `actions.test.ts` (consistently passing) per the new rebuttal-protocol rule.
- [ ] Invalid rating values rejected before any DB call.
- [ ] Invalid idempotency-key shape rejected before any DB call.
- [ ] **Idempotency:** retry with same key is a no-op success; `srs_cards.fsrs_state` unchanged; no duplicate `review_history` row.
- [ ] **Optimistic concurrency:** second concurrent rating returns `concurrent_update` errorKind; first rating's state is preserved.
- [ ] **Zod parse:** malformed `fsrs_state` returns `invalid_state` errorKind; ZodError logged with `issueCount` only (never `issue.path` or `issue.message`).
- [ ] **Rate limit:** Tier E enforces 30/user/min; 31st rating in a minute returns `rate_limited` errorKind.
- [ ] **Rate-limit fail-open:** if the limiter is unavailable, the rating proceeds (alert logged, user not blocked).
- [ ] Server-action error logs are PII-safe (failure-mode test asserts negatively against sentinel).
- [ ] Counter labels never include card content (failure-mode test asserts negatively).
- [ ] `ordering invariant` property test passes for FSRS algorithm contract.
- [ ] All buttons ≥44px touch target, `role="group"` on rating cluster, `aria-label` present.
- [ ] **Focus moves to next card heading after auto-advance** (failure-mode test on the focus seam from PR #42).
- [ ] **`bg-warning` + `text-brand-900` contrast verified** to meet WCAG AA (3:1 for UI components); `axe-core` smoke test extended to include rating cluster markup.
- [ ] **`ts-fsrs` pinned to exact version** in `packages/lib/srs/package.json` (no `^` / `~`).
- [ ] **Down-migration exists** at `supabase/migrations/20260424000003_fn_review_card_down.sql`.
- [ ] `npm run lint`, `npm run typecheck`, `npm test` pass.
- [ ] Council PROCEED on the impl-diff round.

## Council prompts (anticipated axes)

- **Security:** `security invoker` choice (not definer); RLS coverage on `fn_review_card`; PII-safe logging; rating validation before DB call.
- **Bugs:** atomicity boundary (single SQL function vs two client calls); `fsrs_state = {}` new-card branch; double-click guard; rating range validation; concurrent-rating race.
- **Architecture:** wrapper-package pattern for `ts-fsrs`; server-action vs route-handler choice; SQL-function-as-transaction-boundary pattern.
- **Cost:** zero runtime — should sail. New runtime dep — council scrutiny on `ts-fsrs` choice vs minimal in-house.
- **Product:** Again/Hard/Good/Easy is the canonical FSRS rating set; closes the loop.
- **a11y:** rating button cluster `role="group"` + `aria-label`; pending state announced via `disabled` + `aria-busy`; focus-management when card auto-advances after rating.
