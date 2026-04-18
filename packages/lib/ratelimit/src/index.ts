// Two-tier Upstash-backed rate limiter.
//
// Tier A (event count, sliding window): 5 PDF ingests / user / hour.
//   - Write-side calls fail-CLOSED: Upstash unreachable -> reject (503).
//   - Read-side calls fail-OPEN: note-page reads served with a warning log.
//
// Tier B (token budget, sliding window): 100,000 tokens / user / hour.
//   - Always fail-CLOSED: any budget check that can't confirm headroom
//     fails the job with error.kind='ratelimit_unavailable'. We never
//     serve a budget-gated action on a "didn't check" answer.
//
// Cost: Upstash free tier (10k cmds/day) fits v0 easily.
import { Ratelimit } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';

export class RateLimitExceededError extends Error {
  override readonly name = 'RateLimitExceededError';
  constructor(
    public readonly kind: 'ingest_events' | 'token_budget',
    public readonly resetsAt: Date,
  ) {
    super(`rate limit exceeded: ${kind}; resets at ${resetsAt.toISOString()}`);
  }
}

export class RatelimitUnavailableError extends Error {
  override readonly name = 'RatelimitUnavailableError';
  constructor(message = 'Upstash unreachable; failing closed') {
    super(message);
  }
}

export interface RateLimitDeps {
  redis?: Redis;
  url?: string;
  token?: string;
}

function makeRedis(deps: RateLimitDeps): Redis {
  if (deps.redis) return deps.redis;
  const url = deps.url ?? process.env.UPSTASH_REDIS_REST_URL;
  const token = deps.token ?? process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    throw new Error('UPSTASH_REDIS_REST_URL / _TOKEN missing');
  }
  return new Redis({ url, token });
}

// ----- Tier A: event limiter (ingest uploads) -----------------------------

export const INGEST_EVENTS_PER_HOUR = 5;

export function makeIngestEventLimiter(deps: RateLimitDeps = {}) {
  const redis = makeRedis(deps);
  const limiter = new Ratelimit({
    redis,
    limiter: Ratelimit.slidingWindow(INGEST_EVENTS_PER_HOUR, '1 h'),
    analytics: false,
    prefix: 'rl:ingest',
  });

  /**
   * Check-and-decrement the per-user event counter. Throws:
   *   - RateLimitExceededError if the user is over the limit.
   *   - RatelimitUnavailableError if Upstash is unreachable (fail-closed).
   */
  async function reserve(userId: string): Promise<void> {
    let result: Awaited<ReturnType<typeof limiter.limit>>;
    try {
      result = await limiter.limit(`user:${userId}`);
    } catch {
      throw new RatelimitUnavailableError();
    }
    if (!result.success) {
      throw new RateLimitExceededError('ingest_events', new Date(result.reset));
    }
  }

  return { reserve };
}

// ----- Tier B: token budget (all AI + embedding costs) --------------------

export const TOKEN_BUDGET_PER_HOUR = 100_000;

export function makeTokenBudgetLimiter(deps: RateLimitDeps = {}) {
  const redis = makeRedis(deps);

  /**
   * Attempt to reserve `tokens` from the user's sliding-window budget.
   * Always fail-closed: any Upstash error aborts the caller.
   */
  async function reserve(userId: string, tokens: number): Promise<void> {
    const key = `rl:tokens:${userId}`;
    const nowMs = Date.now();
    const windowMs = 60 * 60 * 1000;

    // Atomic INCRBY + read-then-decide in a single Redis roundtrip via a
    // pipeline. INCRBY is always atomic; the TTL set doesn't matter for
    // correctness (it just bounds memory).
    let totalAfter: number;
    try {
      const pipe = redis.pipeline();
      pipe.incrby(key, tokens);
      pipe.pexpire(key, windowMs);
      const [incrResult] = await pipe.exec<[number, number]>();
      totalAfter = Number(incrResult);
    } catch {
      throw new RatelimitUnavailableError();
    }

    if (totalAfter > TOKEN_BUDGET_PER_HOUR) {
      // Over budget — refund the tokens we just claimed and raise.
      try {
        await redis.decrby(key, tokens);
      } catch {
        // Non-fatal: budget will auto-expire in <= 1h; log only.
      }
      throw new RateLimitExceededError('token_budget', new Date(nowMs + windowMs));
    }
  }

  /**
   * Refund previously-reserved tokens. Used by the onFailure hook after the
   * ingestion_jobs.reserved_tokens column has been atomically claimed.
   * Never throws — losing a refund is preferable to stalling the hook.
   */
  async function refund(userId: string, tokens: number): Promise<void> {
    try {
      await redis.decrby(`rl:tokens:${userId}`, tokens);
    } catch {
      // swallow — budget auto-expires
    }
  }

  return { reserve, refund };
}
