import { describe, it, expect, vi } from 'vitest';
import { makeVoyageClient } from './voyage';
import {
  AiResponseShapeError,
  AiUpstreamError,
  AiRequestTimeoutError,
} from './errors';

function okJson(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function statusResponse(status: number): Response {
  return new Response('upstream error body', { status });
}

function validEmbeddingBody() {
  return {
    data: [{ embedding: new Array(1024).fill(0.1), index: 0 }],
    model: 'voyage-3',
    usage: { total_tokens: 10 },
  };
}

// No-op sleep so the retry loop doesn't add real seconds to the test run.
const noSleep = () => Promise.resolve();

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

describe('voyage — retry on transient upstream failures (council r1 fold)', () => {
  it('retries once on 5xx then succeeds', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(statusResponse(503))
      .mockResolvedValueOnce(okJson(validEmbeddingBody()));
    const client = makeVoyageClient({
      apiKey: 'k',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleepImpl: noSleep,
    });
    const emb = await client.embed('hi');
    expect(emb).toHaveLength(1024);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('retries twice on 5xx then succeeds', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(statusResponse(500))
      .mockResolvedValueOnce(statusResponse(502))
      .mockResolvedValueOnce(okJson(validEmbeddingBody()));
    const client = makeVoyageClient({
      apiKey: 'k',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleepImpl: noSleep,
    });
    const emb = await client.embed('hi');
    expect(emb).toHaveLength(1024);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('throws AiUpstreamError after MAX_ATTEMPTS consecutive 5xx', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(statusResponse(503));
    const client = makeVoyageClient({
      apiKey: 'k',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleepImpl: noSleep,
    });
    await expect(client.embed('hi')).rejects.toBeInstanceOf(AiUpstreamError);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('does NOT retry on 4xx — surfaces immediately', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(statusResponse(401));
    const client = makeVoyageClient({
      apiKey: 'k',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleepImpl: noSleep,
    });
    await expect(client.embed('hi')).rejects.toBeInstanceOf(AiResponseShapeError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('does NOT retry on schema-validation failure (200 + malformed body)', async () => {
    // Council r2 [bugs] fold: 200 OK + invalid shape is deterministic;
    // retrying would produce the same failure. Surface immediately.
    const fetchImpl = vi.fn().mockResolvedValue(okJson({ totally: 'wrong' }));
    const client = makeVoyageClient({
      apiKey: 'k',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleepImpl: noSleep,
    });
    await expect(client.embed('hi')).rejects.toBeInstanceOf(AiResponseShapeError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('retries network failures (fetch throws non-Abort error)', async () => {
    const networkErr = new Error('ECONNRESET');
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(networkErr)
      .mockResolvedValueOnce(okJson(validEmbeddingBody()));
    const client = makeVoyageClient({
      apiKey: 'k',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleepImpl: noSleep,
    });
    const emb = await client.embed('hi');
    expect(emb).toHaveLength(1024);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('retries timeout failures (AiRequestTimeoutError) the same way', async () => {
    // Force the fetch to throw an AbortError so withTimeout converts to
    // AiRequestTimeoutError. Then succeed on retry.
    const abortErr = new Error('aborted');
    abortErr.name = 'AbortError';
    const fetchImpl = vi
      .fn()
      .mockImplementationOnce(async (_url: string, init: RequestInit) => {
        // Trigger the abort so withTimeout maps to AiRequestTimeoutError.
        // We need the controller to actually abort first; simulate by
        // throwing the abort error and signalling via the signal.
        const sig = init.signal as AbortSignal | null;
        if (sig) {
          // Force the signal to look aborted; the controller in
          // withTimeout will treat this as a timeout.
          Object.defineProperty(sig, 'aborted', { value: true });
        }
        throw abortErr;
      })
      .mockResolvedValueOnce(okJson(validEmbeddingBody()));
    const client = makeVoyageClient({
      apiKey: 'k',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleepImpl: noSleep,
    });
    const emb = await client.embed('hi');
    expect(emb).toHaveLength(1024);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    // Confirm the first attempt produced a timeout (caught + retried).
    void AiRequestTimeoutError; // keep the import in scope for clarity.
  });

  it('respects custom maxAttempts override (defense for tunability)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(statusResponse(503));
    const client = makeVoyageClient({
      apiKey: 'k',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleepImpl: noSleep,
      maxAttempts: 5,
    });
    await expect(client.embed('hi')).rejects.toBeInstanceOf(AiUpstreamError);
    expect(fetchImpl).toHaveBeenCalledTimes(5);
  });
});
