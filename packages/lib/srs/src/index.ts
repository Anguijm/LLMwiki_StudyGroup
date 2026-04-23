// FSRS scheduling wrapper. Localizes the ts-fsrs import to one file so
// the rest of the codebase depends on the typed contract below, not the
// underlying lib's API surface. A future swap (different lib, in-house
// impl) only touches this file.
//
// VERSION-PINNED: Bumps require security council review. The ts-fsrs
// algorithm version (FSRS-4 → FSRS-5) changed scheduling math; bumps
// could change every user's review schedule. See packages/lib/srs/
// package.json + the council r1 security non-negotiable on PR #48.
import { z } from 'zod';
import { FSRS, generatorParameters, type Card, type Grade } from 'ts-fsrs';

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
 * Council r1 bugs fold (PR #48): the Zod schema below is the runtime
 * validator. Any read of fsrs_state from the DB MUST go through
 * `parseFsrsState` before passing to `nextState` — protects against
 * malformed JSONB from a past bug, manual edit, or schema drift.
 */
export interface FsrsCardState {
  due: string;
  stability: number;
  difficulty: number;
  elapsed_days: number;
  scheduled_days: number;
  // ts-fsrs v5 added `learning_steps` to track the index within the
  // (re)learning step sequence ([1m, 10m] by default). Persisted so
  // resuming a card mid-learning works correctly.
  learning_steps: number;
  reps: number;
  lapses: number;
  state: 0 | 1 | 2 | 3;
  last_review?: string;
}

export const FsrsCardStateSchema = z.object({
  due: z.string().datetime({ offset: true }),
  stability: z.number().finite().nonnegative(),
  difficulty: z.number().finite(),
  elapsed_days: z.number().finite().nonnegative(),
  scheduled_days: z.number().finite().nonnegative(),
  learning_steps: z.number().int().nonnegative(),
  reps: z.number().int().nonnegative(),
  lapses: z.number().int().nonnegative(),
  state: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]),
  last_review: z.string().datetime({ offset: true }).optional(),
});

/**
 * Parse a value (typically `srs_cards.fsrs_state` from a Supabase select)
 * into a typed `FsrsCardState`.
 *
 * Returns `null` for the empty-state sentinels (`null`, `undefined`, `{}`)
 * so the caller can branch to `emptyFsrsState()` for never-reviewed cards.
 *
 * Throws `ZodError` on a non-empty malformed shape so the caller can decide
 * whether to fail loud (server action returns invalid_state) or fall back
 * to a fresh empty state. The decision is intentionally NOT made here —
 * this is the validator, not the policy.
 *
 * Council r2 bugs nice-to-have fold (PR #48): also handles `null` and
 * non-object inputs robustly (throws ZodError instead of crashing on
 * Object.keys(null)).
 */
export function parseFsrsState(raw: unknown): FsrsCardState | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'object') {
    // Force a ZodError so the caller's catch path treats this like any
    // other malformed-state branch. Re-using the schema's parse() is the
    // shortest path to that contract.
    return FsrsCardStateSchema.parse(raw);
  }
  if (Object.keys(raw as object).length === 0) return null;
  return FsrsCardStateSchema.parse(raw);
}

/**
 * Initial state for a never-reviewed card. Matches ts-fsrs's empty-card
 * shape but spelled out so the contract is readable + testable without
 * importing the lib.
 */
export function emptyFsrsState(now: Date = new Date()): FsrsCardState {
  return {
    due: now.toISOString(),
    stability: 0,
    difficulty: 0,
    elapsed_days: 0,
    scheduled_days: 0,
    learning_steps: 0,
    reps: 0,
    lapses: 0,
    state: 0,
  };
}

const fsrs = new FSRS(generatorParameters({ enable_fuzz: true }));

/**
 * Pure function: given the current state + a rating + "now", compute the
 * next state and the next due date.
 *
 * "Pure" with one caveat: ts-fsrs's `enable_fuzz=true` adds randomness to
 * the scheduled interval (anti-clustering on cards reviewed in batches).
 * Tests that assert exact intervals must seed Math.random or disable fuzz;
 * tests that assert ordering ("Easy interval > Good interval > Hard
 * interval > Again interval") are fuzz-stable.
 */
export function nextState(
  current: FsrsCardState,
  rating: RatingValue,
  now: Date = new Date(),
): { state: FsrsCardState; due: Date } {
  const card: Card = {
    due: new Date(current.due),
    stability: current.stability,
    difficulty: current.difficulty,
    elapsed_days: current.elapsed_days,
    scheduled_days: current.scheduled_days,
    learning_steps: current.learning_steps,
    reps: current.reps,
    lapses: current.lapses,
    state: current.state as Card['state'],
    last_review: current.last_review ? new Date(current.last_review) : undefined,
  };

  const result = fsrs.next(card, now, rating as Grade);
  const next = result.card;

  return {
    state: {
      due: next.due.toISOString(),
      stability: next.stability,
      difficulty: next.difficulty,
      elapsed_days: next.elapsed_days,
      scheduled_days: next.scheduled_days,
      learning_steps: next.learning_steps,
      reps: next.reps,
      lapses: next.lapses,
      state: next.state as FsrsCardState['state'],
      last_review: next.last_review?.toISOString(),
    },
    due: next.due,
  };
}
