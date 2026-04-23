# Plan: /review UI — render srs_cards with plain-text XSS-safe rendering (issue #38)

**Status:** r2 — folding council r1 PROCEED with bugs=6 substantive asks (try/catch + PII-safe error logging + focus management + metrics). Awaiting council r2 + human approval.
**Branch:** `claude/review-ui`.
**Scope:** first user-facing surface on the SRS pipeline. Server Component reads `srs_cards` via RLS, Client Component owns the reveal-answer toggle. Plain-text rendering only (no `dangerouslySetInnerHTML`). New unit + a11y tests. **No `[skip council]`.**

## Problem

PR #37 (`e52866c`) shipped the flashcard generation handler: when a PDF ingest completes, Claude Haiku produces 5–10 cards and persists them to `srs_cards`. The pipeline is end-to-end functional on the data side, but **the cards are dead on arrival** — there is no `/review` route at `apps/web/app/review/` (verified: directory does not exist). Until this UI ships, no user can see the SRS loop work, and the product has no visible value beyond the upload-and-list dashboard.

Issue #38 was filed during PR #37's council r2 with the XSS sanitization requirement promoted to a non-negotiable: `srs_cards.question` and `srs_cards.answer` are LLM output from user-uploaded PDFs, so a crafted PDF could embed HTML/JS that Claude passes through verbatim. Migration `20260422000001_srs_cards_unique.sql` annotated those columns with `COMMENT ON COLUMN ... IS 'LLM-generated from user-uploaded content. MUST be sanitized before rendering.'` — the canonical record of this requirement. This PR honors that contract.

## Goal

A `/review` route at `apps/web/app/review/page.tsx` that:

1. Authenticates the request (redirect to `/auth` on unauthenticated, matching `apps/web/app/page.tsx:11-14`).
2. Fetches the user's cards via the RLS-scoped client (`supabaseForRequest`), bounded to a small page (20).
3. Renders one card at a time as **plain text** — question shown by default, answer hidden until reveal.
4. Handles the empty state (no cards yet) with a clear copy directing to upload.
5. Passes a11y: WCAG AA contrast, ≥44px touch targets, `aria-live` reveal announcement, focus-management on next-card.
6. Has a unit test that proves a card with `question: '<script>alert(1)</script>'` renders as the literal escaped string and never executes.

Explicitly **not** in scope: FSRS rating buttons, next-review-date scheduling, markdown rendering, edit/delete UI, keyboard shortcuts, session-based bulk-review. Each is its own follow-up.

## Scope

**In:**

- `apps/web/app/review/page.tsx` — new Server Component. Auth check, RLS read of `srs_cards`, passes initial card list to a client child. `export const dynamic = 'force-dynamic'` (auth-gated, per-user).
- `apps/web/app/review/ReviewDeck.tsx` — new Client Component (`'use client'`). Owns: which-card-index state, answer-revealed boolean, "next card" handler. Renders `{card.question}` / `{card.answer}` as text nodes — never `dangerouslySetInnerHTML`.
- `apps/web/lib/i18n.ts` — add 5 keys: `review.heading`, `review.empty`, `review.show_answer`, `review.hide_answer`, `review.load_error`. Update the `Key` union and `STRINGS` map.
- `apps/web/components/ReviewDeck.test.tsx` — vitest unit test covering: (a) XSS payload renders escaped, (b) reveal toggle flips answer visibility, (c) "next card" advances index and re-hides the answer, (d) empty array renders the empty-state copy.
  - Uses `react-dom/server`'s `renderToStaticMarkup` (already a transitive dep via `react-dom@^19`); no new runtime dep, no jsdom needed (vitest env stays `node` per `apps/web/vitest.config.ts`).
  - Note: `ReviewDeck` is the Client Component, but `'use client'` is a bundler directive — in a pure unit-test context the file imports as a normal React module.
- `apps/web/tests/unit/review-page.test.ts` — route-module integration test mirroring `auth-callback-route.test.ts`'s shape: stubs `supabaseForRequest`, asserts unauthenticated → redirect, asserts `srs_cards` query is RLS-scoped (uses the wrapped client, not `supabaseService`).
- `apps/web/tests/a11y/smoke.spec.ts` — extend the placeholder to include a `/review` static-HTML axe pass for color-contrast + target-size, modeled on the existing pattern. (Real page.goto stays gated on the dev-server CI todo.)

