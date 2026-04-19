// GET /auth/callback — Supabase PKCE auth code-exchange landing URL.
//
// The magic-link email points the user at /auth/callback?code=...; this
// route exchanges the short-lived code for a session cookie (written via
// the @supabase/ssr setAll adapter in apps/web/lib/supabase.ts) and
// redirects to the dashboard.
//
// Security posture (plan PR #22, council rounds r1 / r2 / r3):
//
//   - Input validation runs BEFORE any Supabase call. Missing / empty /
//     whitespace / too-short / too-long / non-URL-safe `code` values
//     redirect to /auth?error=invalid_request immediately. Defense in
//     depth: Supabase also validates, but a malformed code should never
//     touch the network.
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
 * Map a Supabase auth error to one of our user-facing kinds. Supabase
 * doesn't expose stable error codes for PKCE exchange failures, so we
 * match on message substrings with explicit fall-through to
 * `server_error`. If Supabase changes its error copy in a future
 * release, the result is more "server_error" toasts rather than a
 * crash — acceptable graceful degradation.
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

export async function GET(req: NextRequest): Promise<NextResponse> {
  const code = new URL(req.url).searchParams.get('code');

  const validation = validateCode(code);
  if (validation !== null) {
    return redirectToAuthError(req, validation);
  }
  // After validation, `code` is guaranteed non-null and trimmed shape.
  const trimmedCode = (code as string).trim();

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
