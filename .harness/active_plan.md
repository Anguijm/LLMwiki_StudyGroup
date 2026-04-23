# Plan: FSRS rating + scheduling on /review (closes the SRS loop)

**Status:** draft, awaiting council + human approval.
**Branch:** `claude/fsrs-scoring`.
**Scope:** rating UI on `/review` (Again/Hard/Good/Easy) + server action that runs the FSRS algorithm + persists state. New runtime dep (`ts-fsrs`). New typed wrappers around `srs_cards.fsrs_state` and `review_history.{prev,next}_state`. **No `[skip council]`** — new external lib + auth-gated mutation surface + the kind of state-machine math council should scrutinize.

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

- `apps/web/package.json` — add `ts-fsrs` (pinned, exact version). Runtime dep.
- `packages/lib/srs/` — new tiny package wrapping `ts-fsrs` with our domain types + a single `nextState(currentState, rating)` pure function. Reasons for a wrapper package:
  1. Keeps `ts-fsrs` import surface narrow — only one file imports it.
  2. Lets us swap the underlying lib later without touching app code.
  3. Provides a single test-target for the algorithm contract (failure-mode tests live here per the new rebuttal-protocol rule).
- `apps/web/app/review/actions.ts` — new server action `submitReview(cardId, rating)`. RLS-scoped via `supabaseForRequest`; runs `nextState`; persists via a Postgres function (`fn_review_card`) called via Supabase RPC for atomicity.
- `supabase/migrations/20260424000001_fn_review_card.sql` — new SQL function `fn_review_card(p_card_id uuid, p_rating smallint, p_next_state jsonb, p_due_at timestamptz, p_prev_state jsonb)` that updates `srs_cards.fsrs_state` + `due_at` AND inserts `review_history` in a single transaction. RLS via `security invoker` (so the caller's `auth.uid()` is checked against `srs_cards_own` + `review_history_own`).
- `apps/web/app/review/ReviewDeck.tsx` — extend with rating buttons (4 buttons after answer reveal, hidden before reveal); wire to the server action; on success, call existing `handleNext`.
- `apps/web/lib/i18n.ts` — 6 new keys: `review.rating.again`, `review.rating.hard`, `review.rating.good`, `review.rating.easy`, `review.rating_error`, `review.rating_pending`.
- Tests:
  - `packages/lib/srs/src/index.test.ts` — algorithm contract, failure-mode coverage (see §Tests).
  - `apps/web/app/review/actions.test.ts` — server-action behavior, RLS enforcement, transaction atomicity stub, PII-safe logging, rating validation.
  - `apps/web/components/ReviewDeck.test.tsx` — rating buttons disabled before reveal, enabled after, fire on click, advance card on success.
  - `supabase/tests/fn_review_card.sql` — pgTAP test for the SQL function (acknowledged-flaky per #7; written but not load-bearing for the rebuttal protocol).

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

### B. SQL function — `supabase/migrations/20260424000001_fn_review_card.sql`

```sql
-- Atomic update: srs_cards.fsrs_state + due_at AND insert review_history,
-- in one transaction. Avoids the "card updated but history insert failed"
-- split-brain that two separate Supabase client calls could produce.
--
-- security invoker: caller's auth.uid() flows through to RLS checks on
-- srs_cards_own + review_history_own. A user can only review their own
-- cards.
create or replace function public.fn_review_card(
  p_card_id uuid,
  p_rating smallint,
  p_next_state jsonb,
  p_due_at timestamptz,
  p_prev_state jsonb
) returns void
language plpgsql
security invoker
as $$
declare
  v_user_id uuid;
begin
  -- Validate rating range here (defense in depth — server action also checks).
  if p_rating not in (1, 2, 3, 4) then
    raise exception 'invalid rating: %', p_rating using errcode = '22023';
  end if;

  -- Read user_id from the card row, scoped by RLS. If the row is invisible
  -- (RLS blocks: not the user's card) OR doesn't exist, this returns 0 rows
  -- and the subsequent update is a no-op — but the insert below would fail
  -- on the FK constraint. So fail loudly here instead.
  select user_id into v_user_id
    from public.srs_cards
    where id = p_card_id;
  if v_user_id is null then
    raise exception 'card not found or not accessible: %', p_card_id
      using errcode = '42501'; -- insufficient_privilege
  end if;

  -- Update the card's state. RLS check is on `using` (read) + `with check`
  -- (write); both pass since v_user_id = auth.uid() (we just selected it
  -- under RLS).
  update public.srs_cards
    set fsrs_state = p_next_state,
        due_at = p_due_at
    where id = p_card_id;

  -- Insert the review log. RLS `with check` enforces user_id = auth.uid().
  insert into public.review_history (card_id, user_id, rating, prev_state, next_state)
    values (p_card_id, v_user_id, p_rating, p_prev_state, p_next_state);
end;
$$;

comment on function public.fn_review_card(uuid, smallint, jsonb, timestamptz, jsonb) is
  'Atomic review: update srs_cards.fsrs_state + due_at AND insert review_history. RLS-scoped via security invoker. Argument order is positional: (card_id, rating, next_state, due_at, prev_state).';

-- Grant exec to authenticated users; RLS does the per-row gating.
revoke all on function public.fn_review_card(uuid, smallint, jsonb, timestamptz, jsonb) from public;
grant execute on function public.fn_review_card(uuid, smallint, jsonb, timestamptz, jsonb) to authenticated;
```

**Why a SQL function instead of two sequential Supabase client calls:** atomicity. Two client calls = network-level non-atomicity = a partial state where the card's `fsrs_state` advanced but no `review_history` row exists. That's debt: the audit trail is broken, and re-rating the card would compute from the new state without remembering it was just reviewed. A single transaction inside Postgres is the correct boundary.

**Why `security invoker` not `security definer`:** definer would bypass RLS using the function-owner's permissions — defeats the entire RLS model. Invoker means `auth.uid()` is the calling user, and the existing per-user RLS policies on both tables enforce ownership.

### C. Server action — `apps/web/app/review/actions.ts`

```ts
'use server';

import { redirect } from 'next/navigation';
import { counter } from '@llmwiki/lib-metrics';
import {
  isValidRating,
  emptyFsrsState,
  nextState,
  type FsrsCardState,
  type RatingValue,
} from '@llmwiki/lib-srs';
import { supabaseForRequest } from '../../lib/supabase';

export interface SubmitReviewResult {
  ok: boolean;
  errorKind?: 'invalid_rating' | 'card_not_found' | 'persist_failed' | 'unauthenticated';
}

export async function submitReview(cardId: string, rating: number): Promise<SubmitReviewResult> {
  // Reject malformed ratings BEFORE any DB call (defense in depth — fn also checks).
  if (!isValidRating(rating)) {
    counter('review.rating.rejected', { reason: 'invalid_rating' });
    return { ok: false, errorKind: 'invalid_rating' };
  }
  // UUID v4 shape check — Supabase will reject non-UUIDs with a 22P02 anyway,
  // but cheap to short-circuit + avoid leaking PostgresError noise into logs.
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(cardId)) {
    counter('review.rating.rejected', { reason: 'invalid_card_id' });
    return { ok: false, errorKind: 'invalid_rating' };
  }

  const rls = await supabaseForRequest();
  const { data: { user } } = await rls.auth.getUser();
  if (!user) {
    // Don't redirect from a server action — return so the client can navigate.
    return { ok: false, errorKind: 'unauthenticated' };
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
    counter('review.rating.failed', { reason: 'card_not_found' });
    return { ok: false, errorKind: 'card_not_found' };
  }

  // Compute next state. fsrs_state may be {} for a never-reviewed card —
  // emptyFsrsState() initializes the FSRS-5 starting point.
  const currentState =
    Object.keys(card.fsrs_state ?? {}).length === 0
      ? emptyFsrsState()
      : (card.fsrs_state as FsrsCardState);

  const { state: next, due } = nextState(currentState, rating as RatingValue);

  // Persist atomically via the SQL function.
  const { error: rpcErr } = await rls.rpc('fn_review_card', {
    p_card_id: cardId,
    p_rating: rating,
    p_next_state: next,
    p_due_at: due.toISOString(),
    p_prev_state: currentState,
  });
  if (rpcErr) {
    console.error('[/review submitReview] persist_failed', {
      errorName: rpcErr.name ?? 'UnknownError',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- supabase error untyped
      code: (rpcErr as any)?.code ?? null,
      user_id: user.id,
      card_id: cardId,
    });
    counter('review.rating.failed', { reason: 'persist_failed' });
    return { ok: false, errorKind: 'persist_failed' };
  }

  counter('review.rating.submitted', {
    user_id: user.id,
    rating: String(rating),
    is_new_card: currentState.state === 0 ? 'true' : 'false',
  });
  return { ok: true };
}
```

**PII discipline (per CLAUDE.md non-negotiables + the new rebuttal protocol):** error logs include `errorName` + `code` + `user_id` + `card_id` only — never card content, never `error.message` (which can echo query/row text). Counter labels: `user_id`, `card_id` (UUIDs, pseudonyms not PII), `rating` (small int), `is_new_card` (boolean). Card content is NEVER a label.

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
  try {
    const result = await submitReview(card.id, rating);
    if (!result.ok) {
      setRatingError(t('review.rating_error'));
      setPendingRating(false);
      return;
    }
    counter('review.card.rated', { rating: String(rating) });
    handleNext(); // Advances + re-hides answer.
    setPendingRating(false);
  } catch {
    // Server action threw (network, etc.). Don't log error.message — could
    // contain serialized server state.
    setRatingError(t('review.rating_error'));
    setPendingRating(false);
  }
};
```

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

### `apps/web/app/review/actions.test.ts` (server-action behavior; ~10 tests)

- **Happy path:**
  - `submitReview(validId, 3)` with authed user + valid card → `{ok: true}` + `fn_review_card` RPC called with correct args + `review.rating.submitted` counter fired.
  - `submitReview` on a never-reviewed card (`fsrs_state = {}`) → `nextState` is called with `emptyFsrsState()`, not `{}` directly.
- **Failure modes (the rebuttal-protocol failure-mode proof for this surface):**
  - `submitReview(validId, 0)` → `{ok: false, errorKind: 'invalid_rating'}` + `review.rating.rejected` counter + NO Supabase calls made.
  - `submitReview(validId, 5)` → same.
  - `submitReview('not-a-uuid', 3)` → `{ok: false, errorKind: 'invalid_rating'}` + counter + no Supabase calls.
  - `submitReview(validId, 3)` with no auth user → `{ok: false, errorKind: 'unauthenticated'}` + no `from('srs_cards')` call.
  - Card not owned by user (RLS blocks the select → returns null) → `{ok: false, errorKind: 'card_not_found'}` + log shape verified PII-safe (negative-assert sentinel string).
  - `fn_review_card` RPC returns error → `{ok: false, errorKind: 'persist_failed'}` + log shape PII-safe + `review.rating.failed` counter with `reason: 'persist_failed'`.
  - **PII negative assertion:** stub the RPC to return an error with `message: 'CARDCONTENT_SECRET_DO_NOT_LOG: relation x'` — assert `JSON.stringify(spy.mock.calls)` does NOT contain the sentinel.
  - Counter labels never include card content (negative assert).

### `apps/web/components/ReviewDeck.test.tsx` (UI integration; ~6 new tests)

- Rating buttons NOT rendered when `revealed === false` (assert markup absence).
- Rating buttons rendered when `revealed === true`.
- Rating buttons have `min-h-[44px]` + `role="group"` + `aria-label`.
- Clicking Again/Hard/Good/Easy fires `submitReview` with the right rating value (mock the action).
- On `{ok: false}`, error banner renders with `role="alert"`.
- On `{ok: true}`, advances to next card (index increments + answer re-hides).
- **Failure-mode:** double-click on a rating button doesn't fire `submitReview` twice (`pendingRating` guard).

### `supabase/tests/fn_review_card.sql` (pgTAP; non-load-bearing per #7)

- Function signature exists.
- User A cannot review User B's card (returns RLS error).
- Invalid rating raises `22023`.
- Atomicity: when called inside a savepoint that we then roll back, neither table changes (proves the function is participating in the transaction).

**Note per the new rebuttal-protocol rule:** the pgTAP suite is `continue-on-error` and known-flaky (#7). It cannot be cited as the proof for the RLS rebuttal protocol. The `supabaseForRequest` server-action tests above ARE the consistently-passing failure-mode proof for the `card_not_found` (RLS-blocked) path.

## Risks

1. **`ts-fsrs` runtime dep adds bundle size.** ~10kb min+gz. The lib is server-side only (the algorithm runs in the server action), so the client bundle is unaffected. `ts-fsrs` only needs to be installed in the workspace package that imports it (`packages/lib/srs/`). Confirm via bundle-analyzer post-merge.
2. **Algorithm-correctness risk if `ts-fsrs` has bugs.** Mitigated by the ordering-invariant property test in §Tests (if math breaks, ordering breaks). FSRS-5 is a well-published spec; lib is the canonical TypeScript port.
3. **`security invoker` + RLS interaction subtleties.** The function's `select user_id into v_user_id` runs under the caller's auth context — if RLS blocks the select, `v_user_id` is null and we raise `42501`. Tested via the `card_not_found` server-action test path (consistently passing).
4. **Rapid-rating race conditions.** User clicks Again then immediately Good for the same card before the first server action returns. Mitigated by `pendingRating` state in the client + `useState` updater discipline. Tested.
5. **`ts-fsrs` API stability.** Pin to an exact version in `package.json`; document in a comment that bumps need a council round (algorithm changes between FSRS-4 and FSRS-5 mattered; future bumps could too).
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
- [ ] Click triggers `submitReview` server action; response advances to next card on success.
- [ ] `srs_cards.fsrs_state` + `srs_cards.due_at` updated atomically with `review_history` insert.
- [ ] Never-reviewed card (`fsrs_state = {}`) initializes via `emptyFsrsState()` on first review.
- [ ] Unauthenticated rating attempts return `unauthenticated` error kind, no DB writes.
- [ ] User cannot review another user's card (RLS blocks via `security invoker`).
- [ ] Invalid rating values rejected before any DB call.
- [ ] Server-action error logs are PII-safe (failure-mode test asserts negatively against sentinel).
- [ ] Counter labels never include card content (failure-mode test asserts negatively).
- [ ] `ordering invariant` property test passes for FSRS algorithm contract.
- [ ] All buttons ≥44px touch target, `role="group"` on rating cluster, `aria-label` present.
- [ ] `npm run lint`, `npm run typecheck`, `npm test` pass.
- [ ] Council PROCEED on the impl-diff round.

## Council prompts (anticipated axes)

- **Security:** `security invoker` choice (not definer); RLS coverage on `fn_review_card`; PII-safe logging; rating validation before DB call.
- **Bugs:** atomicity boundary (single SQL function vs two client calls); `fsrs_state = {}` new-card branch; double-click guard; rating range validation; concurrent-rating race.
- **Architecture:** wrapper-package pattern for `ts-fsrs`; server-action vs route-handler choice; SQL-function-as-transaction-boundary pattern.
- **Cost:** zero runtime — should sail. New runtime dep — council scrutiny on `ts-fsrs` choice vs minimal in-house.
- **Product:** Again/Hard/Good/Easy is the canonical FSRS rating set; closes the loop.
- **a11y:** rating button cluster `role="group"` + `aria-label`; pending state announced via `disabled` + `aria-busy`; focus-management when card auto-advances after rating.
