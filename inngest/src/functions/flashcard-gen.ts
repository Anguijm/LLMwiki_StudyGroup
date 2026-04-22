// note.created.flashcards Inngest function — generates 5–10 SRS flashcards
// per note via Claude Haiku and persists them to srs_cards.
//
// Steps (each step.run + idempotent via UNIQUE (note_id, question)):
//   1. load-note: service-role fetch of notes row
//      (short-circuits on empty/oversized body)
//   2. token-budget-reserve: Tier B reservation, estimated dynamically
//   3. generate: Claude Haiku call with <untrusted_content> wrapping
//   4. persist: insert with onConflict: 'note_id,question', ignoreDuplicates
//
// Function-level onFailure hook refunds the reserved token budget via
// makeTokenBudgetLimiter().refund(). See refundFlashcardBudget below.
//
// Council rounds on PR #37:
//   r1 — idempotency: 'event.id', dynamic token estimate, empty-body
//        short-circuit, 10-card hard reject, COMMENT ON COLUMN provenance,
//        onFailure as its own step, flashcard.gen.latency histogram.
//   r2 — MAX_BODY_CHARS cap, non-Latin bias accepted, /review P0 ticket #38
//        filed, tile of stopgap-vs-semantic-chunking noted (issue #39).
//   r3 — FK-violation non-retryable wrapping (Postgres code 23503),
//        RLS verification confirmed before merge.

import { NonRetriableError } from 'inngest';
import { inngest } from '../client';
import { counter, histogram } from '@llmwiki/lib-metrics';
import { supabaseService } from '@llmwiki/db/server';
import { makeAnthropicClient } from '@llmwiki/lib-ai';
import { FLASHCARD_GEN_V1 } from '@llmwiki/prompts';
import { requireEnv } from '@llmwiki/lib-utils/env';
import {
  makeTokenBudgetLimiter,
  RateLimitExceededError,
  RatelimitUnavailableError,
} from '@llmwiki/lib-ratelimit';

// Caps + tuning constants. Comments document the "why".
const MAX_BODY_CHARS = 500_000;
// Postgres error code for foreign-key violation. When persist fails with
// this code (e.g., user/cohort deleted mid-flow), retrying won't help —
// wrap in NonRetriableError to skip the 2-retry budget and surface fast.
const PG_FK_VIOLATION = '23503';

export class NoteNotFoundError extends Error {
  override readonly name = 'NoteNotFoundError';
  constructor(public readonly noteId: string) {
    super(`note not found: ${noteId}`);
  }
}

/**
 * Carries the reservedTokens amount across the failure boundary so
 * onFailure can refund the EXACT value that was reserved in the main
 * execution, rather than recomputing from a re-fetched notes row that
 * may have been edited between reservation and failure.
 *
 * Council r5 bugs: "the onFailure token refund amount must be the exact
 * value reserved in the main function execution, not a value
 * recalculated from a potentially stale notes row."
 *
 * Any throw AFTER `token-budget-reserve` succeeds should be wrapped in
 * this error (or have `reservedTokens` attached to its cause chain) so
 * onFailure can extract it.
 */
