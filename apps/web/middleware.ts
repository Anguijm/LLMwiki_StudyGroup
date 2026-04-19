import { NextResponse, type NextRequest } from 'next/server';

// Per-request CSP nonce. Next.js 15 App Router reads the `x-nonce` request
// header and auto-stamps the value on every inline <script> tag it emits for
// hydration. Pairing the nonce with 'strict-dynamic' lets the nonced inline
// scripts transitively load the /_next/static/chunks/*.js bundles without
// each chunk needing its own nonce (CSP Level 3).
//
// The static CSP this replaces (in next.config.js) shipped `script-src 'self'`
// with no nonce/hash/unsafe-inline — which blocked Next.js's inline Flight
// payload scripts, leaving the client with an empty `self.__next_f` and a
// hydration failure that tore down the rendered DOM on every page.

const STATIC_CSP_FALLBACK =
  "default-src 'self'; " +
  "script-src 'self'; " +
  "style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data: blob:; " +
  "font-src 'self' data:; " +
  "connect-src 'self'; " +
  "frame-ancestors 'none'; " +
  "base-uri 'self'; " +
  "form-action 'self'";

function buildCsp(nonce: string): string {
  const supabaseUrlRaw =
    process.env.NEXT_PUBLIC_SUPABASE_URL ?? 'https://placeholder.supabase.co';
  const supabaseUrl = supabaseUrlRaw.replace(/\/$/, '');
  const wsHost = new URL(supabaseUrl).host;
  const devEval = process.env.NODE_ENV === 'production' ? '' : " 'unsafe-eval'";

  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${devEval}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    `connect-src 'self' ${supabaseUrl} wss://${wsHost} https://api.inngest.com https://*.vercel.app`,
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join('; ');
}

function generateNonce(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function middleware(req: NextRequest): NextResponse {
  try {
    const nonce = generateNonce();
    const csp = buildCsp(nonce);

    const requestHeaders = new Headers(req.headers);
    requestHeaders.set('x-nonce', nonce);
    requestHeaders.set('content-security-policy', csp);

    const response = NextResponse.next({ request: { headers: requestHeaders } });
    response.headers.set('content-security-policy', csp);
    response.headers.set('cache-control', 'private, no-store, max-age=0');
    return response;
  } catch (err) {
    // Fail closed: restrictive static CSP (same posture as the pre-middleware
    // version). User sees a blank page but no XSS surface opens up, and the
    // error is observable in server logs rather than an unhandled edge-runtime
    // exception.
    console.error('[middleware] nonce generation failed:', err);
    const response = NextResponse.next();
    response.headers.set('content-security-policy', STATIC_CSP_FALLBACK);
    response.headers.set('cache-control', 'private, no-store, max-age=0');
    return response;
  }
}

export const config = {
  // Exclude: immutable static chunks, image optimizer, favicon, Inngest
  // webhook (signature-sensitive body; middleware must not mutate it), and
  // Supabase's /auth/callback (pure redirect handler, no HTML, no nonce
  // needed — confirmed at app/auth/callback/route.ts).
  matcher: ['/((?!_next/static|_next/image|favicon.ico|api/inngest|auth/callback).*)'],
};
