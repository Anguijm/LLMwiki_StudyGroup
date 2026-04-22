// GET /auth/callback — Supabase PKCE auth code-exchange landing URL.
//
// The magic-link email points the user at /auth/callback?code=...; this
// route exchanges the short-lived code for a session cookie (written via
// the @supabase/ssr setAll adapter in apps/web/lib/supabase.ts) and
// redirects to the dashboard.
//
// === REQUIRED DASHBOARD CONFIGURATION (see README.md §B.6) ===
//
// This route REQUIRES the Supabase "Magic Link" AND "Confirm signup"
// email templates to use the default `{{ .ConfirmationURL }}` body link.
// That template renders to `https://<ref>.supabase.co/auth/v1/verify?...`,
// Supabase verifies the OTP server-side, generates a PKCE flow_state,
// and redirects to `/auth/callback?code=<real_pkce_code>`. The call to
// `exchangeCodeForSession(code)` below then looks up that flow_state and
// exchanges the code for a session.
//
// If either template is changed to `/auth/callback?code={{ .TokenHash }}`
// (the primitive for `verifyOtp`, NOT `exchangeCodeForSession`), Supabase
// returns `/token | 404: invalid flow state, no valid flow state found`,
// mapSupabaseError() falls through to `server_error`, and every sign-in
// fails with "Could not sign you in right now." This happened once
// (PR #22 shipped the wrong template; PR #27 corrected it). The README
// has the full template-vs-primitive binding; do not change the template
// without simultaneously switching the callback primitive.
//
// Security posture (plan PR #22, council rounds r1 / r2 / r3 / r4;
// PR #28 / issue #26 adds the cookie_failure branch):
//
//   - Per-IP rate limit (20 req / min, fail-open on Upstash outage).
//     /auth/callback is a public endpoint that fans out to Supabase
//     Auth; without a limiter an attacker can spam bad codes and
//     consume our server + Supabase's per-project rate budget (council
//     security r4 blocker: non-negotiable on public endpoints with
//     external API fan-out). Fail-open intentional: a Redis outage
//     must not 503 a legit magic-link click. The limiter emits a
//     monitorable `alert: true, tier: 'auth_callback_ip'` log on
//     fail-open (PR #28 / issue #26).
//
//   - Input validation runs BEFORE the Supabase call. Missing /
//     empty / whitespace / too-short / too-long / non-URL-safe `code`
//     values redirect to /auth?error=invalid_request immediately.
//
//   - Every failure branch maps to a known kind and 307s to
//     /auth?error=<kind>. The final catch-all guarantees this route
//     never returns a 500 for auth failures (council bugs r1 / r2 / r3).
//     The one exception is a rollback-itself-fails edge case where
//     `cookies().delete()` throws on the cookie_failure recovery path —
//     that escalates to 500 by design (council bugs r1 PR #28: silent
//     swallow of a failure-within-a-failure-handler hides the bug).
//
//   - The success redirect is HARDCODED to `/`. No caller-supplied
//     query parameter may influence the destination (open-redirect
//     guard, council bugs r2).
//
//   - On a partial session-cookie write (@supabase/ssr setAll halts
//     mid-stream), the route deletes any cookies that DID write before
//     the halt and 307s to /auth?error=cookie_failure. This takes
//     precedence over `server_error` when the setAll throw bubbles
//     through exchangeCodeForSession (PR #28 / issue #26).
//
//   - Logs NEVER contain the `code`, `access_token`, or `refresh_token`
//     values. Only the mapped error kind and (optionally) the thrown
//     error's class name are emitted. Spy-enforced in the test suite.

import { NextResponse, type NextRequest } from 'next/server';
import { cookies } from 'next/headers';
import { supabaseForRequest } from '../../../lib/supabase';
import {
  makeAuthCallbackLimiter,
  RateLimitExceededError,
} from '@llmwiki/lib-ratelimit';

export const runtime = 'nodejs';

