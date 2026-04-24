import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  ReviewDeck,
  nextIndex,
  generateIdempotencyKey,
} from '../app/review/ReviewDeck';

// Vitest env is `node` (apps/web/vitest.config.ts) — no jsdom. Static
// render coverage uses `react-dom/server`. Dynamic interaction (reveal
// toggle, next-card click) is covered by direct unit tests on the
// pure helper `nextIndex` and via repeat renders for static state.
//
// Why this is sufficient for the issue #38 XSS non-negotiable:
// React's text-node escaping path is the same in both server and
// client renderers — `renderToStaticMarkup` is a high-fidelity proof
// that the rendered output never contains unescaped HTML for these
// fields. If a future change introduces dangerouslySetInnerHTML, the
// XSS test fails immediately.

const xssPayload = '<script>alert(1)</script>';

describe('ReviewDeck XSS safety (issue #38 non-negotiable)', () => {
  it('escapes a script-tag payload in question', () => {
    const html = renderToStaticMarkup(
      <ReviewDeck
        cards={[{ id: '1', question: xssPayload, answer: 'a' }]}
        emptyCopy="empty"
      />,
    );
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<script>alert(1)</script>');
  });

  it('does not leak the answer markup before reveal', () => {
    const html = renderToStaticMarkup(
      <ReviewDeck
        cards={[{ id: '1', question: 'q', answer: xssPayload }]}
        emptyCopy="empty"
      />,
    );
    // Answer block only renders when revealed=true; the default state
    // is unrevealed, so neither raw nor escaped payload should appear.
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).not.toContain('alert(1)');
  });

  it('does not introduce dangerouslySetInnerHTML in rendered output', () => {
    const html = renderToStaticMarkup(
      <ReviewDeck
        cards={[{ id: '1', question: '<b>bold</b>', answer: 'a' }]}
        emptyCopy="empty"
      />,
    );
    // The HTML attribute name dangerouslySetInnerHTML never appears in
    // rendered markup (it's a React prop, not an HTML attribute), but
    // checking that the `<b>` is escaped to `&lt;b&gt;` proves React's
    // text-node path is engaged.
    expect(html).toContain('&lt;b&gt;bold&lt;/b&gt;');
    expect(html).not.toContain('<b>bold</b>');
  });
});

describe('ReviewDeck rendering', () => {
  it('renders the empty-state copy when cards is empty', () => {
    const html = renderToStaticMarkup(
      <ReviewDeck cards={[]} emptyCopy="No flashcards yet." />,
    );
    expect(html).toContain('No flashcards yet.');
    // Should not render the card chrome.
    expect(html).not.toContain('Card 1 of');
    expect(html).not.toContain('Show answer');
  });

  it('renders the first card with question visible and answer hidden', () => {
    const html = renderToStaticMarkup(
      <ReviewDeck
        cards={[
          { id: '1', question: 'Q1?', answer: 'A1.' },
          { id: '2', question: 'Q2?', answer: 'A2.' },
        ]}
        emptyCopy="empty"
      />,
    );
    expect(html).toContain('Q1?');
    expect(html).not.toContain('A1.');
    expect(html).toContain('Card 1 of 2');
    expect(html).toContain('1 / 2');
    expect(html).toContain('Show answer');
    expect(html).toContain('Next card');
  });

  it('renders required a11y attributes', () => {
    const html = renderToStaticMarkup(
      <ReviewDeck
        cards={[{ id: '1', question: 'q', answer: 'a' }]}
        emptyCopy="empty"
      />,
    );
    // sr-only heading is programmatically focusable. React renders
    // tabIndex as the lowercased HTML attribute name in static markup.
    expect(html).toContain('id="card-heading"');
    expect(html).toContain('tabindex="-1"');
    expect(html).toContain('class="sr-only"');
    // aria-live region for the answer reveal.
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('aria-atomic="true"');
    // Reveal button exposes its toggle state.
    expect(html).toContain('aria-pressed="false"');
    // Single-card case disables the next button.
    expect(html).toContain('disabled=""');
  });

  it('renders empty-string question/answer without crashing', () => {
    // Schema guarantees not-null, but empty string is allowed. React
    // renders empty text-node as nothing — the markup should still
    // contain the chrome and not throw.
    const html = renderToStaticMarkup(
      <ReviewDeck
        cards={[{ id: '1', question: '', answer: '' }]}
        emptyCopy="empty"
      />,
    );
    expect(html).toContain('Card 1 of 1');
    expect(html).toContain('Show answer');
  });

  it('renders Unicode + emoji content unchanged', () => {
    const html = renderToStaticMarkup(
      <ReviewDeck
        cards={[{ id: '1', question: 'بسم الله 🎉', answer: 'a' }]}
        emptyCopy="empty"
      />,
    );
    expect(html).toContain('بسم الله 🎉');
  });
});

