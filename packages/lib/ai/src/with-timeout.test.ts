import { describe, it, expect, vi } from 'vitest';
import { withTimeout } from './with-timeout';
import { AiRequestTimeoutError } from './errors';

describe('withTimeout', () => {
  it('resolves if the inner promise finishes in time', async () => {
    const result = await withTimeout('anthropic', 100, async () => 42);
    expect(result).toBe(42);
  });

  it('rejects with AiRequestTimeoutError on a hung request', async () => {
    const hung = (signal: AbortSignal) =>
      new Promise<never>((_, reject) => {
        signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
    await expect(withTimeout('voyage', 50, hung)).rejects.toBeInstanceOf(AiRequestTimeoutError);
  });

  it('propagates non-timeout errors unchanged', async () => {
    const original = new Error('boom');
    await expect(
      withTimeout('anthropic', 100, async () => {
        throw original;
      }),
    ).rejects.toBe(original);
  });

  it('clears its timer so test processes exit cleanly', async () => {
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout');
    await withTimeout('voyage', 100, async () => 1);
    expect(clearSpy).toHaveBeenCalled();
    clearSpy.mockRestore();
  });
});