type ErrorKind =
  | 'invalid_request'
  | 'token_expired'
  | 'token_used'
  | 'server_error'
  | 'cookie_failure';

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
 * doesn't expose stable error codes for PKCE exchange failures (in older
 * versions), so we match on message substrings with explicit fall-through
 * to `server_error`. If Supabase changes its error copy in a future
 * release, the result is more "server_error" toasts rather than a
 * crash — acceptable graceful degradation.
 *
 * PR #35 / issue #30 extends the vocabulary: the `err.code` field (when
 * Supabase populates it) is preferred over substring matching since it's
 * locale/version-stable. New message patterns cover the "Email link is
 * invalid or has expired" and "no valid flow state found" cases the
 * prior regex missed.
 */
function mapSupabaseError(
  err: { message?: string; status?: number; code?: string } | null,
): ErrorKind {
  if (!err) return 'server_error';
  if (typeof err.status === 'number' && err.status >= 500) return 'server_error';
  const msg = (err.message ?? '').toLowerCase();
  const code = (err.code ?? '').toLowerCase();
  // Code field takes priority when present — stable across Supabase
  // versions and unaffected by message-copy drift.
  if (/otp_used|used_otp|invalid_grant/.test(code)) return 'token_used';
  if (/otp_expired|flow_state_expired/.test(code)) return 'token_expired';
  // Token-used class by message.
  if (/\balready\b.*\bused\b|consumed|used_otp|invalid_grant/.test(msg)) {
    return 'token_used';
  }
  if (/email.*link.*invalid|no.*valid.*flow.*state/.test(msg)) {
    return 'token_used';
  }
  // Token-expired class by message.
  if (/\bexpired\b|otp_expired/.test(msg)) return 'token_expired';
  return 'server_error';
}

/**
 * Classify a Supabase redirect-error URL (e.g. /auth/callback?error=
 * access_denied&error_code=otp_expired&error_description=...) without
 * calling `exchangeCodeForSession`. Used when Supabase's /auth/v1/verify
 * rejects upstream and redirects here with the error shape in the query
 * string. Returns null if the URL has no `error` param (caller should
 * proceed to normal code validation + exchange).
 *
 * CRITICAL: the raw `error` param value is NEVER used as the output
 * ErrorKind. Classification is via allowlist-style matching on
 * `error_code` (preferred, stable) and `error_description` (fallback,
 * substring-based). Unknown values fall through to `server_error` —
 * never reflected back to the user's browser as a raw string.
 */
