// GET /auth/callback — Supabase PKCE auth code-exchange landing URL.
//
// The magic-link email points the user at /auth/callback?code=...; this
// route exchanges the short-lived code for a session cookie (written via
// the @supabase/ssr setAll adapter in apps/web/lib/supabase.ts) and
// redirects to the dashboard.
//
// Security posture (plan PR #22, council rounds r1 / r2 / r3 / r4):
//
//   - Per-IP rate limit (20 req / min, fail-open on Upstash outage).
//     /auth/callback is a public endpoint that fans out to Supabase
//     Auth; without a limiter an attacker can spam bad codes and
//     consume our server + Supabase's per-project rate budget (council
//     security r4 blocker: non-negotiable on public endpoints with
//     external API fan-out). Fail-open intentional: a Redis outage
//     must not 503 a legit magic-link click.
//
//   - Input validation runs BEFORE the Supabase call. Missing /
//     empty / whitespace / too-short / too-long / non-URL-safe `code`
//     values redirect to /auth?error=invalid_request immediately.
//     Defense in depth: Supabase also validates, but a malformed code
//     should never touch the network.
//
//   - Every failure branch — Supabase-shaped errors, a 200 OK with
//     `data.session: null`, unparseable JSON responses, and generic
//     thrown Errors — maps to a known error kind and 307s to
//     /auth?error=<kind>. The final catch-all guarantees this route
//     never returns a 500 (council bugs r1 / r2 / r3).
//
//   - The success redirect is HARDCODED to `/`. No caller-supplied
//     query parameter (`redirect_to`, `next`, etc.) may influence the
//     destination URL. Forwarding an attacker-controlled URL here
//     would be an open-redirect vector (council bugs r2). If a
//     post-sign-in destination is ever needed, store it server-side
//     (e.g., a cookie set at magic-link send time) — never in the
//     callback query string.
//
//   - Logs NEVER contain the `code`, `access_token`, or `refresh_token`
//     values. Only the mapped error kind and (optionally) the thrown
//     error's class name are emitted. The integration test suite at
//     apps/web/tests/unit/auth-callback-route.test.ts spies on
//     console.error and fails if any of those substrings appear.

import { NextResponse, type NextRequest } from 'next/server';
import { supabaseForRequest } from '../../../lib/supabase';
import {
  makeAuthCallbackLimiter,
  RateLimitExceededError,
} from '@llmwiki/lib-ratelimit';

export const runtime = 'nodejs';

type ErrorKind = 'invalid_request' | 'token_expired' | 'token_used' | 'server_error';

// URL-safe base64 alphabet. Supabase PKCE codes are opaque strings within
// this character set; anything else is an obvious probe / garbage and is
// rejected before consuming a round trip.
const VALID_CODE_RE = /^[A-Za-z0-9_-]+$/;
const MIN_CODE_LEN = 16;
const MAX_CODE_LEN = 2048;

function validateCode(raw: string | null): ErrorKind | null {
  if (raw === null) return 'invalid_request';
  const trimmed = raw.trim();
  if (trimmed.length === 0) return 'invalid_request';
  if (trimmed.length < MIN_CODE_LEN) return 'invalid_request';
  if (trimmed.length > MAX_CODE_LEN) return 'invalid_request';
  if (!VALID_CODE_RE.test(trimmed)) return 'invalid_request';
  return null;
}

/**
 * Extract a rate-limit bucket key from the request. Vercel guarantees
 * X-Forwarded-For on production traffic. If the header is absent (local
 * dev, odd proxy chains), fall back to a shared "unknown" bucket — the
 * shared bucket means worst-case all IP-less traffic shares a 20/min
 * ceiling, which is annoying but not a user-denial.
 */
function rateLimitBucket(req: NextRequest): string {
  const xff = req.headers.get('x-forwarded-for');
  const first = xff?.split(',')[0]?.trim();
  if (first && first.length > 0) return first;
  const xri = req.headers.get('x-real-ip')?.trim();
  if (xri && xri.length > 0) return xri;
  return 'no-xff';
}

