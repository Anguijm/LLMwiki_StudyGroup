/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  experimental: {
    // Accept reasonably-sized PDF uploads; the API route additionally
    // enforces a hard 25 MiB cap via Content-Length + runtime check.
    serverActions: { bodySizeLimit: '25mb' },
  },
  transpilePackages: ['@llmwiki/db', '@llmwiki/lib-ai', '@llmwiki/lib-ratelimit', '@llmwiki/lib-metrics', '@llmwiki/prompts'],
};

module.exports = nextConfig;
