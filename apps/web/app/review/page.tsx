// /review — first user-facing surface on the SRS pipeline.
// Server Component: auth-gated, RLS-scoped read of srs_cards,
// narrows to {id, question, answer} before passing to the client.
//
// PII DISCIPLINE (council r1 security non-negotiable):
//   srs_cards.question + srs_cards.answer are LLM output derived from
//   user PDFs (COMMENT ON COLUMN in migration 20260422000001). NEVER
//   log them on ANY path, including error paths. Logged fields below
//   are deliberately narrow — error class name, error code, user id.
import { redirect } from 'next/navigation';
import { counter } from '@llmwiki/lib-metrics';
import { supabaseForRequest } from '../../lib/supabase';
import { ReviewDeck, type DeckCard } from './ReviewDeck';
import { ErrorBoundary } from '../../components/ErrorBoundary';
import { t } from '../../lib/i18n';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 20;

export default async function ReviewPage() {
  const rls = await supabaseForRequest();
  const {
    data: { user },
  } = await rls.auth.getUser();
  if (!user) redirect('/auth');

  // /review page-load: 1 supabase select per request, no LLM calls. Free.
  const { data: cards, error } = await rls
    .from('srs_cards')
    .select('id, question, answer, due_at, created_at')
    .order('created_at', { ascending: false })
    .limit(PAGE_SIZE);

  if (error) {
    // Council r1 security: error.message can echo query text or row
    // values from PostgREST — log only the class + bounded code.
    // Council r1 bugs: render the user-friendly banner, not Next.js 500.
    console.error('[/review] load_failed', {
      errorName: error.name ?? 'UnknownError',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- supabase error untyped
      code: (error as any)?.code ?? null,
      user_id: user.id,
    });
    counter('review.page.load_failed', { user_id: user.id });
    return (
      <main>
        <h1 className="text-2xl font-semibold text-brand-900 mb-6">
          {t('review.heading')}
        </h1>
        <p role="alert" className="text-danger">
          {t('review.load_error')}
        </p>
      </main>
    );
  }

  // Council r2 bugs fold: defend against malformed responses where
  // `error` is null but `data` is not the expected array shape (e.g.,
  // PostgREST returns a single row instead of a list, or a string).
  // Without this guard, `.map` below would throw and 500 the page.
  if (!Array.isArray(cards)) {
    console.error('[/review] load_failed_non_array', {
      errorName: 'NonArrayResponse',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- shape unknown
      typeOfData: typeof cards,
      user_id: user.id,
    });
    counter('review.page.load_failed', { user_id: user.id, reason: 'non_array' });
    return (
      <main>
        <h1 className="text-2xl font-semibold text-brand-900 mb-6">
          {t('review.heading')}
        </h1>
        <p role="alert" className="text-danger">
          {t('review.load_error')}
        </p>
      </main>
    );
  }

  // Narrow the row shape to what the client component renders. We
  // never hand SrsCard.user_id / cohort_id over the wire — RLS
  // already gated the read, and the client doesn't need them.
  // PII discipline: the destructure here is the privacy boundary.
  const deckCards: DeckCard[] = cards.map((c) => ({
    id: c.id,
    question: c.question,
    answer: c.answer,
  }));

  counter('review.page.viewed', {
    user_id: user.id,
    card_count: deckCards.length,
  });

  return (
    <main>
      <h1 className="text-2xl font-semibold text-brand-900 mb-6">
        {t('review.heading')}
      </h1>
      {/* Council r2 bugs fold: ErrorBoundary contains client-render
          crashes to a fallback UI rather than blanking the page or
          bubbling to the route-level error.tsx (which would lose this
          page's chrome). Label is PII-safe; the boundary itself logs
          only label + error class name. */}
      <ErrorBoundary
        label="review-deck"
        fallback={
          <p role="alert" className="text-danger">
            {t('review.render_error')}
          </p>
        }
      >
        <ReviewDeck cards={deckCards} emptyCopy={t('review.empty')} />
      </ErrorBoundary>
    </main>
  );
}