describe('nextIndex helper (council r2 double-click safety)', () => {
  it('advances by 1 within bounds', () => {
    expect(nextIndex(0, 5)).toBe(1);
    expect(nextIndex(2, 5)).toBe(3);
  });

  it('clamps to the last index on the boundary', () => {
    expect(nextIndex(4, 5)).toBe(4);
  });

  it('clamps when current is already past the end', () => {
    // The exact race council r2 flagged: a stale read + batched
    // setIndex can produce values > totalCards-1. Clamp must hold.
    expect(nextIndex(99, 5)).toBe(4);
  });

  it('returns 0 for an empty deck (defensive; render path guards above)', () => {
    expect(nextIndex(0, 0)).toBe(0);
  });

  it('does not spy or call counter() in the helper', () => {
    // Pure function — proven by the side-effect-free signature; this
    // test exists to anchor the contract that nextIndex stays pure
    // (no console, no metrics, no setState). A future maintainer who
    // adds a side effect breaks this expectation in an obvious way:
    // the test still passes but the contract documentation here flags
    // the divergence in code review.
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    nextIndex(1, 5);
    expect(consoleSpy).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
  });
});

// ===== PR #48 — FSRS rating ===========================================
//
// renderToStaticMarkup gives us the initial-render markup (revealed=false).
// The rating cluster only renders after answer reveal, which requires
// state mutation that vitest-node can't drive. Interaction tests for the
// reveal→rate→advance flow live in:
//   - actions.test.ts (server-action contract; load-bearing per the
//     rebuttal-protocol failure-mode rule)
//   - tests/a11y/smoke.spec.ts (rating cluster static markup verification)
//   - future: a Playwright spec once the dev-server CI gate exists
// What we CAN test here without jsdom is the pure helper +
// initial-render shape:

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe('generateIdempotencyKey', () => {
  it('returns a UUIDv4-shaped string when crypto.randomUUID is available', () => {
    const key = generateIdempotencyKey();
    expect(key).toMatch(UUID_RE);
  });

  it('successive calls produce distinct keys (no accidental reuse)', () => {
    const a = generateIdempotencyKey();
    const b = generateIdempotencyKey();
    const c = generateIdempotencyKey();
    expect(a).not.toBe(b);
    expect(b).not.toBe(c);
    expect(a).not.toBe(c);
  });

  it('returns empty string when crypto.randomUUID is unavailable (council r2 fold)', () => {
    // globalThis.crypto is a getter on Node 25 — direct assignment
    // throws. vi.stubGlobal handles the restore + assignment.
    const originalCrypto = globalThis.crypto;
    vi.stubGlobal('crypto', { ...originalCrypto, randomUUID: undefined });
    try {
      expect(generateIdempotencyKey()).toBe('');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('ReviewDeck rating cluster (initial-render markup)', () => {
  it('does NOT render rating buttons when answer is hidden (default state)', () => {
    const html = renderToStaticMarkup(
      <ReviewDeck
        cards={[{ id: '1', question: 'q', answer: 'a' }]}
        emptyCopy="empty"
      />,
    );
    // Rating button labels must not appear in the unrevealed state.
    expect(html).not.toContain('Again');
    expect(html).not.toContain('Hard');
    expect(html).not.toContain('Good');
    expect(html).not.toContain('Easy');
    // Rating cluster's role/label also absent.
    expect(html).not.toContain('Rate this card');
  });

  it('keeps the Show answer + Next card buttons visible in the unrevealed state', () => {
    const html = renderToStaticMarkup(
      <ReviewDeck
        cards={[
          { id: '1', question: 'q1', answer: 'a1' },
          { id: '2', question: 'q2', answer: 'a2' },
        ]}
        emptyCopy="empty"
      />,
    );
    expect(html).toContain('Show answer');
    expect(html).toContain('Next card');
  });
});
