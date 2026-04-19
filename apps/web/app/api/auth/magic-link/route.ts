// POST /api/auth/magic-link — rate-limited server-side wrapper around
// Supabase Auth's `signInWithOtp`. The client form at /auth calls this
// route instead of invoking Supabase directly; centralizing the call
// server-side gives us per-IP and per-email rate-limiting to prevent
// email-flooding abuse of our Supabase Auth email quota.
//
// Security posture (council r2 + r3 PR #17 non-negotiables):
//   - Per-IP limit: 5 requests / hour (first X-Forwarded-For entry;
//     request is rejected with 400 if no X-Forwarded-For header is
//     present, to avoid lumping IP-less traffic into a shared bucket
//     that can be self-DoS'd).
//   - Per-email limit: 3 requests / hour. Normalized: lowercased + any
//     `+alias` suffix stripped from the local part so the common Gmail
//     aliasing pattern (`user+a@gmail.com`, `user+b@gmail.com`) routes
//     to the same bucket.
//   - Fail-closed on Upstash outage (503).
//   - emailRedirectTo is built from APP_BASE_URL, NEVER from the request
//     Host header — otherwise an attacker could spoof Host and redirect
//     magic-link auth tokens to an attacker-controlled domain.
//   - Generic error messages to the client; upstream error details are
//     logged server-side (console.error) but never returned.
//
// The anon key is used server-side (via supabaseForRequest) so the
// service-role key never touches this path.

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { supabaseForRequest } from '../../../../lib/supabase';
import {
  makeMagicLinkLimiter,
  RateLimitExceededError,
  RatelimitUnavailableError,
} from '@llmwiki/lib-ratelimit';

export const runtime = 'nodejs';
export const maxDuration = 10;

// Pragmatic email shape check — not RFC-strict. Supabase does its own
// validation server-side; this exists only to reject obvious garbage
// before consuming a rate-limit slot.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_EMAIL_LEN = 254;

/**
 * Strip `+alias` suffix from the local part of an email for rate-limit
 * bucketing. `user+anything@host` → `user@host`. Idempotent on emails
 * without `+`. Pure function; exported for unit testing.
 */
export function normalizeEmailForRateLimit(email: string): string {
  const at = email.lastIndexOf('@');
  if (at < 0) return email;
  const local = email.slice(0, at);
  const domain = email.slice(at);
  const plus = local.indexOf('+');
  if (plus < 0) return email;
  return `${local.slice(0, plus)}${domain}`;
}

/**
 * Extract the client IP from the Vercel `x-forwarded-for` header.
 *
 * Vercel's edge sets the real client IP as the leftmost entry. We trust
 * this header specifically because of Vercel's infrastructure contract;
 * in a different deployment target this would need to change.
 *
 * Returns `null` if no IP can be determined — the caller rejects with
 * 400 rather than bucketing all IP-less traffic under a shared
 * `"unknown"` key (which would be a self-inflicted DoS vector).
 */
function clientIp(req: NextRequest): string | null {
  const xff = req.headers.get('x-forwarded-for');
  if (xff) {
    const first = xff.split(',')[0]?.trim();
    if (first && first.length > 0) return first;
  }
  const xri = req.headers.get('x-real-ip');
  if (xri && xri.trim().length > 0) return xri.trim();
  return null;
}

/**
 * Base URL for building the magic-link `emailRedirectTo`. MUST come from
 * server env; trusting the request Host header would be an open-redirect
 * vulnerability (attacker sets Host: evil.com, redirect URL points at
 * evil.com, Supabase delivers a magic link with auth token to attacker's
 * domain).
 */
function baseUrl(): string {
  const envBase = process.env.APP_BASE_URL;
  if (!envBase || envBase.trim().length === 0) {
    throw new Error('APP_BASE_URL missing or empty');
  }
  return envBase.replace(/\/$/, '');
}

export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const rawEmail =
    typeof body === 'object' && body !== null && 'email' in body &&
    typeof (body as { email?: unknown }).email === 'string'
      ? (body as { email: string }).email
      : '';
  const email = rawEmail.trim().toLocaleLowerCase('en-US');
  if (!email || email.length > MAX_EMAIL_LEN || !EMAIL_RE.test(email)) {
    return NextResponse.json({ error: 'Invalid email address' }, { status: 400 });
  }

  const ip = clientIp(req);
  if (!ip) {
    return NextResponse.json(
      { error: 'Missing client IP. Request rejected.' },
      { status: 400 },
    );
  }

  // Build APP_BASE_URL once up-front so a misconfigured env fails before
  // we spend a rate-limit slot or a Supabase call.
  let redirectBase: string;
  try {
    redirectBase = baseUrl();
  } catch (err) {
    console.error('[magic-link] APP_BASE_URL misconfigured:', err);
    return NextResponse.json(
      { error: 'Service temporarily unavailable.' },
      { status: 503 },
    );
  }

  const limiter = makeMagicLinkLimiter();
  try {
    await limiter.reserve(ip, normalizeEmailForRateLimit(email));
  } catch (err) {
    if (err instanceof RateLimitExceededError) {
      return NextResponse.json(
        { error: 'Too many requests. Please try again later.' },
        { status: 429 },
      );
    }
    if (err instanceof RatelimitUnavailableError) {
      console.error('[magic-link] upstash unavailable:', err);
      return NextResponse.json(
        { error: 'Service temporarily unavailable.' },
        { status: 503 },
      );
    }
    throw err;
  }

  // Cost: 1 Supabase Auth email per accepted request. Rate-limit above
  // caps this at 5/IP/hr × IPs + 3/email/hr — email quota is the primary
  // concern, controlled by the per-email limit.
  const supabase = await supabaseForRequest();
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: `${redirectBase}/auth/callback` },
  });
  if (error) {
    // Log the original error context server-side for debugging Supabase
    // credential / connectivity issues. The client sees generic copy
    // only — never leak Supabase's error surface.
    console.error('[magic-link] supabase.signInWithOtp failed:', {
      name: error.name,
      message: error.message,
      status: error.status,
    });
    return NextResponse.json(
      { error: 'Failed to send magic link. Please try again.' },
      { status: 502 },
    );
  }

  return NextResponse.json({ ok: true }, { status: 200 });
}
