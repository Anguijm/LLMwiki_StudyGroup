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
import { requireEnv } from '@llmwiki/lib-utils/env';

export class RateLimitExceededError extends Error {
  override readonly name = 'RateLimitExceededError';
  constructor(
    public readonly kind:
      | 'ingest_events'
      | 'token_budget'
      | 'magic_link_ip'
      | 'magic_link_email'
      | 'auth_callback_ip'
      | 'rating_submits',
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
  const url = deps.url ?? requireEnv('UPSTASH_REDIS_REST_URL');
  const token = deps.token ?? requireEnv('UPSTASH_REDIS_REST_TOKEN');
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

// ----- Tier D: auth callback limiter (anonymous, per-IP, minute window) ---
//
// /auth/callback is the click-through landing URL for the magic-link email.
// It receives a short-lived PKCE code in a query param and calls Supabase
// Auth's exchangeCodeForSession. A public endpoint + fan-out to an external
// API = a small but real DOS vector: an attacker can spam bad codes,
// consuming our server cycles and Supabase's per-project rate budget even
// though the codes will be rejected.
//
// Defensive posture: 20 req / minute / IP — generous enough that a
// legitimate user's link-click (or a handful of retries) never gets
// blocked, strict enough that a single-source spam wave hits the ceiling
// in seconds. FAIL-OPEN on Upstash outage: bouncing a legit sign-in
// because Redis is down is worse than losing the DOS guard briefly,
// especially given Supabase's own project-level rate limits as a deeper
// backstop.

export const AUTH_CALLBACK_PER_IP_PER_MINUTE = 20;

export function makeAuthCallbackLimiter(deps: RateLimitDeps = {}) {
  const redis = makeRedis(deps);
  const limiter = new Ratelimit({
    redis,
    limiter: Ratelimit.slidingWindow(AUTH_CALLBACK_PER_IP_PER_MINUTE, '1 m'),
    analytics: false,
    prefix: 'rl:authcb:ip',
  });

  /**
   * Check-and-decrement the per-IP callback counter.
   *
   *   - Throws RateLimitExceededError('auth_callback_ip') if over the limit.
   *   - FAIL-OPEN on Upstash unreachable: resolves without reserving, AND
   *     emits a structured `alert: true` log so monitoring can page.
   *     Intentional fail-open: a transient Redis outage must not deny a
   *     legit user's link-click. Silent fail-open is worse than no
   *     limiter — a disabled control with no visibility is invisibly
   *     absent. The alert log shape is the stable grep contract;
   *     see README.md §Monitoring.
   *
   * ### Monitor grep contract (STABLE)
   *
   * ```
   * [rate-limit] fail-open triggered { alert: true, tier: 'auth_callback_ip', errorName, ip_bucket }
   * ```
   *
   * - `alert: true` — monitor trigger flag
   * - `tier: 'auth_callback_ip'` — which limiter fired
   * - `errorName: string` — the thrown error's `.name` (or typeof for
   *   non-Error throws) — a class identifier only, no payload
   * - `ip_bucket: string` — 3-character prefix of the IP for coarse
   *   locality, or the literal `'unknown'` if ip is missing. NEVER
   *   the full IP.
   *
   * Do NOT rename these keys without a coordinated monitoring-config
   * change.
   */
  async function reserve(ip: string | null | undefined): Promise<void> {
    let result: Awaited<ReturnType<typeof limiter.limit>>;
    try {
      result = await limiter.limit(ip ?? 'no-xff');
    } catch (err) {
      // Null-safe ip_bucket. Council bugs r1 on PR #28: `ip.slice(0,3)`
      // on a missing ip would TypeError and swallow the alert entirely —
      // re-introducing the very silent-fail-open gap this branch is
      // adding visibility to.
      const ip_bucket =
        typeof ip === 'string' && ip.length > 0 ? ip.slice(0, 3) : 'unknown';
      // eslint-disable-next-line no-console
      console.error('[rate-limit] fail-open triggered', {
        alert: true,
        tier: 'auth_callback_ip',
        errorName: err instanceof Error ? err.name : typeof err,
        ip_bucket,
      });
      return; // fail-OPEN; see docstring for rationale
    }
    if (!result.success) {
      throw new RateLimitExceededError('auth_callback_ip', new Date(result.reset));
    }
  }

  return { reserve };
}

// ----- Tier C: magic-link auth limiter (anonymous endpoint) ---------------
//
// Magic-link requests come in unauthenticated (the point of the flow is to
// identify the user via email), so the other two tiers' per-user key won't
// work. This tier keys by BOTH client IP and normalized email with
// independent counters — per-IP stops a single source from flooding the
// email provider; per-email stops a targeted attacker from spraying a
// single inbox.
//
// Limits are intentionally low. A real user hits this button a handful of
// times per session at most. Rate-limiter resolution is per-hour.

export const MAGIC_LINK_PER_IP_PER_HOUR = 5;
export const MAGIC_LINK_PER_EMAIL_PER_HOUR = 3;

export function makeMagicLinkLimiter(deps: RateLimitDeps = {}) {
  const redis = makeRedis(deps);
  const ipLimiter = new Ratelimit({
    redis,
    limiter: Ratelimit.slidingWindow(MAGIC_LINK_PER_IP_PER_HOUR, '1 h'),
    analytics: false,
    prefix: 'rl:magiclink:ip',
  });
  const emailLimiter = new Ratelimit({
    redis,
    limiter: Ratelimit.slidingWindow(MAGIC_LINK_PER_EMAIL_PER_HOUR, '1 h'),
    analytics: false,
    prefix: 'rl:magiclink:email',
  });

  /**
   * Check-and-decrement both counters. Throws:
   *   - RateLimitExceededError('magic_link_ip') if IP is over the limit.
   *   - RateLimitExceededError('magic_link_email') if email is over the limit.
   *   - RatelimitUnavailableError if Upstash is unreachable (fail-closed).
   *
   * `ip` should be the first entry of X-Forwarded-For (trimmed). `email`
   * must be normalized (trimmed + `.toLocaleLowerCase('en-US')`) before
   * calling so the per-email bucket is stable against casing drift.
   */
  async function reserve(ip: string, email: string): Promise<void> {
    let ipRes: Awaited<ReturnType<typeof ipLimiter.limit>>;
    let emailRes: Awaited<ReturnType<typeof emailLimiter.limit>>;
    try {
      [ipRes, emailRes] = await Promise.all([
        ipLimiter.limit(ip),
        emailLimiter.limit(email),
      ]);
    } catch {
      throw new RatelimitUnavailableError();
    }
    if (!ipRes.success) {
      throw new RateLimitExceededError('magic_link_ip', new Date(ipRes.reset));
    }
    if (!emailRes.success) {
      throw new RateLimitExceededError('magic_link_email', new Date(emailRes.reset));
    }
  }

  return { reserve };
}

// ----- Tier E: review rating limiter (per-user, minute window) -------------
//
// /review's submitReview server action is an authenticated mutation
// endpoint. CLAUDE.md non-negotiables require rate-limiting on every
// external/mutation call. 30 ratings / user / minute is well above
// realistic study behavior (a serious session is ~5–10 cards/min) and
// well below abuse rates. Council r1 security non-negotiable on PR #48.

export const RATING_SUBMITS_PER_MINUTE = 30;

export function makeRatingLimiter(deps: RateLimitDeps = {}) {
  const redis = makeRedis(deps);
  const limiter = new Ratelimit({
    redis,
    limiter: Ratelimit.slidingWindow(RATING_SUBMITS_PER_MINUTE, '1 m'),
    analytics: false,
    prefix: 'rl:rating',
  });

  /**
   * Check-and-decrement the per-user rating counter. Throws:
   *   - RateLimitExceededError if the user is over the limit (server
   *     action returns errorKind: 'rate_limited').
   *   - RatelimitUnavailableError if Upstash is unreachable. Caller
   *     decides fail-open vs fail-closed; submitReview chooses fail-open
   *     (matches Tier B/D pattern — better to let a real user through
   *     than block on limiter outage).
   */
  async function reserve(userId: string): Promise<void> {
    let result: Awaited<ReturnType<typeof limiter.limit>>;
    try {
      result = await limiter.limit(`user:${userId}`);
    } catch {
      throw new RatelimitUnavailableError();
    }
    if (!result.success) {
      throw new RateLimitExceededError('rating_submits', new Date(result.reset));
    }
  }

  return { reserve };
}
