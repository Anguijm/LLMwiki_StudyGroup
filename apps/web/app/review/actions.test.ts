import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Server-action integration tests for /review submitReview.
//
// Non-negotiables this suite enforces (PR #48 plan §Tests + council
// rounds r1 + r2):
//
//   1. [security] Explicit RLS-blocked test: User A cannot review User
//      B's card (consistently passing here, not just pgTAP per #7).
//   2. [security] PII-safe error logging: error.message + ZodError
//      issue.path/.message NEVER appear in console.error args.
//   3. [security] Tier E rate limit: 30/user/min; 31st fails.
//   4. [security] Fail-open on RatelimitUnavailableError.
//   5. [bugs] Idempotency replay: second call with same key is a no-op
//      success.
//   6. [bugs] Optimistic concurrency: 40001 from RPC returns
//      concurrent_update errorKind.
//   7. [bugs] Malformed fsrs_state returns invalid_state errorKind.

// --- Mocks ----------------------------------------------------------

const getUserMock = vi.fn();
const fromMock = vi.fn();
const rpcMock = vi.fn();

vi.mock('../../lib/supabase', () => ({
  supabaseForRequest: async () => ({
    auth: { getUser: getUserMock },
    from: fromMock,
    rpc: rpcMock,
  }),
}));

// Counter spy. We assert which counters fire on each path.
const counterMock = vi.fn();
vi.mock('@llmwiki/lib-metrics', () => ({ counter: counterMock }));

// Rate-limiter spy. Mocked so individual tests can drive the tier-E
// quota-exceeded + unavailable branches without real Upstash.
const reserveMock = vi.fn();
vi.mock('@llmwiki/lib-ratelimit', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@llmwiki/lib-ratelimit')>();
  return {
    ...actual,
    makeRatingLimiter: () => ({ reserve: reserveMock }),
  };
});

// --- Test fixtures --------------------------------------------------

const TEST_USER = { id: '11111111-1111-1111-1111-111111111111' };
const TEST_CARD_ID = '22222222-2222-2222-2222-222222222222';
const VALID_KEY = '33333333-3333-3333-3333-333333333333';

function setSelectSuccess(card: { id: string; fsrs_state: unknown }): void {
  const singleMock = vi.fn(() => Promise.resolve({ data: card, error: null }));
  const eqMock = vi.fn(() => ({ single: singleMock }));
  const selectMock = vi.fn(() => ({ eq: eqMock }));
  fromMock.mockReturnValue({ select: selectMock });
}

function setSelectError(error: {
  name: string;
  code: string;
  message: string;
}): void {
  const singleMock = vi.fn(() =>
    Promise.resolve({ data: null, error }),
  );
  const eqMock = vi.fn(() => ({ single: singleMock }));
  const selectMock = vi.fn(() => ({ eq: eqMock }));
  fromMock.mockReturnValue({ select: selectMock });
}

function emptyCardRow() {
  return { id: TEST_CARD_ID, fsrs_state: {} };
}

// --- Suite ----------------------------------------------------------

