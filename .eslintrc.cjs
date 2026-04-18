/**
 * Root ESLint config. Each package extends this.
 * Flat config (eslint.config.js) migration deferred to v1 — keep classic for now.
 */
module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
  },
  plugins: ['@typescript-eslint'],
  extends: ['eslint:recommended', 'plugin:@typescript-eslint/recommended', 'prettier'],
  rules: {
    // Ban `any` without an explicit // eslint-disable-next-line one-line justification.
    '@typescript-eslint/no-explicit-any': 'error',
    '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    'no-console': ['warn', { allow: ['warn', 'error'] }],
  },
  ignorePatterns: ['node_modules', 'dist', '.next', 'coverage', '*.config.cjs', '*.config.js'],
  overrides: [
    {
      // server-only boundary: prevent accidental client import of server modules.
      files: ['apps/web/**/*.client.{ts,tsx}', 'apps/web/**/components/**/*.{ts,tsx}'],
      rules: {
        'no-restricted-imports': [
          'error',
          {
            paths: [
              {
                name: '@llmwiki/db/server',
                message:
                  'Do not import @llmwiki/db/server from client code. Use @llmwiki/db/browser or move the caller to a server component / action / route handler.',
              },
            ],
          },
        ],
      },
    },
  ],
};
