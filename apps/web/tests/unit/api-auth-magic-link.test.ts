import { describe, it, expect, vi } from 'vitest';
import { NextRequest } from 'next/server';

// Validation-path test: exercises the 400 branches that return before
// touching Upstash or Supabase. Happy-path (200) and 429 paths require
// integration wiring and are covered by post-deploy manual verification
// plus the Tier C limiter unit test in @llmwiki/lib-ratelimit.
//
// Mock Upstash + Supabase at the module boundary so that if validation
// accidentally falls through, these tests fail loudly rather than
// silently hitting a real Redis / Supabase at test time.
vi.mock('@llmwiki/lib-ratelimit', () => ({
  makeMagicLinkLimiter: () => ({
    reserve: () => {
      throw new Error('[test] rate-limiter called before validation');
    },
  }),
  RateLimitExceededError: class extends Error {},
  RatelimitUnavailableError: class extends Error {},
}));
vi.mock('../../lib/supabase', () => ({
  supabaseForRequest: () => {
    throw new Error('[test] supabase called before validation');
  },
}));

function req(body: string | undefined, xff: string | null = '203.0.113.9'): NextRequest {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (xff) headers['x-forwarded-for'] = xff;
  return new NextRequest(new URL('https://example.test/api/auth/magic-link'), {
    method: 'POST',
    headers,
    body,
  });
}

describe('POST /api/auth/magic-link — validation paths', () => {
  it('rejects invalid JSON body with 400', async () => {
    const { POST } = await import('../../app/api/auth/magic-link/route');
    const res = await POST(req('{not json'));
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: expect.stringMatching(/JSON/i) });
  });

  it('rejects missing email field with 400', async () => {
    const { POST } = await import('../../app/api/auth/magic-link/route');
    const res = await POST(req(JSON.stringify({})));
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: expect.stringMatching(/email/i) });
  });

  it('rejects non-string email with 400', async () => {
    const { POST } = await import('../../app/api/auth/magic-link/route');
    const res = await POST(req(JSON.stringify({ email: 12345 })));
    expect(res.status).toBe(400);
  });

  it('rejects malformed email shape with 400', async () => {
    const { POST } = await import('../../app/api/auth/magic-link/route');
    const res = await POST(req(JSON.stringify({ email: 'not-an-email' })));
    expect(res.status).toBe(400);
  });

  it('rejects whitespace-only email with 400', async () => {
    const { POST } = await import('../../app/api/auth/magic-link/route');
    const res = await POST(req(JSON.stringify({ email: '   ' })));
    expect(res.status).toBe(400);
  });

  it('rejects email exceeding 254 chars with 400', async () => {
    const longLocal = 'a'.repeat(250);
    const { POST } = await import('../../app/api/auth/magic-link/route');
    const res = await POST(req(JSON.stringify({ email: `${longLocal}@x.co` })));
    expect(res.status).toBe(400);
  });

  it('rejects missing X-Forwarded-For header with 400 (no shared bucket)', async () => {
    // Email is valid shape; IP check must fire before rate limit.
    const { POST } = await import('../../app/api/auth/magic-link/route');
    const res = await POST(req(JSON.stringify({ email: 'ok@example.com' }), null));
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      error: expect.stringMatching(/client ip/i),
    });
  });

  it('fail-closes to 503 if APP_BASE_URL is unset (no Host header fallback)', async () => {
    // Valid email + IP so we reach the baseUrl guard before the mocked
    // limiter (which would throw from the test harness).
    vi.stubEnv('APP_BASE_URL', '');
    try {
      const { POST } = await import('../../app/api/auth/magic-link/route');
      const res = await POST(req(JSON.stringify({ email: 'ok@example.com' })));
      expect(res.status).toBe(503);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('normalizeEmailForRateLimit', () => {
  it('strips +alias from the local part (Gmail-style bypass)', async () => {
    const { normalizeEmailForRateLimit } = await import(
      '../../app/api/auth/magic-link/route'
    );
    expect(normalizeEmailForRateLimit('user+test@example.com')).toBe('user@example.com');
    expect(normalizeEmailForRateLimit('user+anything+else@example.com')).toBe(
      'user@example.com',
    );
  });

  it('leaves emails without + alias unchanged', async () => {
    const { normalizeEmailForRateLimit } = await import(
      '../../app/api/auth/magic-link/route'
    );
    expect(normalizeEmailForRateLimit('plain@example.com')).toBe('plain@example.com');
  });

  it('preserves + that appears in the domain (not a local-part alias)', async () => {
    // An email like `user@domain+tag.com` is not a real Gmail-style alias
    // pattern; we only strip `+` from the local part. This test locks in
    // that scoping.
    const { normalizeEmailForRateLimit } = await import(
      '../../app/api/auth/magic-link/route'
    );
    expect(normalizeEmailForRateLimit('user@sub+tag.example')).toBe(
      'user@sub+tag.example',
    );
  });
});
