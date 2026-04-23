import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ErrorBoundary } from './ErrorBoundary';

// Vitest env is `node` (apps/web/vitest.config.ts) so we don't have
// jsdom or @testing-library/react available. We test the class
// component's lifecycle methods directly — sufficient to verify the
// behavior without rendering, and avoids a new dev-dep just for one
// boundary class.

describe('ErrorBoundary', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    consoleSpy.mockRestore();
  });

  it('getDerivedStateFromError flips hasError to true', () => {
    expect(ErrorBoundary.getDerivedStateFromError()).toEqual({ hasError: true });
  });

  it('renders children when no error', () => {
    const fallback = 'fallback-text';
    const children = 'child-text';
    const inst = new ErrorBoundary({ fallback, children, label: 'test' });
    expect(inst.render()).toBe(children);
  });

  it('renders fallback once hasError is set', () => {
    const fallback = 'fallback-text';
    const children = 'child-text';
    const inst = new ErrorBoundary({ fallback, children, label: 'test' });
    inst.state = { hasError: true };
    expect(inst.render()).toBe(fallback);
  });

  it('componentDidCatch logs only label + errorName (PII-safe)', () => {
    const inst = new ErrorBoundary({ fallback: 'f', children: 'c', label: 'review-deck' });
    const err = new TypeError('Cannot read property foo of undefined; CARDCONTENT_HERE');
    inst.componentDidCatch(err);

    expect(consoleSpy).toHaveBeenCalledTimes(1);
    expect(consoleSpy).toHaveBeenCalledWith('[error-boundary]', {
      label: 'review-deck',
      errorName: 'TypeError',
    });

    // Defensive: the spied call args must NOT contain any portion of the
    // error message — that's the PII-safe contract.
    const args = consoleSpy.mock.calls[0];
    const serialized = JSON.stringify(args);
    expect(serialized).not.toContain('CARDCONTENT_HERE');
    expect(serialized).not.toContain('Cannot read property');
  });

  it('componentDidCatch handles non-Error throws', () => {
    const inst = new ErrorBoundary({ fallback: 'f', children: 'c', label: 'x' });
    inst.componentDidCatch('a string was thrown');

    expect(consoleSpy).toHaveBeenCalledWith('[error-boundary]', {
      label: 'x',
      errorName: 'string',
    });
  });
});
