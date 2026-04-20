import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

// Integration test for GET /auth/callback — the PKCE landing route that
// exchanges a Supabase Auth code for a session cookie, then redirects the
// user to the dashboard.
//
// Non-negotiables this suite enforces (plan §Non-negotiables + council
// rounds r1 / r2 / r3 on PR #22):
//
//   1. [security] console.error is never called with any argument
//      containing `code`, `access_token`, or `refresh_token` substrings
//      under ANY branch. Single most important safeguard per the
//      security persona.
//   2. [security] The success redirect destination is hardcoded to `/`.
//      No caller-supplied query parameter (e.g. `redirect_to`, `next`)
//      may influence it. Open-redirect guard.
//   3. [bugs] Input validation happens BEFORE any Supabase call.
//      Missing / empty / whitespace / oversized / non-URL-safe-base64
//      `code` values must redirect to /auth?error=invalid_request
//      without invoking the stub.
//   4. [bugs] Every failure branch — including `data.session: null`,
//      unparseable JSON from Supabase, and generic thrown Errors — maps
//      to a known error kind and 302s to /auth?error=<kind>. The route
//      never returns a 500.
//
// The Supabase client is stubbed at the apps/web/lib/supabase module
// boundary; the real @supabase/ssr and @supabase/supabase-js are not
// exercised here. That's intentional: this suite tests the route
// handler's control flow, not library behavior.

const exchangeCodeForSession = vi.fn();

vi.mock('../../lib/supabase', () => ({
  supabaseForRequest: () => ({
    auth: { exchangeCodeForSession },
  }),
}));

// Rate-limiter mock. The real @llmwiki/lib-ratelimit requires an Upstash
// env + network; swap it for a per-test spy so we can exercise both the
// allow-through and 429 branches without touching Redis. We re-export
// the real RateLimitExceededError class so the route's `instanceof`
// check still matches.
const reserveSpy = vi.fn(async () => undefined);

vi.mock('@llmwiki/lib-ratelimit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@llmwiki/lib-ratelimit')>();
  return {
    ...actual,
    makeAuthCallbackLimiter: () => ({ reserve: reserveSpy }),
  };
});

/** URL-safe base64 code of plausible length (32 chars). */
const VALID_CODE = 'abcdefghijklmnopqrstuvwxyz012345';

function makeReq(search: string): NextRequest {
  const url = new URL(`https://example.test/auth/callback${search}`);
  return new NextRequest(url);
}

/**
 * Scans every argument of every console.error call for any of the given
 * forbidden substrings. Fails the test if any is found. `code` is passed
 * in per-test because it varies; access_token / refresh_token are fixed.
 */
function assertNoTokenLeaks(errorSpy: ReturnType<typeof vi.spyOn>, code: string) {
  const forbidden = [code, 'access_token', 'refresh_token'];
  for (const call of errorSpy.mock.calls) {
    for (const arg of call) {
      const repr = typeof arg === 'string' ? arg : safeStringify(arg);
      for (const needle of forbidden) {
        if (!needle) continue;
        expect(repr).not.toContain(needle);
      }
    }
  }
}

function safeStringify(x: unknown): string {
  try {
    return JSON.stringify(x);
  } catch {
    return String(x);
  }
}

let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  exchangeCodeForSession.mockReset();
  reserveSpy.mockReset();
  reserveSpy.mockResolvedValue(undefined); // default: allow through
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  errorSpy.mockRestore();
});

