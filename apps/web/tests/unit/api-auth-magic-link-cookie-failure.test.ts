// Integration test for POST /api/auth/magic-link cookie_failure branch.
//
// @supabase/ssr writes the PKCE code-verifier cookie during
// signInWithOtp(). If that write halts transactionally (setAll throws
// unexpectedly), the user sees a 200 OK from our route and thinks the
// email will arrive — but later when they click the link, /auth/callback
// fails with "no valid flow state" because the verifier was never written.
//
// Issue #31 (filed from PR #29 council r1-r2). The fix: after
// signInWithOtp(), read supabase.getCookieWriteFailure(). If non-null,
// roll back any partially-written cookies and return 500 with generic
// error copy.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const signInWithOtp = vi.fn();
const cookieWriteFailure: { current: { errorName: string } | null } = {
  current: null,
};
const writtenCookieNames: { current: readonly string[] } = { current: [] };

vi.mock('../../lib/supabase', () => ({
  supabaseForRequest: () => ({
    auth: { signInWithOtp },
    getCookieWriteFailure: () => cookieWriteFailure.current,
    getWrittenCookieNames: () => writtenCookieNames.current,
  }),
}));

// Rate limiter mock — always allow through.
vi.mock('@llmwiki/lib-ratelimit', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@llmwiki/lib-ratelimit')>();
  return {
    ...actual,
    makeMagicLinkLimiter: () => ({
      reserve: vi.fn(async () => undefined),
    }),
  };
});

const cookieDeleteStub = vi.fn();
vi.mock('next/headers', () => ({
  cookies: async () => ({
    getAll: () => [] as Array<{ name: string; value: string }>,
    set: vi.fn(),
    delete: (name: string) => cookieDeleteStub(name),
  }),
}));

function req(email: string): NextRequest {
  return new NextRequest(
    new URL('https://example.test/api/auth/magic-link'),
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-forwarded-for': '203.0.113.9',
      },
      body: JSON.stringify({ email }),
    },
  );
}

let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  process.env.APP_BASE_URL = 'https://example.test';
  signInWithOtp.mockReset();
  signInWithOtp.mockResolvedValue({ error: null });
  cookieWriteFailure.current = null;
  writtenCookieNames.current = [];
  cookieDeleteStub.mockReset();
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  errorSpy.mockRestore();
});

describe('POST /api/auth/magic-link — cookie_failure branch (issue #31)', () => {
  it('returns 500 when the cookie adapter halted during signInWithOtp', async () => {
    cookieWriteFailure.current = { errorName: 'Error' };
    writtenCookieNames.current = ['sb-code-verifier.0'];

    const { POST } = await import('../../app/api/auth/magic-link/route');
    const res = await POST(req('user@example.com'));
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toMatch(/sign-in|try again|request/i);
  });

  it('deletes every partially-written verifier cookie on rollback', async () => {
    cookieWriteFailure.current = { errorName: 'Error' };
    writtenCookieNames.current = [
      'sb-code-verifier.0',
      'sb-code-verifier.1',
    ];

    const { POST } = await import('../../app/api/auth/magic-link/route');
    await POST(req('user@example.com'));
    expect(cookieDeleteStub).toHaveBeenCalledTimes(2);
    expect(cookieDeleteStub).toHaveBeenCalledWith('sb-code-verifier.0');
    expect(cookieDeleteStub).toHaveBeenCalledWith('sb-code-verifier.1');
  });

  it('no rollback attempts when nothing was written before the halt', async () => {
    cookieWriteFailure.current = { errorName: 'TypeError' };
    writtenCookieNames.current = [];

    const { POST } = await import('../../app/api/auth/magic-link/route');
    const res = await POST(req('user@example.com'));
    expect(res.status).toBe(500);
    expect(cookieDeleteStub).not.toHaveBeenCalled();
  });

  it('cookie_failure log never contains the email or an access token', async () => {
    cookieWriteFailure.current = { errorName: 'Error' };
    writtenCookieNames.current = ['sb-code-verifier.0'];
    const email = 'secret-user@example.com';

    const { POST } = await import('../../app/api/auth/magic-link/route');
    await POST(req(email));
    for (const call of errorSpy.mock.calls) {
      for (const arg of call) {
        const repr =
          typeof arg === 'string' ? arg : JSON.stringify(arg);
        expect(repr).not.toContain(email);
        expect(repr).not.toContain('access_token');
        expect(repr).not.toContain('refresh_token');
      }
    }
  });

  it('200 OK happy path when cookie adapter reports no failure', async () => {
    // Regression guard: ensure the cookie_failure check doesn't short-
    // circuit successful sign-in requests.
    const { POST } = await import('../../app/api/auth/magic-link/route');
    const res = await POST(req('user@example.com'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok?: boolean };
    expect(body.ok).toBe(true);
    expect(cookieDeleteStub).not.toHaveBeenCalled();
  });

  it('cookie_failure takes precedence over a signInWithOtp error', async () => {
    // If both fail, the cookie-write halt is the proximate actionable
    // cause. Mirrors the /auth/callback precedence logic.
    signInWithOtp.mockResolvedValueOnce({
      error: { name: 'SomeError', message: 'upstream hiccup', status: 502 },
    });
    cookieWriteFailure.current = { errorName: 'Error' };
    writtenCookieNames.current = ['sb-code-verifier.0'];

    const { POST } = await import('../../app/api/auth/magic-link/route');
    const res = await POST(req('user@example.com'));
    expect(res.status).toBe(500);
    expect(cookieDeleteStub).toHaveBeenCalledWith('sb-code-verifier.0');
  });
});
