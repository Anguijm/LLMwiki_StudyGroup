import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  makeTokenBudgetLimiter,
  makeIngestEventLimiter,
  makeMagicLinkLimiter,
  makeAuthCallbackLimiter,
  makeRatingLimiter,
  RateLimitExceededError,
  RatelimitUnavailableError,
  TOKEN_BUDGET_PER_HOUR,
  AUTH_CALLBACK_PER_IP_PER_MINUTE,
  RATING_SUBMITS_PER_MINUTE,
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

describe('auth callback limiter (tier D)', () => {
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    errSpy.mockRestore();
  });

  /**
   * Stringify a value for substring scanning. Objects via JSON; anything
   * that fails to stringify falls back to String(). Used to assert that
   * a raw IP is NEVER anywhere in a console.error argument — not as
   * object key, value, nested property, or message.
   */
  function stringifyArg(x: unknown): string {
    try {
      return typeof x === 'string' ? x : JSON.stringify(x);
    } catch {
      return String(x);
    }
  }

  /** Concatenation of every console.error argument across every call. */
  function allErrArgs(spy: ReturnType<typeof vi.spyOn>): string {
    return spy.mock.calls.flat().map(stringifyArg).join('\n');
  }

  it('AUTH_CALLBACK_PER_IP_PER_MINUTE is 20', () => {
    expect(AUTH_CALLBACK_PER_IP_PER_MINUTE).toBe(20);
  });

  it('fails OPEN on upstash failure (transient outage must not deny legit sign-ins)', async () => {
    // Contrast with every other tier (which fails closed). The callback
    // is a click-through from a time-boxed magic-link email; a 503 on
    // Redis outage is a worse UX than dropping the rate-limit briefly,
    // and Supabase's own project-level rate limits provide the backstop.
    const redis = { eval: async () => { throw new Error('down'); } };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test-only
    const lim = makeAuthCallbackLimiter({ redis: redis as any });
    await expect(lim.reserve('1.2.3.4')).resolves.toBeUndefined();
  });

  // ===== Issue #26 / PR #28 — fail-open alerting =========================

  it('emits a structured alert on fail-open so monitoring can page', async () => {
    // Council security r2 on PR #25: "A silently disabled control is
    // not a control." The fail-open branch MUST log a monitor-greppable
    // record with stable keys so a log drain + alerting rule can fire
    // when Upstash degrades.
    const redis = { eval: async () => { throw new Error('network'); } };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test-only
    const lim = makeAuthCallbackLimiter({ redis: redis as any });
    await lim.reserve('203.0.113.9');
    expect(errSpy).toHaveBeenCalledTimes(1);
    const [message, context] = errSpy.mock.calls[0] as [string, unknown];
    expect(message).toContain('fail-open');
    expect(context).toMatchObject({
      alert: true,
      tier: 'auth_callback_ip',
    });
    // ip_bucket is a short prefix, not the full IP.
    const ipBucket = (context as { ip_bucket?: unknown }).ip_bucket;
    expect(typeof ipBucket).toBe('string');
    expect((ipBucket as string).length).toBeLessThanOrEqual(3);
  });

  it('fail-open log NEVER contains the raw IP string anywhere in any argument', async () => {
    // Council security r1 must-do: stringify EVERY console.error argument
    // and assert the raw ip is not a substring anywhere — not just
    // "not passed directly" but "not reachable by any grep."
    const rawIp = '203.0.113.9';
    const redis = { eval: async () => { throw new Error('network'); } };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test-only
    const lim = makeAuthCallbackLimiter({ redis: redis as any });
    await lim.reserve(rawIp);
    expect(allErrArgs(errSpy)).not.toContain(rawIp);
  });

  it('fail-open with undefined ip logs ip_bucket="unknown" without TypeError', async () => {
    // Council bugs r1: if ip is missing, `ip.slice(0,3)` would TypeError
    // and swallow the very alert the plan adds. Null-safe bucketing
    // falls back to the literal string "unknown".
    const redis = { eval: async () => { throw new Error('network'); } };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test-only
    const lim = makeAuthCallbackLimiter({ redis: redis as any });
    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test-only
      lim.reserve(undefined as any),
    ).resolves.toBeUndefined();
    expect(errSpy).toHaveBeenCalledTimes(1);
    const [, context] = errSpy.mock.calls[0] as [string, unknown];
    expect((context as { ip_bucket?: unknown }).ip_bucket).toBe('unknown');
  });

  it('fail-open with null ip logs ip_bucket="unknown" without TypeError', async () => {
    const redis = { eval: async () => { throw new Error('network'); } };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test-only
    const lim = makeAuthCallbackLimiter({ redis: redis as any });
    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test-only
      lim.reserve(null as any),
    ).resolves.toBeUndefined();
    const [, context] = errSpy.mock.calls[0] as [string, unknown];
    expect((context as { ip_bucket?: unknown }).ip_bucket).toBe('unknown');
  });

  it('fail-open with empty-string ip logs ip_bucket="unknown"', async () => {
    const redis = { eval: async () => { throw new Error('network'); } };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test-only
    const lim = makeAuthCallbackLimiter({ redis: redis as any });
    await expect(lim.reserve('')).resolves.toBeUndefined();
    const [, context] = errSpy.mock.calls[0] as [string, unknown];
    expect((context as { ip_bucket?: unknown }).ip_bucket).toBe('unknown');
  });

  it('fail-open log includes a non-empty errorName (class identifier)', async () => {
    // @upstash/ratelimit wraps the underlying redis throw before it
    // reaches our catch, so we don't assert the exact class — the
    // contract is "some class identifier string," stable enough for
    // monitoring to distinguish "rate limiter is unhappy" from "rate
    // limiter is quiet." Payload / message is NOT in the log.
    const redis = { eval: async () => { throw new Error('redis down'); } };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test-only
    const lim = makeAuthCallbackLimiter({ redis: redis as any });
    await lim.reserve('198.51.100.1');
    const [, context] = errSpy.mock.calls[0] as [string, unknown];
    const errorName = (context as { errorName?: unknown }).errorName;
    expect(typeof errorName).toBe('string');
    expect((errorName as string).length).toBeGreaterThan(0);
  });

  it('accepts auth_callback_ip as a RateLimitExceededError kind', () => {
    // Type + runtime check: the route handler's instanceof guard
    // depends on this kind being in the union. If a future refactor
    // drops the kind from the constructor, this test fails.
    const err = new RateLimitExceededError('auth_callback_ip', new Date());
    expect(err.kind).toBe('auth_callback_ip');
    expect(err).toBeInstanceOf(RateLimitExceededError);
  });
});

