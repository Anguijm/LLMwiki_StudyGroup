// POST /api/auth/magic-link — rate-limited server-side wrapper around
// Supabase Auth's `signInWithOtp`. The client form at /auth calls this
// route instead of invoking Supabase directly; centralizing the call
// server-side gives us per-IP and per-email rate-limiting to prevent
// email-flooding abuse of our Supabase Auth email quota.
//
// Security posture (council r2 PR #17 non-negotiable):
//   - Per-IP limit: 5 requests / hour (first X-Forwarded-For entry).
//   - Per-email limit: 3 requests / hour (normalized lower-case).
//   - Fail-closed on Upstash outage (503).
//   - Generic error messages only — never leak Supabase internals.
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

function clientIp(req: NextRequest): string {
  // Vercel puts the real client IP as the leftmost entry of X-Forwarded-For.
  const xff = req.headers.get('x-forwarded-for');
  if (xff) {
    const first = xff.split(',')[0]?.trim();
    if (first) return first;
  }
  const xri = req.headers.get('x-real-ip');
  if (xri) return xri.trim();
  return 'unknown';
}

function baseUrl(req: NextRequest): string {
  const envBase = process.env.APP_BASE_URL;
  if (envBase && envBase.trim().length > 0) return envBase.replace(/\/$/, '');
  return new URL(req.url).origin;
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
  const limiter = makeMagicLinkLimiter();
  try {
    await limiter.reserve(ip, email);
  } catch (err) {
    if (err instanceof RateLimitExceededError) {
      return NextResponse.json(
        { error: 'Too many requests. Please try again later.' },
        { status: 429 },
      );
    }
    if (err instanceof RatelimitUnavailableError) {
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
    options: { emailRedirectTo: `${baseUrl(req)}/auth/callback` },
  });
  if (error) {
    // Do not leak Supabase's error copy verbatim; they can be verbose and
    // user-unfriendly. Keep the generic surface.
    return NextResponse.json(
      { error: 'Failed to send magic link. Please try again.' },
      { status: 502 },
    );
  }

  return NextResponse.json({ ok: true }, { status: 200 });
}
