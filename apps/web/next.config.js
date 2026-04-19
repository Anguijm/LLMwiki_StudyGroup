// CSP is set per-request in apps/web/middleware.ts so each response carries a
// unique nonce that Next.js stamps on its inline hydration scripts. The other
// security headers below don't need per-request values and stay here.
//
// rehype-sanitize is the primary XSS backstop on rendered Markdown; the CSP
// (in middleware) is defense-in-depth.

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
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
        ],
      },
    ];
  },
};

module.exports = nextConfig;
