// CI guardrail: every Next.js route/page/layout module must be importable
// with a scrubbed env. Next.js's "Collecting page data" build phase evaluates
// each module's top-level code; any import-time throw kills the Vercel build.
//
// The original v0 deploy failure hit this exactly: /auth/callback imported
// @llmwiki/db/server, which read NEXT_PUBLIC_SUPABASE_URL at module top
// level and threw. This test catches that class of bug in unit-test CI,
// before it ever reaches Vercel.
//
// Two conditions per module: all env vars unset, and all env vars empty
// string. Empty-string is the common "pasted-but-blank" Vercel UI mistake.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const APP_DIR = path.resolve(__dirname, '..', '..', 'app');

// Every env var the app reads, enumerated from .env.example. The test
// scrubs or empties all of them before each module import.
const APP_ENV_VARS = [
  'NEXT_PUBLIC_SUPABASE_URL',
  'NEXT_PUBLIC_SUPABASE_ANON_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
  'SUPABASE_PROJECT_REF',
  'ANTHROPIC_API_KEY',
  'VOYAGE_API_KEY',
  'PDF_PARSER',
  'REDUCTO_API_KEY',
  'LLAMAPARSE_API_KEY',
  'UPSTASH_REDIS_REST_URL',
  'UPSTASH_REDIS_REST_TOKEN',
  'INNGEST_EVENT_KEY',
  'INNGEST_SIGNING_KEY',
  'APP_BASE_URL',
] as const;

const ROUTE_BASENAMES = new Set(['route.ts', 'route.tsx', 'page.tsx', 'layout.tsx']);

function collectRouteFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      collectRouteFiles(full, out);
    } else if (ROUTE_BASENAMES.has(entry)) {
      out.push(full);
    }
  }
  return out;
}

function scrubAll(value: string | undefined) {
  for (const key of APP_ENV_VARS) {
    vi.stubEnv(key, value as string);
  }
}

const routeFiles: string[] = collectRouteFiles(APP_DIR).sort();

// Sanity check — if enumeration drops to zero, the test silently passes.
// The v0 scaffold has at minimum: /app/layout.tsx + /app/page.tsx +
// /auth/callback/route.ts + /api/ingest/route.ts + /api/inngest/route.ts.
const MIN_EXPECTED = 5;

describe('Next.js route/page modules load with missing env', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it(`discovered at least ${MIN_EXPECTED} route/page/layout files`, () => {
    expect(routeFiles.length).toBeGreaterThanOrEqual(MIN_EXPECTED);
  });

  describe.each(routeFiles)('%s', (file) => {
    // Sanity: the file actually exists on disk. Catches enumeration misconfigs.
    it('file exists on disk', () => {
      expect(readFileSync(file, 'utf8').length).toBeGreaterThan(0);
    });

    it('imports without throwing when env vars are unset', async () => {
      scrubAll(undefined);
      await expect(import(/* @vite-ignore */ file)).resolves.toBeDefined();
    });

    it('imports without throwing when env vars are empty strings', async () => {
      scrubAll('');
      await expect(import(/* @vite-ignore */ file)).resolves.toBeDefined();
    });
  });
});
