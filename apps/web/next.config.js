// Content-Security-Policy (council batch-6-8 security nice-to-have) as a
// defense-in-depth layer. rehype-sanitize is the primary XSS backstop on
// rendered Markdown; CSP catches anything the sanitizer misses.
//
// v0 is conservative: script-src 'self' (no inline scripts); connect-src
// allows Supabase's REST + Realtime domains + Inngest. If Vercel Analytics
// or another third party needs inline scripts in v1, it lands in that PR's
// CSP diff with council review.
const SUPABASE_HOST =
  (process.env.NEXT_PUBLIC_SUPABASE_URL ?? 'https://placeholder.supabase.co').replace(/\/$/, '');

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'", // Tailwind generates inline styles at dev-time; swap in v1 via nonce.
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  `connect-src 'self' ${SUPABASE_HOST} wss://${new URL(SUPABASE_HOST).host} https://api.inngest.com https://*.vercel.app`,
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ');

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  experimental: {
    serverActions: { bodySizeLimit: '25mb' },
  },
  transpilePackages: [
    '@llmwiki/db',
    '@llmwiki/lib-ai',
    '@llmwiki/lib-ratelimit',
    '@llmwiki/lib-metrics',
    '@llmwiki/lib-utils',
    '@llmwiki/prompts',
  ],
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'Content-Security-Policy', value: CSP },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
        ],
      },
    ];
  },
};

module.exports = nextConfig;
