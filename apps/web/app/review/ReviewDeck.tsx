'use client';

// One-card-at-a-time SRS review surface. Question shown by default;
// reveal toggle exposes the answer; "Next card" advances the index and
// re-hides. Plain-text rendering only — both `card.question` and
// `card.answer` are LLM-generated from user-uploaded PDFs (see
// COMMENT ON COLUMN srs_cards.question/answer in migration
// 20260422000001_srs_cards_unique.sql + issue #38). NEVER use
// dangerouslySetInnerHTML on these fields. React's default text-node
// rendering escapes HTML and is the entire XSS mitigation.
import { useEffect, useRef, useState } from 'react';
import { counter } from '@llmwiki/lib-metrics';
import { t } from '../../lib/i18n';

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

interface Props {
  cards: ReadonlyArray<DeckCard>;
  emptyCopy: string;
}

export function ReviewDeck({ cards, emptyCopy }: Props) {
  const [index, setIndex] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const headingRef = useRef<HTMLHeadingElement>(null);
  // Skip the focus-move on first render so page-load doesn't yank
  // focus from wherever the browser put it. Move focus only on
  // subsequent index changes (i.e., user clicked "Next card").
  const firstRender = useRef(true);

  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    headingRef.current?.focus();
  }, [index]);

  if (cards.length === 0) {
    return <p className="text-brand-700">{emptyCopy}</p>;
  }

  // Clamp defensively — useState(0) is the initial value but a future
  // refactor that mutates the card list out of sync with `index` should
  // not crash here. This is a belt for the suspenders below.
  const safeIndex = Math.min(index, cards.length - 1);
  // Non-null assertion: the empty-array branch above returns; safeIndex
  // is in [0, cards.length-1] by Math.min; under noUncheckedIndexedAccess
  // TS still infers `DeckCard | undefined`. The assertion is justified.
  const card = cards[safeIndex]!;

  const handleReveal = () => {
    setRevealed((r) => {
      // Count REVEAL events only (false → true), not hide-toggles.
      // Powers `review.card.revealed` engagement metric / kill criterion.
      if (!r) counter('review.card.revealed', { card_id: card.id });
      return !r;
    });
  };

  const handleNext = () => {
    // Updater form via the exported `nextIndex` helper (council r2
    // bugs fold + test seam): a double-click queues two setIndex
    // calls; the stale `atEnd` check at call time can let both
    // through, putting `index` past `cards.length - 1`. The clamp in
    // the updater makes a double-click on the last card a no-op
    // rather than an out-of-bounds read. The helper is exported so the
    // unit test asserts the clamp without needing a DOM environment.
    setIndex((i) => nextIndex(i, cards.length));
    setRevealed(false);
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

      <div className="mt-4 flex gap-2">
        <button
          type="button"
          onClick={handleReveal}
          aria-pressed={revealed}
          className="bg-brand-900 text-white px-4 py-2 rounded-md min-h-[44px]"
        >
          {revealed ? t('review.hide_answer') : t('review.show_answer')}
        </button>
        <button
          type="button"
          onClick={handleNext}
          disabled={atEnd}
          className="bg-white text-brand-900 border border-brand-100 px-4 py-2 rounded-md min-h-[44px] disabled:bg-brand-50 disabled:cursor-not-allowed"
        >
          {t('review.next_card')}
        </button>
      </div>

      <p className="mt-2 text-sm text-brand-700">
        {safeIndex + 1} / {cards.length}
      </p>
    </section>
  );
}
