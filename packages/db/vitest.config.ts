import path from 'node:path';
import { defineConfig } from 'vitest/config';

// `server-only` throws on import outside a Next.js server context. Vitest
// runs outside that context, so alias it to an empty no-op module for tests.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
  resolve: {
    alias: {
      'server-only': path.resolve(__dirname, 'src/__mocks__/server-only.ts'),
    },
  },
});