**Out (explicit):**

- FSRS scoring / rating buttons / `review_history` writes — separate follow-up; the schema is ready (`packages/db/src/types.ts:101` `ReviewHistory`) but the algorithm + UI pattern need their own plan.
- Markdown rendering for cards — issue #38 mandates plain text for v0. If a future need emerges, route through `react-markdown + rehype-sanitize` like `/note/[slug]` does, with allowlist explicitly tightened.
- Card edit / delete UI.
- "Due-now" filtering via `due_at` — the partial index `srs_cards_user_due_idx` is in place (`supabase/migrations/20260422000001_srs_cards_unique.sql:17-19`) but v0 just shows all of the user's cards by `created_at desc`. Due filtering arrives with FSRS scoring.
- Pagination beyond a 20-card page. v0 cap is fine — the user has at most ~10 cards per ingested note in the early path.
- Keyboard shortcuts (Space to reveal, J/K to navigate). Nice-to-have; trivial follow-up once the core flow is reviewed.
- Realtime subscription for newly-generated cards. Static page-load fetch is fine for v0; user can refresh.

## Design

### A. Server Component — `apps/web/app/review/page.tsx`

```ts
import { redirect } from 'next/navigation';
import { counter } from '@llmwiki/lib-metrics';
import { supabaseForRequest } from '../../lib/supabase';
import { ReviewDeck } from './ReviewDeck';
import { t } from '../../lib/i18n';
import type { SrsCard } from '@llmwiki/db/types';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 20;

export default async function ReviewPage() {
  const rls = await supabaseForRequest();
  const { data: { user } } = await rls.auth.getUser();
  if (!user) redirect('/auth');

  // /review page-load: 1 supabase select per request, no LLM calls. Free.
  // PII DISCIPLINE: srs_cards.question/answer are LLM output derived from
  // user PDFs (COMMENT ON COLUMN confirms). NEVER log them on ANY path,
  // including error paths below — only log error.name + a bounded code.
  const { data: cards, error } = await rls
    .from('srs_cards')
    .select('id, question, answer, due_at, created_at')
    .order('created_at', { ascending: false })
    .limit(PAGE_SIZE);

  if (error) {
    // PostgREST error — network, RLS misconfigure, or transient. We
    // render a user-friendly banner instead of the Next.js default 500.
    // Logged fields are deliberately narrow: error class name + code +
    // user_id (for support correlation). No card content. No message —
    // some Supabase error messages echo the query text which can leak
    // column names; `error.name` + `error.code` are grep-stable and safe.
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

  // Narrow the row shape to what the client component renders. We never
  // hand SrsCard.user_id / cohort_id over the wire — RLS already gated the
  // read, and the client doesn't need them.
  type DeckCard = Pick<SrsCard, 'id' | 'question' | 'answer'>;
  const deckCards: DeckCard[] = (cards ?? []).map((c) => ({
    id: c.id,
    question: c.question,
    answer: c.answer,
  }));

  counter('review.page.viewed', { user_id: user.id, card_count: deckCards.length });

  return (
    <main>
      <h1 className="text-2xl font-semibold text-brand-900 mb-6">
        {t('review.heading')}
      </h1>
      <ReviewDeck cards={deckCards} emptyCopy={t('review.empty')} />
    </main>
  );
}
```

**Why prefer Supabase's `{ data, error }` branch over `try/catch`:** `supabase-js` wraps PostgREST errors into the tuple rather than throwing. A `try/catch` would only catch network-level failures (fetch throws), leaving the common case — e.g., an RLS misconfigure returning `{ data: null, error: {...} }` — unhandled. Branching on `error` covers both: network errors surface in the `error` field via the client's internal catch. If a new failure mode is found in practice, a top-level `try/catch` is a one-line addition.

**Why server component:** auth check + RLS read happen on the server (matches the dashboard pattern). The cookie-write Proxy from `supabaseForRequest` works in Server Components (read-only path; the no-op cookie writes do not halt — see `apps/web/lib/supabase.ts:96-104` "expected RSC context" branch).

