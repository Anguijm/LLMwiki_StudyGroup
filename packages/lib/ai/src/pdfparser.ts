// PDF parser wrapper — Reducto (default) with LlamaParse fallback via the
// PDF_PARSER env flag. Both return a normalized ParsedPdf shape with
// Zod-validated response + 30s timeout.
//
// Cost (callsite):
//   parse — Reducto free tier for a 4-user cohort; LlamaParse free up to
//   1000 pages/day. v0 ingest volume (80 PDFs/mo, avg 20 pages) stays
//   inside both free tiers — ~$0/mo.
import { z } from 'zod';
import { AiResponseShapeError } from './errors';
import { DEFAULT_TIMEOUT_MS, withTimeout } from './with-timeout';

const ParsedBlockSchema = z.object({
  type: z.string(),
  text: z.string(),
  page: z.number().optional(),
});

const ParsedPdfSchema = z.object({
  blocks: z.array(ParsedBlockSchema),
  page_count: z.number().int().nonnegative(),
});

export type ParsedPdf = z.infer<typeof ParsedPdfSchema>;

export type ParserKind = 'reducto' | 'llamaparse';

export interface PdfParserClientDeps {
  kind: ParserKind;
  apiKey: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

const REDUCTO_ENDPOINT = 'https://api.reducto.ai/v1/parse';
const LLAMAPARSE_ENDPOINT = 'https://api.cloud.llamaindex.ai/api/parsing/upload';

export function makePdfParserClient(deps: PdfParserClientDeps) {
  const f = deps.fetchImpl ?? fetch;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  async function parse(fileUrl: string): Promise<ParsedPdf> {
    return withTimeout('pdfparser', timeoutMs, async (signal) => {
      const endpoint = deps.kind === 'reducto' ? REDUCTO_ENDPOINT : LLAMAPARSE_ENDPOINT;
      const res = await f(endpoint, {
        method: 'POST',
        signal,
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${deps.apiKey}`,
        },
        body: JSON.stringify({ url: fileUrl }),
      });
      if (!res.ok) {
        throw new AiResponseShapeError('pdfparser', `HTTP ${res.status}`);
      }
      let json: unknown;
      try {
        json = await res.json();
      } catch (e) {
        throw new AiResponseShapeError('pdfparser', 'non-JSON response', e);
      }
      const parsed = ParsedPdfSchema.safeParse(json);
      if (!parsed.success) {
        throw new AiResponseShapeError('pdfparser', parsed.error.message, parsed.error);
      }
      return parsed.data;
    });
  }

  return { parse };
}

export type PdfParserClient = ReturnType<typeof makePdfParserClient>;
