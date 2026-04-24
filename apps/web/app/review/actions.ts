'use server';

// /review submitReview server action — closes the SRS loop opened by PR #42.
// Council r1/r2 (PR #48) folded: idempotency key + optimistic concurrency +
// Zod validation + per-user rate limit + PII-safe error logging.
//
// PII DISCIPLINE (CLAUDE.md non-negotiable + the rebuttal-protocol rule):
//   srs_cards.{question, answer} are LLM output derived from user PDFs.
//   This action NEVER touches those columns AND NEVER logs error.message
//   (PostgREST messages can echo query/row text). Logged fields are
//   strictly: errorName, code, user_id, card_id, plus issueCount for
//   ZodError. Card content is NEVER a counter label.
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
import {
  makeRatingLimiter,
  RateLimitExceededError,
  RatelimitUnavailableError,
} from '@llmwiki/lib-ratelimit';
import { supabaseForRequest } from '../../lib/supabase';

export interface SubmitReviewResult {
  ok: boolean;
  errorKind?:
    | 'invalid_rating'
    | 'invalid_idempotency_key'
    | 'card_not_found'
    | 'persist_failed'
    | 'invalid_state'
    | 'concurrent_update'
    | 'rate_limited'
    | 'limiter_unavailable'
    | 'unauthenticated'
    | 'unhandled';
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Lazy-initialize the limiter so module import does NOT read env at
// load time. The route-module-load.test.ts CI guard requires every
// page/route module to import cleanly with env scrubbed (the original
// v0 deploy bug — see that test's header). Memoized after first call.
let _ratingLimiter: ReturnType<typeof makeRatingLimiter> | null = null;
function getRatingLimiter(): ReturnType<typeof makeRatingLimiter> {
  if (!_ratingLimiter) _ratingLimiter = makeRatingLimiter();
  return _ratingLimiter;
}

export async function submitReview(
  cardId: string,
  rating: number,
  idempotencyKey: string,
): Promise<SubmitReviewResult> {
  // Council r2 bugs nice-to-have fold: top-level try/catch so any
  // unhandled error (rate-limiter fail-open bug, ts-fsrs throw on edge
  // input, etc.) returns a structured response with PII-safe log instead
  // of bubbling to the framework as a 500.
  try {
    return await submitReviewImpl(cardId, rating, idempotencyKey);
  } catch (err) {
    const errorName = err instanceof Error ? err.name : typeof err;
    console.error('[/review submitReview] unhandled', { errorName });
    counter('review.rating.failed', { reason: 'unhandled' });
    return { ok: false, errorKind: 'unhandled' };
  }
}

async function submitReviewImpl(
  cardId: string,
  rating: number,
  idempotencyKey: string,
): Promise<SubmitReviewResult> {
  // Validate inputs BEFORE any DB call. Defense in depth — SQL function
  // also checks rating range, but cheap-and-loud rejection at the boundary
  // keeps PostgresError noise out of logs and Tier E quota intact.
  if (!isValidRating(rating)) {
    counter('review.rating.rejected', { reason: 'invalid_rating' });
    return { ok: false, errorKind: 'invalid_rating' };
  }
  if (!UUID_RE.test(cardId)) {
    counter('review.rating.rejected', { reason: 'invalid_card_id' });
    return { ok: false, errorKind: 'invalid_rating' };
  }
  if (!UUID_RE.test(idempotencyKey)) {
    counter('review.rating.rejected', { reason: 'invalid_idempotency_key' });
    return { ok: false, errorKind: 'invalid_idempotency_key' };
  }

  const rls = await supabaseForRequest();
  const {
    data: { user },
  } = await rls.auth.getUser();
  if (!user) {
    return { ok: false, errorKind: 'unauthenticated' };
  }

  // Per-user rate limit (Tier E, 30/min). Fail-CLOSED on both quota
  // exceeded AND limiter unavailable — matches Tier A/B/C pattern; only
  // Tier D fails open as a documented exception for time-boxed click-
  // through auth. A server-action mutation must not run unguarded
  // during an Upstash outage (DoS exposure on fn_review_card).
  // Council PR #50 r2 fold + PR #51 hot-fix.
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

  // Load the card's current state (RLS-scoped). If the user doesn't own
  // it OR it doesn't exist, the select returns null/error → card_not_found.
  // Council r1 security non-negotiable: this is the consistently-passing
  // RLS-blocked test target — actions.test.ts asserts that User A cannot
  // load User B's card via this path.
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
    counter('review.rating.failed', {
      reason: 'card_not_found',
      user_id: user.id,
    });
    return { ok: false, errorKind: 'card_not_found' };
  }

  // Council r1 bugs non-negotiable: parse fsrs_state through Zod before
  // passing to nextState. Malformed JSONB returns invalid_state instead
  // of crashing.
  let currentState: FsrsCardState;
  try {
    currentState = parseFsrsState(card.fsrs_state) ?? emptyFsrsState();
  } catch (err) {
    if (err instanceof ZodError) {
      console.error('[/review submitReview] invalid_state', {
        errorName: 'ZodError',
        // Count only — never issue.path or issue.message; path could
        // include card content under deep validation.
        issueCount: err.issues.length,
        user_id: user.id,
        card_id: cardId,
      });
      counter('review.rating.failed', {
        reason: 'invalid_state',
        user_id: user.id,
      });
      return { ok: false, errorKind: 'invalid_state' };
    }
    throw err;
  }

  // Compute next state. nextState is a pure function on validated input;
  // a throw here would be a library bug. Surface to the top-level catch.
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
    // Distinct error kind so the client can re-fetch + retry against the
    // new state.
    const errorKind: SubmitReviewResult['errorKind'] =
      code === '40001' ? 'concurrent_update' : 'persist_failed';
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