describe('rating limiter (tier E)', () => {
  it('exports a 30/min constant', () => {
    expect(RATING_SUBMITS_PER_MINUTE).toBe(30);
  });

  it('throws RatelimitUnavailable on upstash failure (caller decides fail-open)', async () => {
    const redis = { eval: async () => { throw new Error('down'); } };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test-only
    const lim = makeRatingLimiter({ redis: redis as any });
    await expect(lim.reserve('user-a')).rejects.toBeInstanceOf(
      RatelimitUnavailableError,
    );
  });

  it('makeRatingLimiter returns a limiter with reserve() method', () => {
    // Smoke test: per-user isolation is a property of @upstash/ratelimit's
    // SlidingWindow + our `user:${userId}` keying + `rl:rating` prefix.
    // The keying is identical in shape to Tier A (ingest events) which
    // is exercised in production. Fully simulating the Upstash protocol
    // (Lua script, multi-key reads) here would re-test the upstream lib.
    // Instead: confirm the factory produces a limiter object with the
    // expected shape; rely on Tier A's parallel test for the eval path.
    const redis = { eval: async () => [1, Date.now() + 60_000, 30, 29] };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test-only
    const lim = makeRatingLimiter({ redis: redis as any });
    expect(typeof lim.reserve).toBe('function');
  });
});
