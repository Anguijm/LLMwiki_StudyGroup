import { describe, it, expect, vi } from 'vitest';
import { makePdfParserClient } from './pdfparser';
import { AiResponseShapeError } from './errors';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('pdfparser', () => {
  it('parses a valid Reducto response', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        blocks: [{ type: 'paragraph', text: 'hello', page: 1 }],
        page_count: 1,
      }),
    );
    const client = makePdfParserClient({
      kind: 'reducto',
      apiKey: 'k',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const parsed = await client.parse('https://example/x.pdf');
    expect(parsed.page_count).toBe(1);
    expect(parsed.blocks[0]?.text).toBe('hello');
  });

  it('throws AiResponseShapeError on a 200 but malformed body', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ unexpected: true }));
    const client = makePdfParserClient({
      kind: 'llamaparse',
      apiKey: 'k',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(client.parse('https://x/y.pdf')).rejects.toBeInstanceOf(AiResponseShapeError);
  });

  it('throws AiResponseShapeError on non-JSON', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        new Response('not json', { status: 200, headers: { 'content-type': 'text/plain' } }),
      );
    const client = makePdfParserClient({
      kind: 'reducto',
      apiKey: 'k',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(client.parse('https://x/y.pdf')).rejects.toBeInstanceOf(AiResponseShapeError);
  });

  it('throws AiResponseShapeError on HTTP !ok', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({}, 500));
    const client = makePdfParserClient({
      kind: 'reducto',
      apiKey: 'k',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(client.parse('https://x/y.pdf')).rejects.toMatchObject({
      name: 'AiResponseShapeError',
    });
  });
});