**Why pre-narrow to `DeckCard`:** never serialize `user_id` / `cohort_id` to client props. Server-component → client-component prop boundary is a privilege boundary. RLS already enforces server-side scoping; the client truly only needs `{id, question, answer}`.

### B. Client Component — `apps/web/app/review/ReviewDeck.tsx`

```ts
'use client';

import { useEffect, useRef, useState } from 'react';
import { counter } from '@llmwiki/lib-metrics';
import { t } from '../../lib/i18n';

interface DeckCard {
  id: string;
  question: string;
  answer: string;
}

interface Props {
  cards: ReadonlyArray<DeckCard>;
  emptyCopy: string;
}

export function ReviewDeck({ cards, emptyCopy }: Props) {
  const [index, setIndex] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const headingRef = useRef<HTMLHeadingElement>(null);
  // a11y r1 fold: skip the focus-move on the very first render so the
  // page-load doesn't yank focus from wherever the browser put it. Move
  // focus only on subsequent index changes (i.e., user clicked "Next").
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

  const card = cards[index];
  const atEnd = index >= cards.length - 1;

  const handleReveal = () => {
    setRevealed((r) => {
      // Only count REVEAL events (false → true), not hide-toggles.
      if (!r) counter('review.card.revealed', { card_id: card.id });
      return !r;
    });
  };
  const handleNext = () => {
    if (atEnd) return;
    setIndex((i) => i + 1);
    setRevealed(false);
  };

  return (
    <section aria-labelledby="card-heading" className="max-w-xl">
      {/* tabIndex=-1 makes the heading programmatically focusable so the
          useEffect above can move focus to it on next-card. The sr-only
          class keeps it visually hidden; AT users hear "Card N of M". */}
      <h2 id="card-heading" ref={headingRef} tabIndex={-1} className="sr-only">
        Card {index + 1} of {cards.length}
      </h2>

      <div className="border border-brand-100 rounded-md p-6 bg-white">
        {/* Plain-text node: React escapes HTML by default. NEVER use
            dangerouslySetInnerHTML on these fields — see issue #38 +
            COMMENT ON COLUMN srs_cards.question. */}
        <p className="text-brand-900 text-lg mb-4 whitespace-pre-wrap">
          {card.question}
        </p>

        <div aria-live="polite" aria-atomic="true">
          {revealed && (
            <p className="text-brand-900 mt-4 pt-4 border-t border-brand-100 whitespace-pre-wrap">
              {/* Same plain-text guarantee. */}
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
          Next card
        </button>
      </div>

      <p className="mt-2 text-sm text-brand-700">
        {index + 1} / {cards.length}
      </p>
    </section>
  );
}
```

### C. XSS-safety test pattern

```ts
// apps/web/components/ReviewDeck.test.tsx
import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ReviewDeck } from '../app/review/ReviewDeck';

describe('ReviewDeck XSS safety (issue #38)', () => {
  it('escapes a script-tag payload in question', () => {
    const html = renderToStaticMarkup(
      <ReviewDeck
        cards={[{ id: '1', question: '<script>alert(1)</script>', answer: 'x' }]}
        emptyCopy="empty"
      />,
    );
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<script>alert(1)</script>');
  });

  it('does not leak the answer markup before reveal', () => {
    const html = renderToStaticMarkup(
      <ReviewDeck
        cards={[{ id: '1', question: 'q', answer: '<script>alert(2)</script>' }]}
        emptyCopy="empty"
      />,
    );
    // Answer block only renders when revealed=true; default state is
    // unrevealed, so neither the raw nor the escaped payload should appear.
    expect(html).not.toContain('<script>alert(2)</script>');
    expect(html).not.toContain('alert(2)');
  });

  // Interaction tests (reveal toggle, next-card index, empty state) use
  // the same renderToStaticMarkup pattern with a small <ReviewDeck>
  // wrapper that pre-seeds state via initial props passed through a
  // `__testInitial` prop guarded with a one-line justification, OR
  // alternatively re-renders after a useState mutation by testing the
  // pure handler functions extracted from the component body. Pick one
  // approach in implementation; council can flag preference.
});
```

