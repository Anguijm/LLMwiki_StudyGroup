import type { Metadata } from 'next';
import './globals.css';
import { t } from '../lib/i18n';

export const metadata: Metadata = {
  title: t('app.name'),
  description: 'Cohort study wiki',
};

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
