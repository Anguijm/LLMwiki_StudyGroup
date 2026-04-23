'use client';

import { Component, type ReactNode } from 'react';

interface Props {
  fallback: ReactNode;
  children: ReactNode;
  // PII-safe label so support can correlate without inspecting state.
  // Required to avoid an anonymous "[boundary]" log line.
  label: string;
}

interface State {
  hasError: boolean;
}

export class ErrorBoundary extends Component<Props, State> {
  override state: State = { hasError: false };

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  override componentDidCatch(error: unknown): void {
    // PII-safe log: only the error class name + the boundary label.
    // We deliberately do NOT log error.message or error.stack — a
    // render-time bug inside <ReviewDeck> could plausibly include
    // card content in either field, and those columns are PII per
    // COMMENT ON COLUMN srs_cards.question/answer.
    const errorName = error instanceof Error ? error.name : typeof error;
    console.error('[error-boundary]', { label: this.props.label, errorName });
  }

  override render(): ReactNode {
    if (this.state.hasError) return this.props.fallback;
    return this.props.children;
  }
}
