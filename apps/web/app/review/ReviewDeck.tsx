'use client';

// One-card-at-a-time SRS review surface. Question shown by default;
// reveal toggle exposes the answer; user rates the card; system
// auto-advances. Plain-text rendering only — both `card.question` and
// `card.answer` are LLM-generated from user-uploaded PDFs (see
// COMMENT ON COLUMN srs_cards.question/answer in migration
// 20260422000001_srs_cards_unique.sql + issue #38). NEVER use
// dangerouslySetInnerHTML on these fields. React's default text-node
// rendering escapes HTML and is the entire XSS mitigation.
//
// PR #48 added: 4 rating buttons (Again/Hard/Good/Easy) after answer
// reveal; submitReview server action with idempotency + optimistic
// concurrency + Tier E rate-limit; auto-advance via the existing
// useEffect-on-[index] focus-mgmt seam from PR #42.
import { useEffect, useRef, useState } from 'react';
import { counter } from '@llmwiki/lib-metrics';
import { t } from '../../lib/i18n';
import { submitReview, type SubmitReviewResult } from './actions';

export interface DeckCard {
  id: string;
  question: string;
  answer: string;
}

/**
 * Compute the next card index, clamped to the last card. Pure helper
 * exported for unit testing the council r2 "double-click safe"
 * guarantee — see handleNext below for the integration call.
 */
export function nextIndex(current: number, totalCards: number): number {
  if (totalCards <= 0) return 0;
  return Math.min(current + 1, totalCards - 1);
}

/**
 * Generate a UUIDv4 for the rating's idempotency key. crypto.randomUUID
 * is available in all evergreen browsers + Node 18+. Council r2 bugs
 * nice-to-have fold (PR #48): an absence guard surfaces a graceful error
 * instead of crashing on truly ancient browsers.
 *
 * Exported so the test asserts:
 *   1. shape conforms to the server action's UUID validator;
 *   2. successive calls produce DIFFERENT keys (no accidental key reuse).
 */
export function generateIdempotencyKey(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // Fallback: returning '' triggers the server action's
  // invalid_idempotency_key error path — surfaces a "browser unsupported"
  // UX instead of silently making all retries collapse on one bucket.
  return '';
}

interface Props {
  cards: ReadonlyArray<DeckCard>;
  emptyCopy: string;
}