function mapRedirectError(params: URLSearchParams): ErrorKind | null {
  const err = params.get('error');
  if (!err) return null;
  const code = (params.get('error_code') ?? '').toLowerCase();
  const desc = (params.get('error_description') ?? '').toLowerCase();
  // Code field takes priority.
  if (/otp_expired|flow_state_expired|magic_link_expired/.test(code)) {
    return 'token_expired';
  }
  if (/otp_used|used_otp|invalid_grant/.test(code)) return 'token_used';
  // Description substring fallback.
  if (/\balready\b.*\bused\b|consumed|used_otp|invalid_grant/.test(desc)) {
    return 'token_used';
  }
  if (/email.*link.*invalid/.test(desc)) return 'token_used';
  if (/\bexpired\b|link.*expired/.test(desc)) return 'token_expired';
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

/**
 * Delete partial session cookies when the setAll adapter halted the
 * transaction. Throws are allowed to propagate — a failure here is a
 * genuine bug (a frozen cookie store, a Next.js guard change) and
 * swallowing would hide it. The route's outer `try` catches the throw
 * and returns 500 explicitly so the failure mode is obvious in logs
 * and CI rather than presenting as a weird inconsistent redirect.
 * Council bugs r1 on PR #28.
 */
async function rollbackPartialCookies(names: readonly string[]): Promise<void> {
  if (names.length === 0) return;
  const store = await cookies();
  for (const name of names) {
    store.delete(name);
  }
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
    // let it propagate.
    throw err;
  }

  // 2. Supabase redirect-error classification (BEFORE code validation).
  //
  // If Supabase's /auth/v1/verify rejected upstream, it redirects here
  // with ?error=access_denied&error_code=...&error_description=... and
  // usually no `code` param. Classifying from those params BEFORE
  // `validateCode` runs is required (issue #30; PR #35 council r1 sec
  // non-negotiable) — otherwise validateCode(null) would short-circuit
  // to `invalid_request` before the error-param classification ever
  // ran. If a URL has both `?error=...` AND `?code=...`, the error
  // path wins — Supabase has already rejected the code upstream.
  const searchParams = new URL(req.url).searchParams;
  const redirectErrorKind = mapRedirectError(searchParams);
  if (redirectErrorKind !== null) {
    console.error('[auth/callback] sign-in failed', { kind: redirectErrorKind });
    return redirectToAuthError(req, redirectErrorKind);
  }

  // 3. Input validation.
  const code = searchParams.get('code');
  const validation = validateCode(code);
  if (validation !== null) {
    return redirectToAuthError(req, validation);
  }
  const trimmedCode = (code as string).trim();

  // 3. Exchange the code, mapping every failure shape to a known kind.
  const supabase = await supabaseForRequest();
  let failureKind: ErrorKind | null = null;
  try {
    const { data, error } = await supabase.auth.exchangeCodeForSession(trimmedCode);
    if (error) {
      failureKind = mapSupabaseError(error);
    } else if (!data?.session) {
      // 200 OK with no session and no error object. In practice the
      // dominant cause is a stale PKCE code that resolved to no
      // flow_state row (exact B.2 smoke test path from PR #27 evidence).
      // Classify as token_used so the user gets actionable copy
      // ("Request a new one.") rather than misleading retry copy.
      //
      // Trade-off: a rare genuine null-session response from Supabase
      // (transient backend hiccup) is mis-labeled as token_used. The
      // recovery action is identical — request a new link — so the
      // mislabeling is user-harmless. If a dedicated `stale_link` kind
      // is ever needed, add it; not in this PR (issue #30 / PR #35).
      failureKind = 'token_used';
    }
  } catch (err) {
    // Final catch-all. If the throw came FROM the setAll adapter
    // (cookie_failure halt bubbled through exchangeCodeForSession),
    // the adapter's failure state will be populated; we detect that
    // in step 4 below and override this kind to cookie_failure.
    console.error('[auth/callback] unexpected exchange failure', {
      kind: 'server_error',
      errorName: err instanceof Error ? err.name : typeof err,
    });
    failureKind = 'server_error';
  }

  // 4. cookie_failure precedence. A setAll halt means the browser would
  // be left with a partial session even if the exchange "succeeded";
  // the cookie-write failure is the actionable cause and must take
  // precedence over any generic `server_error` we set in the catch
  // above. Check regardless of exchange outcome.
  const cookieFailure = supabase.getCookieWriteFailure();
  if (cookieFailure) {
    failureKind = 'cookie_failure';
    console.error('[auth/callback] sign-in failed', {
      kind: 'cookie_failure',
      errorName: cookieFailure.errorName,
    });
    try {
      await rollbackPartialCookies(supabase.getWrittenCookieNames());
    } catch (err) {
      // Failure-within-failure-handler. Escalate to 500 by design
      // rather than swallow. Log only the error class name — never the
      // cookie names themselves (low leakage risk but keeps the log
      // shape small for monitoring).
      console.error('[auth/callback] cookie rollback failed', {
        kind: 'server_error',
        errorName: err instanceof Error ? err.name : typeof err,
      });
      return new NextResponse('sign-in recovery failed', { status: 500 });
    }
    return redirectToAuthError(req, 'cookie_failure');
  }

  if (failureKind !== null) {
    console.error('[auth/callback] sign-in failed', { kind: failureKind });
    return redirectToAuthError(req, failureKind);
  }

  // SECURITY: destination is hardcoded. See file header comment.
  return NextResponse.redirect(new URL('/', req.url));
}
