import path from 'node:path';
import { defineConfig } from 'vitest/config';

// `server-only` throws on import outside a Next.js server context. Vitest
// runs outside that context, so alias to an empty no-op module for tests.
export default defineConfig({
  test: {
    environment: 'node',
    include: [
      '*.test.ts',
      'lib/**/*.test.ts',
      'components/**/*.test.ts?(x)',
      'tests/unit/**/*.test.ts',
      // Discovered during PR #51 (hot-fix Tier E): app/**/*.test.ts was
      // never matched by the prior pattern set, so the 16 actions.test.ts
      // tests shipped in PR #48 were silently skipped. The "consistently
      // passing" rule from CLAUDE.md was never verifiable for them. This
      // pattern picks up co-located server-action test files.
      'app/**/*.test.ts?(x)',
    ],
  },
  resolve: {
    alias: {
      'server-only': path.resolve(__dirname, 'tests/__mocks__/server-only.ts'),
    },
  },
  // tsconfig has `"jsx": "preserve"` for Next's compiler. Vitest uses
  // esbuild to transform .tsx test fixtures + imported components; tell
  // esbuild to emit the automatic JSX runtime so React doesn't need to
  // be in lexical scope at every JSX site (page.tsx, ReviewDeck.tsx).
  esbuild: {
    jsx: 'automatic',
  },
});
