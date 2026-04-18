import { describe, it, expect, vi } from 'vitest';
import { makeVoyageClient } from './voyage';
import { AiResponseShapeError } from './errors';

function okJson(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('voyage', () => {
  it('returns a 1024-dim embedding on a valid response', async () => {
    const dims = new Array(1024).fill(0.1);
    const fetchImpl = vi.fn().mockResolvedValue(
      okJson({
        data: [{ embedding: dims, index: 0 }],
        model: 'voyage-3',
        usage: { total_tokens: 10 },
      }),
    );
    const client = makeVoyageClient({
      apiKey: 'k',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const emb = await client.embed('hello');
    expect(emb).toHaveLength(1024);
  });

  it('rejects a response with wrong embedding dims', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      okJson({
        data: [{ embedding: [1, 2, 3], index: 0 }],
        model: 'voyage-3',
        usage: { total_tokens: 10 },
      }),
    );
    const client = makeVoyageClient({
      apiKey: 'k',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(client.embed('hi')).rejects.toBeInstanceOf(AiResponseShapeError);
  });

  it('rejects a 200 + error-body response', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okJson({ error: 'quota exceeded' }));
    const client = makeVoyageClient({
      apiKey: 'k',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(client.embed('hi')).rejects.toBeInstanceOf(AiResponseShapeError);
  });
});
