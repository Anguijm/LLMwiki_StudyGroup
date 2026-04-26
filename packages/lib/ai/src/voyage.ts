// Voyage-3 embedding wrapper. 1024-dim, cosine-normalized.
// Zod-validated response + 30s timeout + 3-attempt exponential backoff
// retry on transient upstream failures.
//
// Cost (callsite):
//   embed — Voyage-3, ~0.8k input tokens avg, $0.00012 per call.
//   Call volume after #39 ships: ingest = N per document (one per
//     section, ~20-40 sections for textbook-sized PDFs); getContext
//     = per note page render. Estimated ~280 calls/mo today + N×80
//     ingest fan-out from sectioned PDFs ≈ ~1000-3000 calls/mo
//     ($0.12-0.36/mo). Within $75-110/mo budget.
//
// Council folds (#39 phase 3):
//   - r1 [bugs] external-API flakiness: 3-attempt retry with
//     exponential backoff on 5xx + network + timeout errors. 4xx and
//     schema-validation failures are non-retryable (deterministic).
//   - r2 [bugs] 200-OK-malformed-body: existing Zod schema validation
//     + new test that asserts non-retryable failure on malformed bodies.
import { z } from 'zod';
import {
  AiResponseShapeError,
  AiRequestTimeoutError,
  AiUpstreamError,
} from './errors';
import { DEFAULT_TIMEOUT_MS, withTimeout } from './with-timeout';

const VOYAGE_ENDPOINT = 'https://api.voyageai.com/v1/embeddings';
const VOYAGE_MODEL = 'voyage-3';
const VOYAGE_DIMS = 1024;

// Retry policy: 3 attempts total, with 2 sleeps between them. The "4s"
// of "1s/2s/4s exponential" pattern is the next-doubling slot — kept
// in the array as the implicit ceiling on a 4th attempt if a future
// caller wants to bump VOYAGE_MAX_ATTEMPTS. Default config uses only
// the first two delays.
export const VOYAGE_MAX_ATTEMPTS = 3;
export const VOYAGE_RETRY_DELAYS_MS = [1_000, 2_000, 4_000] as const;

const VoyageResponseSchema = z.object({
  data: z
    .array(
      z.object({
        embedding: z.array(z.number()).length(VOYAGE_DIMS),
        index: z.number(),
      }),
    )
    .min(1),
  model: z.string(),
  usage: z.object({ total_tokens: z.number() }).passthrough(),
});

export interface VoyageClientDeps {
  apiKey: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  // Inject for tests so backoff doesn't add real seconds to the suite.
  sleepImpl?: (ms: number) => Promise<void>;
  // Override for tests; the production default is VOYAGE_RETRY_DELAYS_MS.
  retryDelaysMs?: readonly number[];
  // Override for tests; production default is VOYAGE_MAX_ATTEMPTS.
  maxAttempts?: number;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

function isRetryable(err: unknown): boolean {
  return err instanceof AiUpstreamError || err instanceof AiRequestTimeoutError;
}

export function makeVoyageClient(deps: VoyageClientDeps) {
  const f = deps.fetchImpl ?? fetch;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const sleep = deps.sleepImpl ?? defaultSleep;
  const delays = deps.retryDelaysMs ?? VOYAGE_RETRY_DELAYS_MS;
  const maxAttempts = deps.maxAttempts ?? VOYAGE_MAX_ATTEMPTS;

  async function embedOnce(text: string): Promise<number[]> {
    return withTimeout('voyage', timeoutMs, async (signal) => {
      let res: Response;
      try {
        res = await f(VOYAGE_ENDPOINT, {
          method: 'POST',
          signal,
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${deps.apiKey}`,
          },
          body: JSON.stringify({
            input: [text],
            model: VOYAGE_MODEL,
            input_type: 'document',
          }),
        });
      } catch (err) {
        // Network-level failure (DNS, connection refused, etc.) before
        // any HTTP response. Map to upstream-retryable. AbortError
        // (timeout) bubbles via withTimeout → AiRequestTimeoutError.
        if (err instanceof Error && err.name === 'AbortError') throw err;
        throw new AiUpstreamError('voyage', null, 'network failure', err);
      }
      if (!res.ok) {
        // 5xx → retryable upstream error. 4xx → deterministic (auth
        // failure, bad request); not worth retrying — the next call
        // would fail the same way.
        if (res.status >= 500 && res.status < 600) {
          throw new AiUpstreamError('voyage', res.status, `HTTP ${res.status}`);
        }
        throw new AiResponseShapeError('voyage', `HTTP ${res.status}`);
      }
      let json: unknown;
      try {
        json = await res.json();
      } catch (e) {
        // 200 OK + non-JSON body = upstream malformed; non-retryable
        // (council r2 [bugs] fold).
        throw new AiResponseShapeError('voyage', 'non-JSON response body', e);
      }
      const parsed = VoyageResponseSchema.safeParse(json);
      if (!parsed.success) {
        // 200 OK + JSON-parses-but-wrong-shape = same class.
        throw new AiResponseShapeError('voyage', parsed.error.message, parsed.error);
      }
      const first = parsed.data.data[0];
      if (!first) {
        throw new AiResponseShapeError('voyage', 'empty data array');
      }
      return first.embedding;
    });
  }

  async function embed(text: string): Promise<number[]> {
    let lastErr: unknown;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        return await embedOnce(text);
      } catch (err) {
        lastErr = err;
        if (!isRetryable(err)) throw err;
        // Sleep before retry, but not after the last attempt.
        if (attempt < maxAttempts - 1) {
          const delay = delays[attempt] ?? delays[delays.length - 1] ?? 0;
          await sleep(delay);
        }
      }
    }
    throw lastErr;
  }

  return { embed };
}

export type VoyageClient = ReturnType<typeof makeVoyageClient>;
