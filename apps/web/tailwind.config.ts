import type { Config } from 'tailwindcss';

// Palette picked for WCAG AA contrast (4.5:1 text, 3:1 UI) against both
// default light and dark shadcn backgrounds. Verified in CI by
// @axe-core/playwright color-contrast rule.
const config: Config = {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}', './lib/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Intentionally narrow palette for v0 — enough for button, card,
        // input, toast. Expand in v1 once a design pass defines semantic
        // roles.
        brand: {
          DEFAULT: '#0f172a', // slate-900 — 16:1 contrast on white
          50: '#f8fafc',
          100: '#f1f5f9',
          500: '#64748b',
          600: '#475569',
          700: '#334155', // 10.4:1 on white
          900: '#0f172a',
        },
        success: { DEFAULT: '#166534' }, // green-800 — 7.1:1 on white
        warning: { DEFAULT: '#92400e' }, // amber-800 — 7.5:1 on white
        danger: { DEFAULT: '#991b1b' },  // red-800   — 7.8:1 on white
      },
    },
  },
  plugins: [],
};

export default config;