**Why `renderToStaticMarkup` instead of `@testing-library/react`:** vitest env is `node` (`apps/web/vitest.config.ts:8`); jsdom is not configured. Adding jsdom + testing-library is a 2-package new-runtime-dep change that needs its own justification. `renderToStaticMarkup` exists in `react-dom/server` (`react-dom@^19` is already in `apps/web/package.json`). Sufficient to verify the XSS non-negotiable: React's text-node default escapes the payload at server-render time. The same escaping applies on the client — React's renderer uses the same text-escaping path.

**Council may push back on this and require jsdom + testing-library for stronger interaction-level tests.** That's a fair ask; if so, fold by adding `jsdom` + `@testing-library/react` + `@testing-library/jest-dom` and rewriting the interaction tests with `render()` + `userEvent`. New runtime deps trigger the standard cost-posture check (none — dev-only). Open question for council: is the `renderToStaticMarkup` proof of XSS-safety sufficient, or does the interaction surface (toggle / next-card) need DOM-level assertion?

### D. i18n keys

Add to `apps/web/lib/i18n.ts`:

```ts
type Key =
  | ...existing...
  | 'review.heading'
  | 'review.empty'
  | 'review.show_answer'
  | 'review.hide_answer';

const STRINGS: Record<Key, string> = {
  ...,
  'review.heading': 'Review',
  'review.empty': 'No flashcards yet. Upload a PDF to generate flashcards.',
  'review.show_answer': 'Show answer',
  'review.hide_answer': 'Hide answer',
  'review.load_error': "Couldn't load your flashcards. Please refresh in a moment.",
};
```

### E. Accessibility

- `aria-live="polite"` on the answer container so screen readers announce reveal without interrupting.
- `aria-pressed` on the reveal button so the toggle state is exposed.
- `min-h-[44px]` on both buttons matches the existing dashboard pattern (target-size).
- Card heading (`Card N of M`) is `sr-only` AND `tabIndex={-1}` so the `useEffect` can move focus to it on next-card. AT users hear "Card N of M" announced; visual focus is invisible (sr-only, no outline interference).
- `useEffect` skips the focus move on first render — page-load doesn't yank focus from the browser's default landing spot.
- Color tokens are existing `brand-*` / `danger` from `globals.css` — already palette-checked by `tests/a11y/smoke.spec.ts` for contrast.
- `whitespace-pre-wrap` preserves linebreaks Claude emits in long-form answers (mirrors how the prompt was tuned in `packages/prompts/src/flashcard-gen/v1.md`).

### F. Route-level test (`apps/web/tests/unit/review-page.test.ts`)

Mirrors `auth-callback-route.test.ts` shape:

- Stub `next/navigation`'s `redirect` with `vi.fn()` that throws (Next's actual behavior).
- Stub `supabaseForRequest` to return a builder whose `.auth.getUser()` returns `{ data: { user: null } }`; assert `redirect('/auth')` was called.
- Stub returning a real user; assert the chain `from('srs_cards').select(...).order('created_at',{ascending:false}).limit(20)` was called against the RLS-scoped client (NOT `supabaseService`).
- Assert no call to `supabaseService` from the page (RLS-only path; service-role would bypass cohort isolation and is forbidden for this read).
- **Bugs r1 fold:** stub the select to return `{ data: null, error: { name: 'PostgresError', code: '42P01', message: 'card body sample text that MUST NOT be logged' } }`; assert (a) the page renders the `review.load_error` copy, (b) `console.error` is called with `errorName + code + user_id` only — assert the spied call args do NOT contain the substring "card body sample text" or any portion of the error message, (c) `counter('review.page.load_failed', ...)` was called.
- **Bugs r1 fold:** stub the select to return cards including `{ id, question: '<script>alert(1)</script>', answer: 'x' }`; assert `console.error` was NOT called for any non-error path, AND assert `counter` was called with `review.page.viewed` and `card_count` matching the stubbed array length — but never with the card content (positive assertion: counter labels' values do not include the script payload).

## Non-negotiables (must hold; council will not override)

- **No `dangerouslySetInnerHTML` on `srs_cards.question` or `srs_cards.answer`.** XSS surface; mandated by issue #38 + the migration's `COMMENT ON COLUMN`.
- **RLS-only read.** Use `supabaseForRequest`, never `supabaseService`. The `/review` page is a per-user surface; service-role would bypass `srs_cards_own` policy at `supabase/migrations/20260417000002_rls_policies.sql:118-121`.
- **Auth redirect on unauthenticated.** Match `apps/web/app/page.tsx:11-14` exactly; do not render an empty page or a "please sign in" message in-place (existing UX contract).
- **Plain-text rendering.** No markdown library, no HTML parsing. v0 is text-node-only.
- **Server → client prop boundary narrows to `{id, question, answer}`.** Never serialize `user_id` / `cohort_id` to the client.
- **XSS-payload unit test exists and passes.** Acceptance-criteria checkbox in issue #38.
- **PII discipline on logging (council r1 security non-negotiable):** `srs_cards.question` and `srs_cards.answer` MUST NOT be logged on any path. Error logs include only `errorName`, `code`, and `user_id` — never the message body, since some PostgREST messages echo query text. A test asserts the error-path log args do not contain stubbed message content. Comment at the page-load callsite codifies the rule.
- **Graceful error UI on query failure (council r1 bugs ask):** `{ error }` branch renders the `review.load_error` banner and increments `review.page.load_failed`; never falls through to the Next.js 500.
- **Focus management on next-card (council r1 a11y ask):** focus moves to the sr-only card heading on `index` change (not first render), so screen-reader users hear the new card position.

## Tests

- `apps/web/components/ReviewDeck.test.tsx` — XSS escape (question + answer), empty state, reveal toggle behavior, next-card behavior, reveal-counter only fires on false→true (not hide). Target ≥7 cases.
- `apps/web/tests/unit/review-page.test.ts` — auth redirect, RLS-only read, no service-role call, error-branch renders banner + logs PII-safe shape, view-counter fires on success. Target ≥6 cases.
- `apps/web/tests/a11y/smoke.spec.ts` — extend with a static-HTML pass that includes a representative card layout (one card div + two buttons + sr-only heading). Verifies palette + target-size for the new surface ahead of the dev-server CI integration.

`npm run lint`, `npm run typecheck`, `npm test` all pass for `apps/web`.

## Risks

1. **`renderToStaticMarkup` may not satisfy council's "interaction tests" bar.** Fold path: add `jsdom` + `@testing-library/react` + `@testing-library/jest-dom` (dev-deps only; no runtime cost), switch test environment to `jsdom` for `*.test.tsx` only (`environmentMatchGlobs` in vitest config), rewrite interaction tests with `render()` + `userEvent`. Defer until council asks.
2. **Server Component cookie-write Proxy in `/review` page context.** The `supabaseForRequest` Proxy logs nothing on its own (`apps/web/lib/supabase.ts:65-72`); SC context throws are swallowed silently per the "expected RSC context" branch. No new behavior needed. Tested at `supabase.test.ts`.
3. **`due_at` filter omitted in v0.** Cards never become "due-only" in this PR; user sees all of their cards. Acceptable v0 trade — FSRS scoring is the trigger for due-filtering. Add the filter the same week the rating UI lands so the partial index pays off.
4. **Card text length unbounded.** `whitespace-pre-wrap` + `max-w-xl` handles long cards visually; no explicit truncation. The flashcard prompt (`packages/prompts/src/flashcard-gen/v1.md`) targets concise cards and Claude's output rarely exceeds ~200 chars per side, but a malicious prompt-injected PDF could produce arbitrarily long output. Considered acceptable for v0 — long cards degrade UX, do not crash the page.
5. **No realtime / optimistic updates.** A user generating new flashcards via PDF upload then visiting `/review` requires a manual refresh. Acceptable v0; Realtime is a separate slice (the dashboard already uses it for `ingestion_jobs` via `IngestionStatusTable`).
6. **Null `question`/`answer` placeholder rendering — REBUTTED, no fold (council r1 bugs ask).** Council r1 asked for a `[No content]` placeholder when either field is null. The schema at `supabase/migrations/20260417000001_initial_schema.sql:152-153` declares both columns `text not null`; the column-level constraint is enforced at write time by Postgres and at row time by `supabase-js`'s typed inserts. A null arriving at this read would mean the constraint was bypassed (impossible without a manual `ALTER TABLE`) — defensive rendering for a schema-impossible value is dead code. **Action:** none. The plan's TypeScript types (`SrsCard.question: string`, not `string | null` at `packages/db/src/types.ts:92-93`) reflect the schema and the code naturally cannot encounter the null path. If a future migration relaxes `not null`, the type widens and the compiler forces a placeholder decision then — which is the correct moment for it.

## Metrics (council r1 product fold)

Per CLAUDE.md "Cost posture" + the council r1 product persona kill criterion:

- `review.page.viewed{user_id, card_count}` — fired once per successful page load. Powers engagement floor.
- `review.page.load_failed{user_id}` — fired on the `error`-branch in `ReviewPage`. Should be ≪ 1% of `viewed` if Supabase is healthy.
- `review.card.revealed{card_id}` — fired only on the false→true transition of the reveal toggle (not on hide). Direct measure of card engagement; the kill criterion below reads off this counter.

**Kill criterion** (per council r1 product): zero `review.card.revealed` events from the active cohort one week post-merge → flashcard-product hypothesis is invalid → revisit prompt + UX before adding FSRS scoring.

`user_id` is included as a label for support correlation; `card_id` is the `srs_cards.id` UUID — neither is PII (they are pseudonyms generated server-side). Card content is NEVER a label.

## Cost

Zero net cost. No new external API calls, no new model usage, no new runtime dependencies. The route is a single Postgres `select` per page-load (RLS-scoped, indexed on `(user_id, due_at)` partial — though this query doesn't use that index since `due_at` filter is omitted; falls back to `srs_cards_note_id_idx` + table scan within the user's cards subset, which is fine at v0 cardinality).

Per-callsite cost annotation (CLAUDE.md "Cost posture" rule) added at the page-load query: `// /review page-load: 1 supabase select per request, no LLM calls. Free.`

## Out of scope (for the avoidance of doubt)

- FSRS scoring + `review_history` writes.
- Due-now filter.
- Markdown rendering.
- Card edit / delete.
- Keyboard shortcuts.
- Realtime subscription.
- Bulk-review session.
- Mobile gesture support beyond the 44px-target buttons.

## Acceptance criteria (from issue #38, expanded)

- [ ] Route exists at `/review`.
- [ ] Authenticated user sees own cards; unauthenticated user redirects to `/auth`.
- [ ] Empty state copy renders for zero cards.
- [ ] No `dangerouslySetInnerHTML` on `question` or `answer` (grep-verifiable).
- [ ] XSS unit test with `<script>alert(1)</script>` payload passes (escaped output).
- [ ] WCAG AA contrast on the card surface (existing `brand-*` palette; smoke test extended).
- [ ] `aria-live` region announces show-answer.
- [ ] `aria-pressed` exposes reveal-button toggle state.
- [ ] All buttons ≥44px touch target.
- [ ] Focus moves to card heading on next-card (not on first render).
- [ ] Error branch renders the `review.load_error` banner; no Next.js 500 page on Supabase failure.
- [ ] `console.error` on the error path includes `errorName` + `code` + `user_id` only — never card content (test asserts negative).
- [ ] `review.page.viewed`, `review.page.load_failed`, `review.card.revealed` counters fire on their respective paths.
- [ ] `npm run lint`, `npm run typecheck`, `npm test` pass.
- [ ] Council PROCEED on the impl-diff round.

## Council prompts (anticipated axes)

- **Security:** XSS; service-role leakage; client-prop boundary; RLS coverage.
- **Bugs:** empty array, single-card boundary (no "next" enabled), reveal-toggle interaction with next-card transitions, screen-reader announcement timing.
- **Accessibility:** target size, contrast, `aria-live` politeness, focus management on next-card (we don't move focus today; council may ask we do).
- **Architecture:** Server/Client split, prop-boundary narrowing, force-dynamic on auth-gated route.
- **Cost:** zero — should sail.
- **Product:** is plain-text-only the right v0 (vs markdown)? Issue #38 says yes; council can flag for a future revisit.
