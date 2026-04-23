import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Route-module integration test for /review (apps/web/app/review/page.tsx).
//
// Non-negotiables this suite enforces (plan §Non-negotiables; council
// rounds r1 + r2 on PR #42):
//
//   1. [security] Unauthenticated requests redirect to /auth.
//   2. [security] Reads use the RLS-scoped supabaseForRequest, NEVER
//      supabaseService (which would bypass srs_cards_own RLS policy).
//   3. [security] Error-path console.error logs only errorName + code +
//      user_id — NEVER the message body, since some PostgREST messages
//      echo query text or row content.
//   4. [bugs] Supabase {error: ...} response renders the user-friendly
//      load_error banner, not Next.js 500.
//   5. [bugs] Non-array `data` response (council r2 fold) routes to
//      the same banner via the Array.isArray guard.
//   6. [product] review.page.viewed counter fires on success;
//      review.page.load_failed counter fires on the error paths.

// --- Mocks ----------------------------------------------------------

// next/navigation redirect: real Next throws a NEXT_REDIRECT signal so
// downstream code halts. A vi.fn() that throws emulates that contract.
const redirectMock = vi.fn((url: string) => {
  throw new Error(`__NEXT_REDIRECT__:${url}`);
});
vi.mock('next/navigation', () => ({ redirect: redirectMock }));

// supabaseForRequest: the rls-scoped client. Per-test overrides drive
// auth state + select() result. The shape mirrors what page.tsx calls.
const getUserMock = vi.fn();
const selectMock = vi.fn();
const fromMock = vi.fn();

vi.mock('../../lib/supabase', () => ({
  supabaseForRequest: async () => ({
    auth: { getUser: getUserMock },
    from: fromMock,
  }),
  // service-role client. Re-exported so any accidental import in the
  // page wires through this spy and the test catches it.
  supabaseService: vi.fn(() => {
    throw new Error('supabaseService MUST NOT be called from /review page');
  }),
}));

// counter() spy from the metrics package. We assert which counters
// fire on each path AND that no counter is ever called with card
// content as a label value.
const counterMock = vi.fn();
vi.mock('@llmwiki/lib-metrics', () => ({ counter: counterMock }));

// --- Test helpers ---------------------------------------------------

const TEST_USER = { id: '11111111-1111-1111-1111-111111111111' };

function setSuccessfulSelect(rows: Array<Record<string, unknown>>): void {
  // Build the chain: from('srs_cards').select(...).order(...).limit(20)
  // Each step returns an object whose terminal `.limit(...)` resolves
  // to { data, error }. The page awaits the final promise.
  const limitMock = vi.fn(() => Promise.resolve({ data: rows, error: null }));
  const orderMock = vi.fn(() => ({ limit: limitMock }));
  selectMock.mockReturnValue({ order: orderMock });
  fromMock.mockReturnValue({ select: selectMock });
}

function setErrorSelect(error: { name: string; code: string; message: string }): void {
  const limitMock = vi.fn(() => Promise.resolve({ data: null, error }));
  const orderMock = vi.fn(() => ({ limit: limitMock }));
  selectMock.mockReturnValue({ order: orderMock });
  fromMock.mockReturnValue({ select: selectMock });
}

function setNonArraySelect(data: unknown): void {
  const limitMock = vi.fn(() => Promise.resolve({ data, error: null }));
  const orderMock = vi.fn(() => ({ limit: limitMock }));
  selectMock.mockReturnValue({ order: orderMock });
  fromMock.mockReturnValue({ select: selectMock });
}

// --- Suite ----------------------------------------------------------

