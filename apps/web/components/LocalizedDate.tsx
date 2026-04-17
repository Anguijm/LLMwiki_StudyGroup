'use client';

// r5 bug fix 4: server serializes dates as ISO 8601 strings; this client
// component formats them with Intl.DateTimeFormat using the browser locale.
// Server-side Intl would use the server locale and hydration-mismatch.
import { useEffect, useState } from 'react';

interface LocalizedDateProps {
  iso: string;
  mode?: 'absolute' | 'relative';
}

function formatAbsolute(d: Date, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(d);
}

function formatRelative(d: Date, now: Date, locale: string): string {
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  const deltaSec = Math.round((d.getTime() - now.getTime()) / 1000);
  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ['year', 60 * 60 * 24 * 365],
    ['month', 60 * 60 * 24 * 30],
    ['day', 60 * 60 * 24],
    ['hour', 60 * 60],
    ['minute', 60],
  ];
  for (const [unit, seconds] of units) {
    if (Math.abs(deltaSec) >= seconds) {
      return rtf.format(Math.round(deltaSec / seconds), unit);
    }
  }
  return rtf.format(deltaSec, 'second');
}

export function LocalizedDate({ iso, mode = 'absolute' }: LocalizedDateProps) {
  const [text, setText] = useState<string>(() => {
    // On first render (SSR + first client render), show the ISO string.
    // After hydration, useEffect swaps in the locale-formatted text. No
    // mismatch: server and first-render client both emit the same ISO.
    return iso;
  });

  useEffect(() => {
    const locale = typeof navigator !== 'undefined' ? navigator.language : 'en';
    const d = new Date(iso);
    const compute = () =>
      setText(mode === 'relative' ? formatRelative(d, new Date(), locale) : formatAbsolute(d, locale));
    compute();
    if (mode === 'relative') {
      const t = setInterval(compute, 15_000);
      return () => clearInterval(t);
    }
  }, [iso, mode]);

  const absolute =
    mode === 'relative'
      ? formatAbsolute(new Date(iso), typeof navigator !== 'undefined' ? navigator.language : 'en')
      : undefined;

  return (
    <time dateTime={iso} title={absolute}>
      {text}
    </time>
  );
}
