// Voyage-3 embedding wrapper. 1024-dim, cosine-normalized.
// Zod-validated response + 30s timeout.
//
// Cost (callsite):
//   embed — Voyage-3, ~0.8k input tokens avg, $0.00012 per call.
//   Call volume: ingest = 1 per note; getContext = per note page render.
//     ~80 ingests/mo + ~200 page views/mo = ~280 calls/mo (~$0.04/mo).
import { z } from 'zod';
import { AiResponseShapeError } from './errors';
import { DEFAULT_TIMEOUT_MS, withTimeout } from './with-timeout';

const VOYAGE_ENDPOINT = 'https://api.voyageai.com/v1/embeddings';
const VOYAGE_MODEL = 'voyage-3';
const VOYAGE_DIMS = 1024;

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
}

export function makeVoyageClient(deps: VoyageClientDeps) {
  const f = deps.fetchImpl ?? fetch;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  async function embed(text: string): Promise<number[]> {
    return withTimeout('voyage', timeoutMs, async (signal) => {
      const res = await f(VOYAGE_ENDPOINT, {
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
      if (!res.ok) {
        throw new AiResponseShapeError('voyage', `HTTP ${res.status}`);
      }
      let json: unknown;
      try {
        json = await res.json();
      } catch (e) {
        throw new AiResponseShapeError('voyage', 'non-JSON response body', e);
      }
      const parsed = VoyageResponseSchema.safeParse(json);
      if (!parsed.success) {
        throw new AiResponseShapeError('voyage', parsed.error.message, parsed.error);
      }
      const first = parsed.data.data[0];
      if (!first) {
        throw new AiResponseShapeError('voyage', 'empty data array');
      }
      return first.embedding;
    });
  }

  return { embed };
}

export type VoyageClient = ReturnType<typeof makeVoyageClient>;