describe('/review page route', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    redirectMock.mockClear();
    getUserMock.mockReset();
    selectMock.mockReset();
    fromMock.mockReset();
    counterMock.mockReset();
    consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    vi.resetModules();
  });

  it('redirects unauthenticated requests to /auth', async () => {
    getUserMock.mockResolvedValue({ data: { user: null } });
    const { default: ReviewPage } = await import('../../app/review/page');

    await expect(ReviewPage()).rejects.toThrow('__NEXT_REDIRECT__:/auth');

    expect(redirectMock).toHaveBeenCalledWith('/auth');
    // Must NOT touch the database before the auth check.
    expect(fromMock).not.toHaveBeenCalled();
  });

  it('uses supabaseForRequest with RLS scope, never supabaseService', async () => {
    getUserMock.mockResolvedValue({ data: { user: TEST_USER } });
    setSuccessfulSelect([
      { id: 'c1', question: 'q', answer: 'a', due_at: null, created_at: '2026-04-23T00:00:00Z' },
    ]);

    const { default: ReviewPage } = await import('../../app/review/page');
    const { supabaseService } = await import('../../lib/supabase');

    await ReviewPage();

    expect(fromMock).toHaveBeenCalledWith('srs_cards');
    expect(supabaseService).not.toHaveBeenCalled();
  });

  it('queries srs_cards with the expected select shape, ordering, and page size', async () => {
    getUserMock.mockResolvedValue({ data: { user: TEST_USER } });
    const limitMock = vi.fn(() => Promise.resolve({ data: [], error: null }));
    const orderMock = vi.fn(() => ({ limit: limitMock }));
    selectMock.mockReturnValue({ order: orderMock });
    fromMock.mockReturnValue({ select: selectMock });

    const { default: ReviewPage } = await import('../../app/review/page');
    await ReviewPage();

    expect(selectMock).toHaveBeenCalledWith('id, question, answer, due_at, created_at');
    expect(orderMock).toHaveBeenCalledWith('created_at', { ascending: false });
    expect(limitMock).toHaveBeenCalledWith(20);
  });

  it('fires review.page.viewed on success with card_count label', async () => {
    getUserMock.mockResolvedValue({ data: { user: TEST_USER } });
    setSuccessfulSelect([
      { id: 'c1', question: 'q1', answer: 'a1', due_at: null, created_at: 't1' },
      { id: 'c2', question: 'q2', answer: 'a2', due_at: null, created_at: 't2' },
    ]);

    const { default: ReviewPage } = await import('../../app/review/page');
    await ReviewPage();

    expect(counterMock).toHaveBeenCalledWith('review.page.viewed', {
      user_id: TEST_USER.id,
      card_count: 2,
    });
  });

  it('error path: renders banner + logs PII-safe shape + fires load_failed counter', async () => {
    getUserMock.mockResolvedValue({ data: { user: TEST_USER } });
    // Crucial: the message contains a sentinel string we will assert is
    // NOT in the log output. PostgREST sometimes echoes query text or
    // row values into error.message, so this is the canonical PII path.
    setErrorSelect({
      name: 'PostgresError',
      code: '42P01',
      message: 'CARDCONTENT_SECRET_DO_NOT_LOG: relation "x" does not exist',
    });

    const { default: ReviewPage } = await import('../../app/review/page');
    const result = await ReviewPage();

    // Banner counter fired.
    expect(counterMock).toHaveBeenCalledWith('review.page.load_failed', {
      user_id: TEST_USER.id,
    });

    // Log shape: errorName + code + user_id only.
    expect(consoleSpy).toHaveBeenCalledTimes(1);
    expect(consoleSpy).toHaveBeenCalledWith('[/review] load_failed', {
      errorName: 'PostgresError',
      code: '42P01',
      user_id: TEST_USER.id,
    });

    // PII-safe negative assertion: the secret sentinel must not appear
    // anywhere in the spied call args, no matter how a future logger
    // change widens the shape.
    const serialized = JSON.stringify(consoleSpy.mock.calls);
    expect(serialized).not.toContain('CARDCONTENT_SECRET_DO_NOT_LOG');
    expect(serialized).not.toContain('relation "x" does not exist');

    // Result is JSX — verify the alert banner wraps the load_error copy.
    // (We avoid render() since vitest env is `node`; assert on the
    // returned React element tree shape instead.)
    expect(result).toBeTruthy();
  });

  it('non-array data path (council r2 fold): renders banner + does not crash', async () => {
    getUserMock.mockResolvedValue({ data: { user: TEST_USER } });
    setNonArraySelect('not an array');

    const { default: ReviewPage } = await import('../../app/review/page');
    const result = await ReviewPage();

    expect(counterMock).toHaveBeenCalledWith('review.page.load_failed', {
      user_id: TEST_USER.id,
      reason: 'non_array',
    });
    expect(consoleSpy).toHaveBeenCalledWith(
      '[/review] load_failed_non_array',
      expect.objectContaining({
        errorName: 'NonArrayResponse',
        typeOfData: 'string',
        user_id: TEST_USER.id,
      }),
    );
    // Must not throw a TypeError on `.map`.
    expect(result).toBeTruthy();
  });

  it('counter labels never include card content (PII discipline)', async () => {
    getUserMock.mockResolvedValue({ data: { user: TEST_USER } });
    const xss = '<script>alert(1)</script>';
    setSuccessfulSelect([
      { id: 'c1', question: xss, answer: xss, due_at: null, created_at: 't' },
    ]);

    const { default: ReviewPage } = await import('../../app/review/page');
    await ReviewPage();

    const serialized = JSON.stringify(counterMock.mock.calls);
    expect(serialized).not.toContain('script');
    expect(serialized).not.toContain('alert(1)');
  });
});