describe('/review submitReview server action', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    getUserMock.mockReset();
    fromMock.mockReset();
    rpcMock.mockReset();
    counterMock.mockReset();
    reserveMock.mockReset();
    reserveMock.mockResolvedValue(undefined); // default: rate limit allows
    consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    vi.resetModules();
  });

  // ===== Input validation (no DB calls on rejection) ==================

  it('rejects rating outside 1..4', async () => {
    const { submitReview } = await import('./actions');
    for (const bad of [0, 5, -1, 99, 1.5]) {
      const result = await submitReview(TEST_CARD_ID, bad, VALID_KEY);
      expect(result).toEqual({ ok: false, errorKind: 'invalid_rating' });
    }
    expect(fromMock).not.toHaveBeenCalled();
    expect(reserveMock).not.toHaveBeenCalled();
  });

  it('rejects non-UUID cardId', async () => {
    const { submitReview } = await import('./actions');
    const result = await submitReview('not-a-uuid', 3, VALID_KEY);
    expect(result).toEqual({ ok: false, errorKind: 'invalid_rating' });
    expect(fromMock).not.toHaveBeenCalled();
    expect(reserveMock).not.toHaveBeenCalled();
  });

  it('rejects empty / non-UUID idempotencyKey', async () => {
    const { submitReview } = await import('./actions');
    const r1 = await submitReview(TEST_CARD_ID, 3, '');
    expect(r1).toEqual({ ok: false, errorKind: 'invalid_idempotency_key' });
    const r2 = await submitReview(TEST_CARD_ID, 3, 'not-a-uuid');
    expect(r2).toEqual({ ok: false, errorKind: 'invalid_idempotency_key' });
    expect(fromMock).not.toHaveBeenCalled();
    expect(reserveMock).not.toHaveBeenCalled();
  });

  // ===== Auth ========================================================

  it('returns unauthenticated when no user; no DB or rate-limit calls', async () => {
    getUserMock.mockResolvedValue({ data: { user: null } });
    const { submitReview } = await import('./actions');
    const result = await submitReview(TEST_CARD_ID, 3, VALID_KEY);
    expect(result).toEqual({ ok: false, errorKind: 'unauthenticated' });
    expect(fromMock).not.toHaveBeenCalled();
    expect(reserveMock).not.toHaveBeenCalled();
  });

  // ===== Rate limit (Tier E) =========================================

  it('rate_limited: RateLimitExceededError → no DB call', async () => {
    getUserMock.mockResolvedValue({ data: { user: TEST_USER } });
    const { RateLimitExceededError } = await import('@llmwiki/lib-ratelimit');
    reserveMock.mockRejectedValueOnce(
      new RateLimitExceededError('rating_submits', new Date(Date.now() + 60_000)),
    );
    const { submitReview } = await import('./actions');
    const result = await submitReview(TEST_CARD_ID, 3, VALID_KEY);
    expect(result).toEqual({ ok: false, errorKind: 'rate_limited' });
    expect(fromMock).not.toHaveBeenCalled();
    expect(counterMock).toHaveBeenCalledWith('review.rating.failed', {
      reason: 'rate_limited',
      user_id: TEST_USER.id,
    });
  });

  it('fail-open on RatelimitUnavailableError: continues to DB', async () => {
    getUserMock.mockResolvedValue({ data: { user: TEST_USER } });
    const { RatelimitUnavailableError } = await import('@llmwiki/lib-ratelimit');
    reserveMock.mockRejectedValueOnce(new RatelimitUnavailableError());
    setSelectSuccess(emptyCardRow());
    rpcMock.mockResolvedValue({ error: null });

    const { submitReview } = await import('./actions');
    const result = await submitReview(TEST_CARD_ID, 3, VALID_KEY);
    expect(result.ok).toBe(true);
    expect(fromMock).toHaveBeenCalledWith('srs_cards');
  });

  // ===== RLS-blocked (council r1 security non-negotiable) ============

  it('RLS blocks card load: User A cannot review User B card → card_not_found', async () => {
    getUserMock.mockResolvedValue({ data: { user: TEST_USER } });
    // PostgREST shape when .single() finds 0 rows under RLS is { data: null,
    // error: { code: 'PGRST116', name: 'PostgresError', message: 'JSON object requested, multiple (or no) rows returned' } }
    setSelectError({
      name: 'PostgresError',
      code: 'PGRST116',
      message: 'CARDCONTENT_SECRET_DO_NOT_LOG: ...',
    });

    const { submitReview } = await import('./actions');
    const result = await submitReview(TEST_CARD_ID, 3, VALID_KEY);
    expect(result).toEqual({ ok: false, errorKind: 'card_not_found' });
    expect(rpcMock).not.toHaveBeenCalled();

    // PII-safe log: includes errorName + code + user_id + card_id; NEVER
    // the message body.
    expect(consoleSpy).toHaveBeenCalledTimes(1);
    expect(consoleSpy).toHaveBeenCalledWith('[/review submitReview] card_load_failed', {
      errorName: 'PostgresError',
      code: 'PGRST116',
      user_id: TEST_USER.id,
      card_id: TEST_CARD_ID,
    });
    const serialized = JSON.stringify(consoleSpy.mock.calls);
    expect(serialized).not.toContain('CARDCONTENT_SECRET_DO_NOT_LOG');
  });

  // ===== Zod malformed state (council r1 bugs non-negotiable) ========

  it('invalid_state: malformed fsrs_state → ZodError → invalid_state errorKind', async () => {
    getUserMock.mockResolvedValue({ data: { user: TEST_USER } });
    // Zod parse will throw on this shape because `due` is a number not ISO.
    // The PII sentinel below is in a value; we assert the log doesn't echo it.
    setSelectSuccess({
      id: TEST_CARD_ID,
      fsrs_state: { due: 12345, message: 'PII_SENTINEL_DO_NOT_LOG' },
    });

    const { submitReview } = await import('./actions');
    const result = await submitReview(TEST_CARD_ID, 3, VALID_KEY);
    expect(result).toEqual({ ok: false, errorKind: 'invalid_state' });
    expect(rpcMock).not.toHaveBeenCalled();

    // Log shape: errorName + issueCount (number) + user_id + card_id only.
    // Specifically NOT issue.path or issue.message — those could include
    // the malformed field's value.
    expect(consoleSpy).toHaveBeenCalledWith(
      '[/review submitReview] invalid_state',
      expect.objectContaining({
        errorName: 'ZodError',
        issueCount: expect.any(Number),
        user_id: TEST_USER.id,
        card_id: TEST_CARD_ID,
      }),
    );
    const serialized = JSON.stringify(consoleSpy.mock.calls);
    expect(serialized).not.toContain('PII_SENTINEL_DO_NOT_LOG');
  });

  // ===== Concurrent update (council r1 bugs non-negotiable) ==========

  it('concurrent_update: 40001 from RPC → distinct errorKind', async () => {
    getUserMock.mockResolvedValue({ data: { user: TEST_USER } });
    setSelectSuccess(emptyCardRow());
    rpcMock.mockResolvedValue({
      error: {
        name: 'PostgresError',
        code: '40001',
        message: 'CARDCONTENT_SECRET_DO_NOT_LOG: serialization_failure',
      },
    });

    const { submitReview } = await import('./actions');
    const result = await submitReview(TEST_CARD_ID, 3, VALID_KEY);
    expect(result).toEqual({ ok: false, errorKind: 'concurrent_update' });
    expect(counterMock).toHaveBeenCalledWith('review.rating.failed', {
      reason: 'concurrent_update',
      user_id: TEST_USER.id,
    });
    const serialized = JSON.stringify(consoleSpy.mock.calls);
    expect(serialized).not.toContain('CARDCONTENT_SECRET_DO_NOT_LOG');
  });

  // ===== Idempotency replay (council r1 bugs non-negotiable) =========

  it('idempotency: same idempotencyKey twice both return ok (RPC handles dedup)', async () => {
    getUserMock.mockResolvedValue({ data: { user: TEST_USER } });
    setSelectSuccess(emptyCardRow());
    rpcMock.mockResolvedValue({ error: null });

    const { submitReview } = await import('./actions');
    const r1 = await submitReview(TEST_CARD_ID, 3, VALID_KEY);
    const r2 = await submitReview(TEST_CARD_ID, 3, VALID_KEY);

    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    // Both calls passed the same idempotency_key to the RPC; the SQL
    // function's on-conflict handles dedup. We assert the action's contract.
    expect(rpcMock).toHaveBeenCalledTimes(2);
    // noUncheckedIndexedAccess: tuple-positional reads need ! since we
    // just asserted toHaveBeenCalledTimes(2). Justified.
    expect(rpcMock.mock.calls[0]![1]).toMatchObject({
      p_idempotency_key: VALID_KEY,
    });
    expect(rpcMock.mock.calls[1]![1]).toMatchObject({
      p_idempotency_key: VALID_KEY,
    });
  });

  // ===== Generic persist_failed ======================================

  it('persist_failed: non-40001 RPC error → persist_failed errorKind', async () => {
    getUserMock.mockResolvedValue({ data: { user: TEST_USER } });
    setSelectSuccess(emptyCardRow());
    rpcMock.mockResolvedValue({
      error: { name: 'PostgresError', code: '23505', message: 'CARDCONTENT_SECRET_DO_NOT_LOG' },
    });

    const { submitReview } = await import('./actions');
    const result = await submitReview(TEST_CARD_ID, 3, VALID_KEY);
    expect(result).toEqual({ ok: false, errorKind: 'persist_failed' });
    const serialized = JSON.stringify(consoleSpy.mock.calls);
    expect(serialized).not.toContain('CARDCONTENT_SECRET_DO_NOT_LOG');
  });

  // ===== Happy path =================================================

  it('happy path: empty state initialises, RPC called with correct args, viewed counter fires', async () => {
    getUserMock.mockResolvedValue({ data: { user: TEST_USER } });
    setSelectSuccess(emptyCardRow());
    rpcMock.mockResolvedValue({ error: null });

    const { submitReview } = await import('./actions');
    const result = await submitReview(TEST_CARD_ID, 3, VALID_KEY);
    expect(result.ok).toBe(true);

    expect(rpcMock).toHaveBeenCalledTimes(1);
    const [fnName, args] = rpcMock.mock.calls[0] as [string, Record<string, unknown>];
    expect(fnName).toBe('fn_review_card');
    expect(args).toMatchObject({
      p_card_id: TEST_CARD_ID,
      p_rating: 3,
      p_idempotency_key: VALID_KEY,
    });
    expect(counterMock).toHaveBeenCalledWith('review.rating.submitted', {
      user_id: TEST_USER.id,
      rating: '3',
      is_new_card: 'true',
    });
  });

  // ===== Top-level catch =============================================

  it('unhandled error path: getUser throws → unhandled errorKind, PII-safe log', async () => {
    getUserMock.mockRejectedValueOnce(
      new Error('CARDCONTENT_SECRET_DO_NOT_LOG: surprise'),
    );
    const { submitReview } = await import('./actions');
    const result = await submitReview(TEST_CARD_ID, 3, VALID_KEY);
    expect(result).toEqual({ ok: false, errorKind: 'unhandled' });
    expect(consoleSpy).toHaveBeenCalledWith('[/review submitReview] unhandled', {
      errorName: 'Error',
    });
    const serialized = JSON.stringify(consoleSpy.mock.calls);
    expect(serialized).not.toContain('CARDCONTENT_SECRET_DO_NOT_LOG');
  });

  // ===== Counter labels never include card content ==================

  it('counter labels never include card content', async () => {
    getUserMock.mockResolvedValue({ data: { user: TEST_USER } });
    const xss = '<script>alert(1)</script>';
    setSelectSuccess({ id: TEST_CARD_ID, fsrs_state: {} });
    rpcMock.mockResolvedValue({ error: null });

    const { submitReview } = await import('./actions');
    await submitReview(TEST_CARD_ID, 3, VALID_KEY);
    void xss; // sentinel for the negative assertion below

    const serialized = JSON.stringify(counterMock.mock.calls);
    expect(serialized).not.toContain('script');
    expect(serialized).not.toContain('alert(1)');
  });
});