export class ReservationAwareError extends Error {
  override readonly name = 'ReservationAwareError';
  constructor(
    public readonly reservedTokens: number,
    public readonly userId: string,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

/**
 * Walk an error's cause chain looking for a ReservationAwareError and
 * return its { reservedTokens, userId } payload if found.
 */
export function extractReservation(
  err: unknown,
): { reservedTokens: number; userId: string } | null {
  // Walk up to 10 levels of cause to avoid pathological cycles.
  let cur = err;
  for (let i = 0; i < 10 && cur != null; i++) {
    if (cur instanceof ReservationAwareError) {
      return { reservedTokens: cur.reservedTokens, userId: cur.userId };
    }
    cur = (cur as { cause?: unknown }).cause;
  }
  return null;
}

/**
 * Estimate token reservation from note body length. English/Latin-biased
 * heuristic (body.length / 4 ≈ tokens); CJK notes under-reserve by ~3×
 * and fail closed via Tier B's RateLimitExceededError — accepted v0
 * limitation (cohort is English by product design; multi-language
 * estimation is v1 work tracked alongside semantic chunking in #39).
 *
 * Adds a fixed 1500-token overhead for the system prompt + output
 * budget. Minimum floor of 1500 handles notes <1500 chars.
 */
export function estimateFlashcardTokens(bodyLength: number): number {
  return Math.max(1500, Math.ceil(bodyLength / 4) + 1500);
}

/**
 * onFailure refund helper. Two modes:
 *
 *   1. **Exact mode** (preferred): caller passes `reservation` with the
 *      exact { reservedTokens, userId } extracted from the failing
 *      error's cause chain. Council r5 bugs non-negotiable — this is
 *      the mode onFailure uses in practice.
 *
 *   2. **Fallback mode**: no reservation payload available (e.g., the
 *      failure happened BEFORE `token-budget-reserve` ran, so there's
 *      no reservedTokens to carry). In this mode the helper re-fetches
 *      the note and estimates from body length. If the note can't be
 *      fetched, skip refund entirely. This mode over/under-refunds by
 *      bounded drift if the body changed mid-flow, but only runs when
 *      no exact value is available.
 */
export async function refundFlashcardBudget(
  noteId: string,
  reservation?: { reservedTokens: number; userId: string },
): Promise<void> {
  const tokenBudget = makeTokenBudgetLimiter();
  if (reservation) {
    await tokenBudget.refund(reservation.userId, reservation.reservedTokens);
    counter('flashcard.gen.budget_refunded', {
      note_id: noteId,
      amount: reservation.reservedTokens,
      source: 'exact' as const,
    });
    return;
  }
  const supabase = supabaseService();
  const { data: note, error } = await supabase
    .from('notes')
    .select('user_id, body')
    .eq('id', noteId)
    .single();
  if (error || !note) return; // can't identify user — skip
  const estimated = estimateFlashcardTokens(
    typeof note.body === 'string' ? note.body.length : 0,
  );
  await tokenBudget.refund(note.user_id, estimated);
  counter('flashcard.gen.budget_refunded', {
    note_id: noteId,
    amount: estimated,
    source: 'fallback' as const,
  });
}

// Minimal step-tool shape the handler needs. Tests stub this.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type StepRun = <T>(id: string, fn: () => Promise<T>) => Promise<T>;
interface StepTools {
  run: StepRun;
}

export interface FlashcardHandlerArgs {
  event: { data: { note_id: string } };
  step: StepTools;
}

export type FlashcardHandlerResult =
  | { ok: true; count: number; skipped?: never }
  | { ok: true; count: 0; skipped: 'empty_body' | 'body_too_long' };

/**
 * Core handler logic. Exported for direct unit testing; wired into the
 * Inngest runtime below via noteCreatedFlashcards.
 */
export async function runNoteCreatedFlashcards(
  { event, step }: FlashcardHandlerArgs,
): Promise<FlashcardHandlerResult> {
    const { note_id } = event.data;
    const startedAt = Date.now();
    counter('flashcard.gen.received', { note_id });

    // ----- Step 1: load note -------------------------------------------
    const note = await step.run('load-note', async () => {
      const sb = supabaseService();
      const { data, error } = await sb
        .from('notes')
        .select('id, body, user_id, cohort_id')
        .eq('id', note_id)
        .single();
      if (error || !data) {
        // Council r4 bugs: a missing note will stay missing across
        // retries. Wrap in NonRetriableError so Inngest skips the
        // 2-retry budget and surfaces the failure immediately.
        throw new NonRetriableError(`note not found: ${note_id}`, {
          cause: new NoteNotFoundError(note_id),
        });
      }
      return data as {
        id: string;
        body: string | null;
        user_id: string;
        cohort_id: string;
      };
    });

    // Empty / whitespace / oversized body short-circuits BEFORE reserving
    // tokens or calling Claude (council r1/r2 bugs).
    if (!note.body || note.body.trim().length === 0) {
      counter('flashcard.gen.skipped', { note_id, reason: 'empty_body' });
      // Council r4 bugs: latency histogram emitted on every success
      // return path, including skips — consistent observability.
      histogram('flashcard.gen.latency', Date.now() - startedAt, { note_id });
      return { ok: true, count: 0, skipped: 'empty_body' as const };
    }
    if (note.body.length > MAX_BODY_CHARS) {
      counter('flashcard.gen.skipped', {
        note_id,
        reason: 'body_too_long',
        body_length: note.body.length,
      });
      histogram('flashcard.gen.latency', Date.now() - startedAt, { note_id });
      return { ok: true, count: 0, skipped: 'body_too_long' as const };
    }

    // ----- Step 2: reserve token budget --------------------------------
    const estimatedTokens = estimateFlashcardTokens(note.body.length);
    await step.run('token-budget-reserve', async () => {
      const tokenBudget = makeTokenBudgetLimiter();
      try {
        await tokenBudget.reserve(note.user_id, estimatedTokens);
      } catch (err) {
        if (err instanceof RateLimitExceededError) {
          // User has exhausted their Tier B budget. Non-retryable: waiting
          // won't change the outcome within the retry window.
          throw new NonRetriableError(
            `token budget exceeded for user ${note.user_id}`,
            { cause: err },
          );
        }
        if (err instanceof RatelimitUnavailableError) {
          // Upstash down — retryable (might recover).
          throw err;
        }
        throw err;
      }
    });

    // ----- Step 3: generate --------------------------------------------
    const cards = await step.run('generate', async () => {
      const claude = makeAnthropicClient({
        apiKey: requireEnv('ANTHROPIC_API_KEY'),
      });
      try {
        const result = await claude.generateFlashcards({
          systemPrompt: FLASHCARD_GEN_V1,
          noteBody: note.body as string,
        });
        counter('flashcard.gen.completed', {
          note_id,
          count: result.cards.length,
          input_tokens: result.usage.input_tokens,
          output_tokens: result.usage.output_tokens,
        });
        // Council r4 metrics: heuristic-accuracy observability. If actual
        // input_tokens exceeded the reservation, the Tier B budget was
        // temporarily over-committed. Auto-recovers (sliding window),
        // but if this counter trends up we have signal that the
        // heuristic needs tuning (e.g., non-Latin cohort joined).
        if (result.usage.input_tokens > estimatedTokens) {
          counter('flashcard.gen.token_estimate_mismatch', {
            note_id,
            estimated: estimatedTokens,
            actual: result.usage.input_tokens,
            overshoot: result.usage.input_tokens - estimatedTokens,
          });
        }
        return result.cards;
      } catch (err) {
        counter('flashcard.gen.failed', { stage: 'generate', note_id });
        // Wrap so onFailure can refund the EXACT reserved amount
        // (council r5 bugs). Preserve original error as cause for
        // diagnostics + retry classification.
        throw new ReservationAwareError(
          estimatedTokens,
          note.user_id,
          err instanceof Error ? err.message : String(err),
          { cause: err },
        );
      }
    });

    if (cards.length === 0) {
      counter('flashcard.persisted', { note_id, count: 0 });
      histogram('flashcard.gen.latency', Date.now() - startedAt, { note_id });
      return { ok: true, count: 0 };
    }

    // ----- Step 4: persist ---------------------------------------------
    await step.run('persist', async () => {
      const sb = supabaseService();
      const rows = cards.map((c) => ({
        note_id: note.id,
        question: c.question,
        answer: c.answer,
        user_id: note.user_id,
        cohort_id: note.cohort_id,
      }));
      // upsert + ignoreDuplicates is the PostgREST equivalent of INSERT ...
      // ON CONFLICT DO NOTHING — per-row dedup against the UNIQUE
      // (note_id, question) constraint from migration 20260422000001.
      const { error } = await sb
        .from('srs_cards')
        .upsert(rows, { onConflict: 'note_id,question', ignoreDuplicates: true });
      if (error) {
        counter('flashcard.gen.failed', { stage: 'persist', note_id });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- supabase error untyped
        const code = (error as any)?.code;
        if (code === PG_FK_VIOLATION) {
          // Council r3: FK-violation (e.g., user/cohort deleted
          // mid-flow) is non-retryable. Council r5 bugs: wrap in
          // ReservationAwareError first so onFailure refunds the exact
          // reserved amount, then in NonRetriableError to skip the
          // retry budget. Non-retryable reason counter for observability.
          counter('flashcard.gen.failed', {
            stage: 'persist',
            note_id,
            reason: 'non_retryable' as const,
          });
          throw new NonRetriableError(
            `persist failed: FK violation (${code})`,
            {
              cause: new ReservationAwareError(
                estimatedTokens,
                note.user_id,
                `FK violation (${code})`,
                { cause: error },
              ),
            },
          );
        }
        throw new ReservationAwareError(
          estimatedTokens,
          note.user_id,
          `persist failed`,
          { cause: error },
        );
      }
      counter('flashcard.persisted', { note_id, count: rows.length });
    });

    histogram('flashcard.gen.latency', Date.now() - startedAt, { note_id });
    return { ok: true, count: cards.length };
}

export const noteCreatedFlashcards = inngest.createFunction(
  {
    id: 'note-created-flashcards',
    retries: 2,
    concurrency: { limit: 2 },
    // Council r1 bugs: duplicate events from the emitter (unlikely but
    // zero-cost guard) must not trigger two Claude calls.
    idempotency: 'event.id',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Inngest onFailure envelope untyped
    onFailure: async ({ event, error: err }: { event: any; error: any }) => {
      const orig = event?.data?.event?.data as { note_id?: string } | undefined;
      if (!orig?.note_id) return;
      // Council r5 bugs: if the error carries a reservedTokens payload,
      // refund that exact amount — not a recalculation from a potentially
      // stale notes row. Falls back to body-length estimation only when
      // the failure happened before token-budget-reserve ran.
      const reservation = extractReservation(err);
      try {
        await refundFlashcardBudget(
          orig.note_id,
          reservation ?? undefined,
        );
      } catch (refundErr) {
        // Refund is best-effort (Tier B budget auto-expires in 1h
        // regardless). But a silent swallow hides operational faults —
        // council r4 security: log the error class so a future log-drain
        // rule can grep it.
        // eslint-disable-next-line no-console
        console.error('[flashcard-gen] onFailure refund itself failed', {
          alert: true,
          tier: 'flashcard_gen_onfailure_refund',
          errorName: refundErr instanceof Error ? refundErr.name : typeof refundErr,
          note_id: orig.note_id,
        });
      }
    },
  },
  { event: 'note.created.flashcards' },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Inngest runtime types
  runNoteCreatedFlashcards as any,
);