export function ReviewDeck({ cards, emptyCopy }: Props) {
  const [index, setIndex] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const [pendingRating, setPendingRating] = useState(false);
  const [ratingError, setRatingError] = useState<string | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  // Skip the focus-move on first render so page-load doesn't yank
  // focus from wherever the browser put it. Move focus only on
  // subsequent index changes (i.e., user clicked "Next card" or rated).
  const firstRender = useRef(true);

  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    headingRef.current?.focus();
  }, [index]);

  // Council r2 bugs nice-to-have fold: clear stale rating error when the
  // user navigates to a new card without rating. Otherwise an error from
  // card N would persist visually onto card N+1.
  useEffect(() => {
    setRatingError(null);
  }, [index]);

  if (cards.length === 0) {
    return <p className="text-brand-700">{emptyCopy}</p>;
  }

  const safeIndex = Math.min(index, cards.length - 1);
  // Non-null assertion: empty-array branch above returns; safeIndex is
  // in [0, cards.length-1] by Math.min; under noUncheckedIndexedAccess
  // TS still infers `DeckCard | undefined`. The assertion is justified.
  const card = cards[safeIndex]!;

  const handleReveal = () => {
    setRevealed((r) => {
      // Count REVEAL events only (false → true), not hide-toggles.
      if (!r) counter('review.card.revealed', { card_id: card.id });
      return !r;
    });
  };

  const handleNext = () => {
    setIndex((i) => nextIndex(i, cards.length));
    setRevealed(false);
  };

  const handleRate = async (rating: 1 | 2 | 3 | 4) => {
    if (pendingRating) return; // Double-click guard.
    setPendingRating(true);
    setRatingError(null);
    const idempotencyKey = generateIdempotencyKey();
    let result: SubmitReviewResult;
    try {
      result = await submitReview(card.id, rating, idempotencyKey);
    } catch (err) {
      // Network drop / framework error. Don't log error.message — could
      // contain serialized server state. Log error class only.
      const errorName = err instanceof Error ? err.name : typeof err;
      console.error('[ReviewDeck] rating_threw', { errorName });
      setRatingError(t('review.rating_error'));
      setPendingRating(false);
      return;
    }
    if (!result.ok) {
      // Distinct copy for rate-limit AND limiter-unavailable so user
      // knows whether to slow down (rate_limited) vs retry shortly
      // (limiter_unavailable, transient outage). Hot-fix PR #51 (council
      // PR #50 r2 fold) added the limiter_unavailable branch.
      const copyKey =
        result.errorKind === 'rate_limited'
          ? 'review.rating_rate_limit_error'
          : result.errorKind === 'limiter_unavailable'
            ? 'review.rating_limiter_unavailable_error'
            : 'review.rating_error';
      setRatingError(t(copyKey));
      // Council nice-to-have: PII-safe debug log of bounded enum.
      console.error('[ReviewDeck] rating_failed', { errorKind: result.errorKind });
      setPendingRating(false);
      return;
    }
    counter('review.card.rated', { rating: String(rating) });
    handleNext(); // Advances + re-hides answer + (via useEffect) moves focus.
    setPendingRating(false);
  };

  const atEnd = safeIndex >= cards.length - 1;

  return (
    <section aria-labelledby="card-heading" className="max-w-xl">
      {/* tabIndex={-1} makes the sr-only heading programmatically
          focusable so the useEffect can move focus to it on next-card.
          AT users hear "Card N of M" on advance; sighted users see no
          visible focus ring (sr-only collapses the box). */}
      <h2 id="card-heading" ref={headingRef} tabIndex={-1} className="sr-only">
        Card {safeIndex + 1} of {cards.length}
      </h2>

      <div className="border border-brand-100 rounded-md p-6 bg-white">
        {/* PLAIN TEXT — see file header. Do not introduce
            dangerouslySetInnerHTML on question/answer. */}
        <p className="text-brand-900 text-lg mb-4 whitespace-pre-wrap">
          {card.question}
        </p>

        <div aria-live="polite" aria-atomic="true">
          {revealed && (
            <p className="text-brand-900 mt-4 pt-4 border-t border-brand-100 whitespace-pre-wrap">
              {/* PLAIN TEXT — see file header. */}
              {card.answer}
            </p>
          )}
        </div>
      </div>

      <div className="mt-4 flex gap-2 flex-wrap">
        <button
          type="button"
          onClick={handleReveal}
          aria-pressed={revealed}
          disabled={pendingRating}
          className="bg-brand-900 text-white px-4 py-2 rounded-md min-h-[44px] disabled:bg-brand-700 disabled:cursor-not-allowed"
        >
          {revealed ? t('review.hide_answer') : t('review.show_answer')}
        </button>
        {/* Skip-without-rating button: kept visible whether or not the
            user has revealed/rated, so they can move past a card. Hidden
            during pending submit so a click doesn't race the rating. */}
        {!revealed && (
          <button
            type="button"
            onClick={handleNext}
            disabled={atEnd || pendingRating}
            className="bg-white text-brand-900 border border-brand-100 px-4 py-2 rounded-md min-h-[44px] disabled:bg-brand-50 disabled:cursor-not-allowed"
          >
            {t('review.next_card')}
          </button>
        )}
      </div>

      {revealed && (
        <div
          className="mt-4 flex gap-2 flex-wrap"
          role="group"
          aria-label="Rate this card"
        >
          <button
            type="button"
            onClick={() => handleRate(1)}
            disabled={pendingRating}
            className="bg-danger text-white px-4 py-2 rounded-md min-h-[44px] disabled:opacity-60 disabled:cursor-not-allowed"
          >
            {t('review.rating.again')}
          </button>
          <button
            type="button"
            onClick={() => handleRate(2)}
            disabled={pendingRating}
            className="bg-warning text-brand-900 px-4 py-2 rounded-md min-h-[44px] disabled:opacity-60 disabled:cursor-not-allowed"
          >
            {t('review.rating.hard')}
          </button>
          <button
            type="button"
            onClick={() => handleRate(3)}
            disabled={pendingRating}
            className="bg-success text-white px-4 py-2 rounded-md min-h-[44px] disabled:opacity-60 disabled:cursor-not-allowed"
          >
            {t('review.rating.good')}
          </button>
          <button
            type="button"
            onClick={() => handleRate(4)}
            disabled={pendingRating}
            className="bg-brand-900 text-white px-4 py-2 rounded-md min-h-[44px] disabled:opacity-60 disabled:cursor-not-allowed"
          >
            {t('review.rating.easy')}
          </button>
        </div>
      )}

      {pendingRating && (
        <p
          className="mt-2 text-sm text-brand-700"
          role="status"
          aria-live="polite"
        >
          {t('review.rating_pending')}
        </p>
      )}
      {ratingError && (
        <p className="mt-2 text-danger text-sm" role="alert">
          {ratingError}
        </p>
      )}

      <p className="mt-4 text-sm text-brand-700">
        {safeIndex + 1} / {cards.length}
      </p>
    </section>
  );
}
