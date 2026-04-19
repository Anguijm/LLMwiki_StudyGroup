import type { Metadata } from 'next';
import './globals.css';
import { t } from '../lib/i18n';

export const metadata: Metadata = {
  title: t('app.name'),
  description: 'Cohort study wiki',
};

// SECURITY: required for the per-request CSP nonce in apps/web/middleware.ts
// to land on every page. Static prerendering bakes HTML at build time, before
// middleware runs, so nonces can't be stamped on script tags. Under our
// `script-src 'nonce-...' 'strict-dynamic'` CSP, scripts without the matching
// nonce are blocked, which breaks React hydration and silently leaves
// interactive pages dead (e.g. /auth's magic-link button does nothing).
// Children that don't need hydration can opt back in to static generation
// via their own `export const dynamic = 'force-static'` (see /diag).
// Do not remove without first removing the CSP nonce middleware.
export const dynamic = 'force-dynamic';

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        {/* Skip link for keyboard users — lands first in tab order. */}
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:p-2 focus:bg-brand-900 focus:text-white"
        >
          Skip to main content
        </a>
        <header className="border-b border-brand-100 bg-white">
          <div className="max-w-3xl mx-auto px-4 py-4">
            <h1 className="text-xl font-semibold text-brand-900">{t('app.name')}</h1>
          </div>
        </header>
        <main id="main" className="max-w-3xl mx-auto px-4 py-8">
          {children}
        </main>
      </body>
    </html>
  );
}
