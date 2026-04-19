import { describe, it, expect, vi } from 'vitest';
import {
  makeTokenBudgetLimiter,
  makeIngestEventLimiter,
  makeMagicLinkLimiter,
  RateLimitExceededError,
  RatelimitUnavailableError,
  TOKEN_BUDGET_PER_HOUR,
} from './index';

interface PipelineLike {
  incrby: (k: string, n: number) => PipelineLike;
  pexpire: (k: string, ms: number) => PipelineLike;
  exec: () => Promise<number[]>;
}

function fakeRedis(store: Map<string, number>) {
  return {
    incrby: vi.fn(async (k: string, n: number) => {
      const v = (store.get(k) ?? 0) + n;
      store.set(k, v);
      return v;
    }),
    decrby: vi.fn(async (k: string, n: number) => {
      const v = (store.get(k) ?? 0) - n;
      store.set(k, v);
      return v;
    }),
    pexpire: vi.fn(async (_k: string, _ms: number) => 1),
    pipeline(): PipelineLike {
      const ops: Array<() => Promise<number>> = [];
      const pipe: PipelineLike = {
        incrby: (k: string, n: number) => {
          const v = (store.get(k) ?? 0) + n;
          ops.push(async () => {
            store.set(k, v);
            return v;
          });
          return pipe;
        },
        pexpire: (_k: string, _ms: number) => {
          ops.push(async () => 1);
          return pipe;
        },
        exec: async () => Promise.all(ops.map((op) => op())),
      };
      return pipe;
    },
  };
}

describe('token budget limiter', () => {
  it('reserves up to the cap', async () => {
    const store = new Map<string, number>();
    const redis = fakeRedis(store);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test-only
    const lim = makeTokenBudgetLimiter({ redis: redis as any });
    await expect(lim.reserve('u1', 50_000)).resolves.toBeUndefined();
    await expect(lim.reserve('u1', 40_000)).resolves.toBeUndefined();
    expect(store.get('rl:tokens:u1')).toBe(90_000);
  });

  it('rejects when over the budget and refunds the attempted claim', async () => {
    const store = new Map<string, number>();
    const redis = fakeRedis(store);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test-only
    const lim = makeTokenBudgetLimiter({ redis: redis as any });
    await lim.reserve('u1', 90_000);
    await expect(lim.reserve('u1', 20_000)).rejects.toBeInstanceOf(RateLimitExceededError);
    expect(store.get('rl:tokens:u1')).toBe(90_000); // decrby restored
  });

  it('fails closed when Upstash is unreachable', async () => {
    const redis = {
      pipeline() {
        return {
          incrby() { return this; },
          pexpire() { return this; },
          exec: async () => { throw new Error('network'); },
        };
      },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test-only
    const lim = makeTokenBudgetLimiter({ redis: redis as any });
    await expect(lim.reserve('u1', 100)).rejects.toBeInstanceOf(RatelimitUnavailableError);
  });

  it('refund swallows errors', async () => {
    const redis = { decrby: async () => { throw new Error('down'); } };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test-only
    const lim = makeTokenBudgetLimiter({ redis: redis as any });
    await expect(lim.refund('u1', 100)).resolves.toBeUndefined();
  });

  it('TOKEN_BUDGET_PER_HOUR is 100k', () => {
    expect(TOKEN_BUDGET_PER_HOUR).toBe(100_000);
  });
});

describe('ingest event limiter', () => {
  it('throws RatelimitUnavailable on upstash failure (fail closed on write)', async () => {
    // The upstream @upstash/ratelimit constructor throws when given an
    // incomplete client; we simulate by passing a stub that fails .eval.
    const redis = { eval: async () => { throw new Error('down'); } };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test-only
    const lim = makeIngestEventLimiter({ redis: redis as any });
    await expect(lim.reserve('u1')).rejects.toBeInstanceOf(RatelimitUnavailableError);
  });
});

describe('magic link limiter', () => {
  it('throws RatelimitUnavailable on upstash failure (fail closed)', async () => {
    const redis = { eval: async () => { throw new Error('down'); } };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test-only
    const lim = makeMagicLinkLimiter({ redis: redis as any });
    await expect(lim.reserve('1.2.3.4', 'x@y.z')).rejects.toBeInstanceOf(
      RatelimitUnavailableError,
    );
  });
});
