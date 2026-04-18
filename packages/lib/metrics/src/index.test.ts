import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { counter, histogram, withDuration } from './index';

describe('metrics', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => {
    warnSpy.mockRestore();
    errSpy.mockRestore();
  });

  it('counter emits a well-shaped JSON line', () => {
    counter('ingestion.jobs.created', { job_id: 'j1' });
    expect(warnSpy).toHaveBeenCalledOnce();
    const arg = warnSpy.mock.calls[0]?.[0];
    const parsed = JSON.parse(arg as string);
    expect(parsed).toMatchObject({
      level: 'info',
      kind: 'metric',
      metric: 'ingestion.jobs.created',
      value: 1,
      labels: { job_id: 'j1' },
    });
    expect(parsed.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('histogram emits with provided value', () => {
    histogram('latency_s', 1.5);
    const parsed = JSON.parse(warnSpy.mock.calls[0]?.[0] as string);
    expect(parsed.value).toBe(1.5);
  });

  it('withDuration captures ok status on success', async () => {
    const out = await withDuration('foo_seconds', { step: 'test' }, async () => 'x');
    expect(out).toBe('x');
    const parsed = JSON.parse(warnSpy.mock.calls[0]?.[0] as string);
    expect(parsed.labels).toMatchObject({ step: 'test', status: 'ok' });
    expect(parsed.value).toBeGreaterThanOrEqual(0);
  });

  it('withDuration captures error status and rethrows', async () => {
    await expect(
      withDuration('foo_seconds', { step: 't' }, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    const parsed = JSON.parse(warnSpy.mock.calls[0]?.[0] as string);
    expect(parsed.labels).toMatchObject({ step: 't', status: 'error' });
  });
});