/**
 * Map a Supabase auth error to one of our user-facing kinds. Supabase
 * doesn't expose stable error codes for PKCE exchange failures, so we
 * match on message substrings with explicit fall-through to
 * `server_error`. If Supabase changes its error copy in a future
 * release, the result is more "server_error" toasts rather than a
 * crash — acceptable graceful degradation (council security r4
 * nice-to-have: revisit if Supabase ever exposes stable codes).
 */
function mapSupabaseError(err: { message?: string; status?: number } | null): ErrorKind {
  if (!err) return 'server_error';
  if (typeof err.status === 'number' && err.status >= 500) return 'server_error';
  const msg = (err.message ?? '').toLowerCase();
  if (/\balready\b.*\bused\b|consumed|used_otp|invalid_grant/.test(msg)) {
    return 'token_used';
  }
  if (/expired|otp_expired/.test(msg)) return 'token_expired';
  return 'server_error';
}

function redirectToAuthError(req: NextRequest, kind: ErrorKind): NextResponse {
  const target = new URL('/auth', req.url);
  target.searchParams.set('error', kind);
  return NextResponse.redirect(target);
}

function tooManyRequests(resetsAt: Date): NextResponse {
  const retryAfterSec = Math.max(
    1,
    Math.ceil((resetsAt.getTime() - Date.now()) / 1000),
  );
  return new NextResponse('Too many requests. Please try again in a moment.', {
    status: 429,
    headers: {
      'retry-after': String(retryAfterSec),
      'content-type': 'text/plain; charset=utf-8',
    },
  });
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  // 1. Rate limit FIRST. Validation is cheap but unbounded requests to a
  // public endpoint still cost cycles, and a future refactor that moves
  // validation later should never drop the rate-limit gate.
  try {
    await makeAuthCallbackLimiter().reserve(rateLimitBucket(req));
  } catch (err) {
    if (err instanceof RateLimitExceededError) {
      return tooManyRequests(err.resetsAt);
    }
    // Limiter's reserve() only throws RateLimitExceededError (it
    // fail-opens on Upstash outage). Any other throw is unexpected —
    // let it propagate so the platform's error reporting picks it up;
    // the route's final catch-all below won't run here because this
    // block is outside the exchange try/catch by design (rate-limit
    // failures are infrastructure errors, not sign-in errors).
    throw err;
  }

  // 2. Input validation.
  const code = new URL(req.url).searchParams.get('code');
  const validation = validateCode(code);
  if (validation !== null) {
    return redirectToAuthError(req, validation);
  }
  const trimmedCode = (code as string).trim();

  // 3. Exchange the code, mapping every failure shape to a known kind.
  let failureKind: ErrorKind | null = null;
  try {
    const supabase = await supabaseForRequest();
    const { data, error } = await supabase.auth.exchangeCodeForSession(trimmedCode);
    if (error) {
      failureKind = mapSupabaseError(error);
    } else if (!data?.session) {
      // Unexpected: 200 OK with no session body. Treat as a server error
      // rather than let a downstream null deref leak through (council
      // bugs r1).
      failureKind = 'server_error';
    }
  } catch (err) {
    // Final catch-all. A JSON parse failure, TypeError, network drop,
    // or any non-Error throw lands here and is mapped to server_error.
    // The route MUST NOT return a 500 (council bugs r1 / r2 / r3).
    // We log only the error's class name — never the message (which
    // might echo the code), never the object (which might carry
    // access/refresh tokens from a partial Supabase response).
    console.error('[auth/callback] unexpected exchange failure', {
      kind: 'server_error',
      errorName: err instanceof Error ? err.name : typeof err,
    });
    failureKind = 'server_error';
  }

  if (failureKind !== null) {
    console.error('[auth/callback] sign-in failed', { kind: failureKind });
    return redirectToAuthError(req, failureKind);
  }

  // SECURITY: destination is hardcoded. See file header comment.
  return NextResponse.redirect(new URL('/', req.url));
}
