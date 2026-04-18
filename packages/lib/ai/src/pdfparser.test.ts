import { afterEach, describe, it, expect, vi } from 'vitest';
import { makePdfParserClient, resolvePdfParser } from './pdfparser';
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

describe('resolvePdfParser', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns the reducto config when PDF_PARSER=reducto and REDUCTO_API_KEY is set', () => {
    vi.stubEnv('PDF_PARSER', 'reducto');
    vi.stubEnv('REDUCTO_API_KEY', 'r-key');
    vi.stubEnv('LLAMAPARSE_API_KEY', undefined as unknown as string);
    expect(resolvePdfParser()).toEqual({ kind: 'reducto', apiKey: 'r-key' });
  });

  it('returns the llamaparse config when PDF_PARSER=llamaparse and LLAMAPARSE_API_KEY is set', () => {
    vi.stubEnv('PDF_PARSER', 'llamaparse');
    vi.stubEnv('LLAMAPARSE_API_KEY', 'l-key');
    vi.stubEnv('REDUCTO_API_KEY', undefined as unknown as string);
    expect(resolvePdfParser()).toEqual({ kind: 'llamaparse', apiKey: 'l-key' });
  });

  it.each([
    ['Reducto', 'reducto', 'REDUCTO_API_KEY'],
    ['REDUCTO', 'reducto', 'REDUCTO_API_KEY'],
    ['LlamaParse', 'llamaparse', 'LLAMAPARSE_API_KEY'],
    ['LLAMAPARSE', 'llamaparse', 'LLAMAPARSE_API_KEY'],
  ])('normalizes mixed-case %s to %s via locale-aware lowercasing', (input, normalized, keyName) => {
    vi.stubEnv('PDF_PARSER', input);
    vi.stubEnv(keyName, 'k');
    expect(resolvePdfParser().kind).toBe(normalized);
  });

  it.each([
    ['undefined', undefined],
    ['empty string', ''],
    ['whitespace', '   '],
    ['newline', '\n'],
  ] as const)('throws when PDF_PARSER is %s', (_label, value) => {
    vi.stubEnv('PDF_PARSER', value as string);
    expect(() => resolvePdfParser()).toThrowError(/PDF_PARSER missing or empty/);
  });

  it('throws when PDF_PARSER is an unknown value', () => {
    vi.stubEnv('PDF_PARSER', 'mystery');
    vi.stubEnv('REDUCTO_API_KEY', 'r-key');
    expect(() => resolvePdfParser()).toThrowError(
      /PDF_PARSER must be one of 'reducto', 'llamaparse'.*got 'mystery'/,
    );
  });

  it.each([
    ['undefined', undefined],
    ['empty string', ''],
    ['whitespace', '   '],
  ] as const)(
    "throws when PDF_PARSER='reducto' but REDUCTO_API_KEY is %s",
    (_label, value) => {
      vi.stubEnv('PDF_PARSER', 'reducto');
      vi.stubEnv('REDUCTO_API_KEY', value as string);
      expect(() => resolvePdfParser()).toThrowError(
        /PDF_PARSER is 'reducto' but REDUCTO_API_KEY is missing or empty/,
      );
    },
  );

  it.each([
    ['undefined', undefined],
    ['empty string', ''],
    ['whitespace', '   '],
  ] as const)(
    "throws when PDF_PARSER='llamaparse' but LLAMAPARSE_API_KEY is %s",
    (_label, value) => {
      vi.stubEnv('PDF_PARSER', 'llamaparse');
      vi.stubEnv('LLAMAPARSE_API_KEY', value as string);
      expect(() => resolvePdfParser()).toThrowError(
        /PDF_PARSER is 'llamaparse' but LLAMAPARSE_API_KEY is missing or empty/,
      );
    },
  );

  it("throws when PDF_PARSER='reducto' and only LLAMAPARSE_API_KEY is provided", () => {
    vi.stubEnv('PDF_PARSER', 'reducto');
    vi.stubEnv('REDUCTO_API_KEY', undefined as unknown as string);
    vi.stubEnv('LLAMAPARSE_API_KEY', 'l-key');
    expect(() => resolvePdfParser()).toThrowError(
      /PDF_PARSER is 'reducto' but REDUCTO_API_KEY is missing or empty/,
    );
  });
});