// ---------------------------------------------------------------------------
// Input validation: redirect to ?error=invalid_request without calling
// Supabase. The stub must never fire.
// ---------------------------------------------------------------------------
describe('GET /auth/callback — input validation (no Supabase call)', () => {
  it('redirects to ?error=invalid_request when code is missing', async () => {
    const { GET } = await import('../../app/auth/callback/route');
    const res = await GET(makeReq(''));
    expect(res.status).toBe(307);
    const loc = new URL(res.headers.get('location') ?? '');
    expect(loc.pathname).toBe('/auth');
    expect(loc.searchParams.get('error')).toBe('invalid_request');
    expect(exchangeCodeForSession).not.toHaveBeenCalled();
    assertNoTokenLeaks(errorSpy, '');
  });

  it('redirects to ?error=invalid_request when code is empty', async () => {
    const { GET } = await import('../../app/auth/callback/route');
    const res = await GET(makeReq('?code='));
    expect(res.status).toBe(307);
    expect(new URL(res.headers.get('location') ?? '').searchParams.get('error')).toBe(
      'invalid_request',
    );
    expect(exchangeCodeForSession).not.toHaveBeenCalled();
  });

  it('redirects to ?error=invalid_request when code is whitespace', async () => {
    const { GET } = await import('../../app/auth/callback/route');
    const res = await GET(makeReq('?code=%20%20%20'));
    expect(new URL(res.headers.get('location') ?? '').searchParams.get('error')).toBe(
      'invalid_request',
    );
    expect(exchangeCodeForSession).not.toHaveBeenCalled();
  });

  it('redirects to ?error=invalid_request when code is too short', async () => {
    const { GET } = await import('../../app/auth/callback/route');
    const res = await GET(makeReq('?code=short'));
    expect(new URL(res.headers.get('location') ?? '').searchParams.get('error')).toBe(
      'invalid_request',
    );
    expect(exchangeCodeForSession).not.toHaveBeenCalled();
  });

  it('redirects to ?error=invalid_request when code exceeds 2048 chars', async () => {
    const { GET } = await import('../../app/auth/callback/route');
    const longCode = 'a'.repeat(2049);
    const res = await GET(makeReq(`?code=${longCode}`));
    expect(new URL(res.headers.get('location') ?? '').searchParams.get('error')).toBe(
      'invalid_request',
    );
    expect(exchangeCodeForSession).not.toHaveBeenCalled();
  });

  it('redirects to ?error=invalid_request when code is below MIN_CODE_LEN by one (council bugs r5)', async () => {
    // Boundary guard: MIN_CODE_LEN = 16. A code of exactly 15 chars must
    // be rejected. Pairs with the "accepts 16" success test below.
    const { GET } = await import('../../app/auth/callback/route');
    const res = await GET(makeReq(`?code=${'a'.repeat(15)}`));
    expect(new URL(res.headers.get('location') ?? '').searchParams.get('error')).toBe(
      'invalid_request',
    );
    expect(exchangeCodeForSession).not.toHaveBeenCalled();
  });

  it('redirects to ?error=invalid_request when code exceeds 4KB (also > 2048)', async () => {
    const { GET } = await import('../../app/auth/callback/route');
    const hugeCode = 'a'.repeat(5000);
    const res = await GET(makeReq(`?code=${hugeCode}`));
    expect(new URL(res.headers.get('location') ?? '').searchParams.get('error')).toBe(
      'invalid_request',
    );
    expect(exchangeCodeForSession).not.toHaveBeenCalled();
  });

  it('redirects to ?error=invalid_request when code contains null byte', async () => {
    const { GET } = await import('../../app/auth/callback/route');
    const res = await GET(makeReq('?code=abcdefghij%00klmnop'));
    expect(new URL(res.headers.get('location') ?? '').searchParams.get('error')).toBe(
      'invalid_request',
    );
    expect(exchangeCodeForSession).not.toHaveBeenCalled();
  });

  it('redirects to ?error=invalid_request when code contains special chars', async () => {
    const { GET } = await import('../../app/auth/callback/route');
    // The specific chars from council bugs r2 — `foo'bar"baz<qux>` padded
    // to pass the min-length check so the charset check is what rejects.
    const badCode = `abcdefghijklmnop'bar"baz<qux>`;
    const res = await GET(makeReq(`?code=${encodeURIComponent(badCode)}`));
    expect(new URL(res.headers.get('location') ?? '').searchParams.get('error')).toBe(
      'invalid_request',
    );
    expect(exchangeCodeForSession).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Success path: stub resolves without error → 302 to / (HARDCODED).
// No query param may influence the destination (open-redirect guard).
// ---------------------------------------------------------------------------
describe('GET /auth/callback — success', () => {
  it('redirects to / when exchangeCodeForSession resolves without error', async () => {
    exchangeCodeForSession.mockResolvedValueOnce({
      data: { session: { access_token: 'REDACTED' } },
      error: null,
    });
    const { GET } = await import('../../app/auth/callback/route');
    const res = await GET(makeReq(`?code=${VALID_CODE}`));
    expect(res.status).toBe(307);
    const loc = new URL(res.headers.get('location') ?? '');
    expect(loc.pathname).toBe('/');
    expect(loc.searchParams.has('error')).toBe(false);
    expect(exchangeCodeForSession).toHaveBeenCalledTimes(1);
    expect(exchangeCodeForSession).toHaveBeenCalledWith(VALID_CODE);
    assertNoTokenLeaks(errorSpy, VALID_CODE);
  });

  it('ignores extraneous ?redirect_to=evil.com — redirect stays hardcoded to /', async () => {
    // Council bugs r2: open-redirect guard. A future magic-link generator
    // that forwards a `redirect_to` param through the callback must NOT be
    // able to move a signed-in user to an arbitrary URL.
    exchangeCodeForSession.mockResolvedValueOnce({
      data: { session: { access_token: 'REDACTED' } },
      error: null,
    });
    const { GET } = await import('../../app/auth/callback/route');
    const res = await GET(
      makeReq(`?code=${VALID_CODE}&redirect_to=https://evil.example`),
    );
    const loc = new URL(res.headers.get('location') ?? '');
    expect(loc.origin).toBe('https://example.test');
    expect(loc.pathname).toBe('/');
    expect(loc.hostname).not.toContain('evil');
  });

  it('ignores extraneous ?next= — redirect stays hardcoded to /', async () => {
    exchangeCodeForSession.mockResolvedValueOnce({
      data: { session: { access_token: 'REDACTED' } },
      error: null,
    });
    const { GET } = await import('../../app/auth/callback/route');
    const res = await GET(makeReq(`?code=${VALID_CODE}&next=%2Fadmin`));
    const loc = new URL(res.headers.get('location') ?? '');
    expect(loc.pathname).toBe('/');
  });

  it('accepts a code of exactly MIN_CODE_LEN=16 chars (council bugs r5 boundary)', async () => {
    const minCode = 'a'.repeat(16);
    exchangeCodeForSession.mockResolvedValueOnce({
      data: { session: { access_token: 'REDACTED' } },
      error: null,
    });
    const { GET } = await import('../../app/auth/callback/route');
    const res = await GET(makeReq(`?code=${minCode}`));
    expect(new URL(res.headers.get('location') ?? '').pathname).toBe('/');
    expect(exchangeCodeForSession).toHaveBeenCalledWith(minCode);
  });

  it('accepts a code of exactly MAX_CODE_LEN=2048 chars (council bugs r5 boundary)', async () => {
    const maxCode = 'a'.repeat(2048);
    exchangeCodeForSession.mockResolvedValueOnce({
      data: { session: { access_token: 'REDACTED' } },
      error: null,
    });
    const { GET } = await import('../../app/auth/callback/route');
    const res = await GET(makeReq(`?code=${maxCode}`));
    expect(new URL(res.headers.get('location') ?? '').pathname).toBe('/');
    expect(exchangeCodeForSession).toHaveBeenCalledWith(maxCode);
  });

  it('uses the first `code` value when duplicated (council bugs r3)', async () => {
    exchangeCodeForSession.mockResolvedValueOnce({
      data: { session: { access_token: 'REDACTED' } },
      error: null,
    });
    const { GET } = await import('../../app/auth/callback/route');
    const res = await GET(makeReq(`?code=${VALID_CODE}&code=${'b'.repeat(32)}`));
    expect(exchangeCodeForSession).toHaveBeenCalledTimes(1);
    // searchParams.get() returns the FIRST occurrence; verify that behavior
    // is preserved by the route (no "accidentally the last" drift).
    expect(exchangeCodeForSession).toHaveBeenCalledWith(VALID_CODE);
    expect(new URL(res.headers.get('location') ?? '').pathname).toBe('/');
  });
});

// ---------------------------------------------------------------------------
// Supabase error branches: each known error shape maps to a specific kind.
// Unknown / unexpected shapes fall through to server_error via the final
// catch-all. No branch may return a 500 or leak a token.
// ---------------------------------------------------------------------------
describe('GET /auth/callback — Supabase error branches', () => {
  it('maps an expired-code error to ?error=token_expired', async () => {
    exchangeCodeForSession.mockResolvedValueOnce({
      data: { session: null },
      error: { message: 'PKCE code has expired', status: 400 },
    });
    const { GET } = await import('../../app/auth/callback/route');
    const res = await GET(makeReq(`?code=${VALID_CODE}`));
    expect(new URL(res.headers.get('location') ?? '').searchParams.get('error')).toBe(
      'token_expired',
    );
    assertNoTokenLeaks(errorSpy, VALID_CODE);
  });

  it('maps a consumed-code error to ?error=token_used', async () => {
    exchangeCodeForSession.mockResolvedValueOnce({
      data: { session: null },
      error: {
        message: 'Code already used; request a new magic link',
        status: 400,
      },
    });
    const { GET } = await import('../../app/auth/callback/route');
    const res = await GET(makeReq(`?code=${VALID_CODE}`));
    expect(new URL(res.headers.get('location') ?? '').searchParams.get('error')).toBe(
      'token_used',
    );
    assertNoTokenLeaks(errorSpy, VALID_CODE);
  });

  it('maps a 5xx Supabase error to ?error=server_error', async () => {
    exchangeCodeForSession.mockResolvedValueOnce({
      data: { session: null },
      error: { message: 'Internal server error', status: 502 },
    });
    const { GET } = await import('../../app/auth/callback/route');
    const res = await GET(makeReq(`?code=${VALID_CODE}`));
    expect(new URL(res.headers.get('location') ?? '').searchParams.get('error')).toBe(
      'server_error',
    );
    assertNoTokenLeaks(errorSpy, VALID_CODE);
  });

  it('maps a 200 OK with data.session: null to ?error=server_error', async () => {
    // Council bugs r1: an unexpected but not-erroring response shape.
    exchangeCodeForSession.mockResolvedValueOnce({
      data: { session: null },
      error: null,
    });
    const { GET } = await import('../../app/auth/callback/route');
    const res = await GET(makeReq(`?code=${VALID_CODE}`));
    expect(new URL(res.headers.get('location') ?? '').searchParams.get('error')).toBe(
      'server_error',
    );
  });

  it('maps a thrown generic Error to ?error=server_error (never 500)', async () => {
    // Council bugs r1: final catch-all. Something inside Supabase throws
    // (unparseable JSON, network, TypeError) — route must not propagate
    // as a 500.
    exchangeCodeForSession.mockRejectedValueOnce(new Error('boom'));
    const { GET } = await import('../../app/auth/callback/route');
    const res = await GET(makeReq(`?code=${VALID_CODE}`));
    expect(res.status).toBe(307);
    expect(new URL(res.headers.get('location') ?? '').searchParams.get('error')).toBe(
      'server_error',
    );
  });

  it('maps an unparseable-JSON throw (SyntaxError) to ?error=server_error', async () => {
    // Council bugs r2: an explicit test for this failure mode.
    exchangeCodeForSession.mockRejectedValueOnce(
      new SyntaxError('Unexpected token < in JSON at position 0'),
    );
    const { GET } = await import('../../app/auth/callback/route');
    const res = await GET(makeReq(`?code=${VALID_CODE}`));
    expect(res.status).toBe(307);
    expect(new URL(res.headers.get('location') ?? '').searchParams.get('error')).toBe(
      'server_error',
    );
  });

  it('maps a non-Error throw to ?error=server_error', async () => {
    // Defense in depth: Supabase could in theory reject with a non-Error.
    exchangeCodeForSession.mockRejectedValueOnce('string rejection');
    const { GET } = await import('../../app/auth/callback/route');
    const res = await GET(makeReq(`?code=${VALID_CODE}`));
    expect(new URL(res.headers.get('location') ?? '').searchParams.get('error')).toBe(
      'server_error',
    );
  });
});

// ---------------------------------------------------------------------------
// Rate limiting: per-IP 20/min. Over-limit returns 429 with Retry-After.
// Upstash outage is fail-open (handled inside the limiter itself; tested
// separately in the ratelimit package's unit suite).
// ---------------------------------------------------------------------------
describe('GET /auth/callback — rate limiting (council r4 blocker)', () => {
  it('returns 429 with Retry-After when the limiter rejects', async () => {
    const { RateLimitExceededError } = await import('@llmwiki/lib-ratelimit');
    const resetsAt = new Date(Date.now() + 30_000);
    reserveSpy.mockRejectedValueOnce(
      new RateLimitExceededError('auth_callback_ip', resetsAt),
    );
    const { GET } = await import('../../app/auth/callback/route');
    const res = await GET(makeReq(`?code=${VALID_CODE}`));
    expect(res.status).toBe(429);
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(Number(res.headers.get('retry-after'))).toBeLessThanOrEqual(31);
    // The 429 short-circuits before the Supabase call.
    expect(exchangeCodeForSession).not.toHaveBeenCalled();
    // No tokens in logs (even though we never got to a code branch).
    assertNoTokenLeaks(errorSpy, VALID_CODE);
  });

  it('gates the rate limit on each request (bucket is request-scoped)', async () => {
    // The route must CALL the limiter. Regression guard: if a future
    // refactor moves the limiter behind a broken conditional, this test
    // fails before the 429 test does.
    exchangeCodeForSession.mockResolvedValueOnce({
      data: { session: { access_token: 'REDACTED' } },
      error: null,
    });
    const { GET } = await import('../../app/auth/callback/route');
    await GET(makeReq(`?code=${VALID_CODE}`));
    expect(reserveSpy).toHaveBeenCalledTimes(1);
  });

  it('buckets by X-Forwarded-For first entry, trimmed', async () => {
    exchangeCodeForSession.mockResolvedValueOnce({
      data: { session: { access_token: 'REDACTED' } },
      error: null,
    });
    const { GET } = await import('../../app/auth/callback/route');
    const req = new NextRequest(
      new URL(`https://example.test/auth/callback?code=${VALID_CODE}`),
      { headers: { 'x-forwarded-for': ' 203.0.113.9 , 10.0.0.1' } },
    );
    await GET(req);
    expect(reserveSpy).toHaveBeenCalledWith('203.0.113.9');
  });

  it('falls back to x-real-ip when x-forwarded-for is absent (council bugs r6)', async () => {
    // Some deployment targets (non-Vercel edges, local docker, odd
    // proxy chains) set x-real-ip instead of x-forwarded-for. The
    // implementation tries XFF first, then XRI, then the shared
    // no-xff bucket. Lock the XRI branch in.
    exchangeCodeForSession.mockResolvedValueOnce({
      data: { session: { access_token: 'REDACTED' } },
      error: null,
    });
    const { GET } = await import('../../app/auth/callback/route');
    const req = new NextRequest(
      new URL(`https://example.test/auth/callback?code=${VALID_CODE}`),
      { headers: { 'x-real-ip': '198.51.100.5' } },
    );
    await GET(req);
    expect(reserveSpy).toHaveBeenCalledWith('198.51.100.5');
  });

  it('falls back to a shared "no-xff" bucket when XFF is missing', async () => {
    // Fail-closed on missing IP (a la /api/auth/magic-link) would bounce
    // any user behind an odd proxy chain. Shared bucket is worse for
    // the attacker (they compete with everyone else) but strictly safer
    // for legit users.
    exchangeCodeForSession.mockResolvedValueOnce({
      data: { session: { access_token: 'REDACTED' } },
      error: null,
    });
    const { GET } = await import('../../app/auth/callback/route');
    await GET(makeReq(`?code=${VALID_CODE}`));
    expect(reserveSpy).toHaveBeenCalledWith('no-xff');
  });
});

// ---------------------------------------------------------------------------
// Token leakage: the console.error spy must never see any token substring.
// This is deliberately its own describe block so a regression is obvious
// from the test name in CI output.
// ---------------------------------------------------------------------------
describe('GET /auth/callback — no token leakage in logs', () => {
  const branches: ReadonlyArray<readonly [string, () => void]> = [
    [
      'expired',
      () =>
        exchangeCodeForSession.mockResolvedValueOnce({
          data: { session: null },
          error: { message: 'PKCE code has expired', status: 400 },
        }),
    ],
    [
      'used',
      () =>
        exchangeCodeForSession.mockResolvedValueOnce({
          data: { session: null },
          error: { message: 'Code already used', status: 400 },
        }),
    ],
    [
      '5xx',
      () =>
        exchangeCodeForSession.mockResolvedValueOnce({
          data: { session: null },
          error: { message: 'upstream down', status: 503 },
        }),
    ],
    [
      'null-session',
      () =>
        exchangeCodeForSession.mockResolvedValueOnce({
          data: { session: null },
          error: null,
        }),
    ],
    ['thrown', () => exchangeCodeForSession.mockRejectedValueOnce(new Error('boom'))],
  ];

  for (const [label, arrange] of branches) {
    it(`does not log code/access_token/refresh_token on ${label}`, async () => {
      arrange();
      const { GET } = await import('../../app/auth/callback/route');
      await GET(makeReq(`?code=${VALID_CODE}`));
      assertNoTokenLeaks(errorSpy, VALID_CODE);
    });
  }
});
