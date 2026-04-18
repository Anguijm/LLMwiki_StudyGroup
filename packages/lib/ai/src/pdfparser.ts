// PDF parser wrapper — Reducto (default) with LlamaParse fallback via the
// PDF_PARSER env flag. Both return a normalized ParsedPdf shape with
// Zod-validated response + 30s timeout.
//
// Cost (callsite):
//   parse — Reducto free tier for a 4-user cohort; LlamaParse free up to
//   1000 pages/day. v0 ingest volume (80 PDFs/mo, avg 20 pages) stays
//   inside both free tiers — ~$0/mo.
import { requireEnv } from '@llmwiki/lib-utils/env';
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

const VALID_PARSERS: readonly ParserKind[] = ['reducto', 'llamaparse'];

/**
 * Reads PDF_PARSER from the env, validates it's one of the supported kinds,
 * and returns the matching API key. Only the key that matches the selected
 * parser is required — provisioning both is explicitly NOT required for v0.
 *
 * Uses `.toLocaleLowerCase('en-US')` to avoid locale-dependent case folding
 * (Turkish 'I' etc.).
 *
 * Throws with a specific message for each failure mode:
 *   - PDF_PARSER missing/empty → "PDF_PARSER missing or empty"
 *   - PDF_PARSER set to an unknown value → lists valid values
 *   - selected kind's key missing/empty → names both the parser and the key
 *
 * Called lazily from the Inngest parse step; never at module top level.
 */
export function resolvePdfParser(): { kind: ParserKind; apiKey: string } {
  const raw = requireEnv('PDF_PARSER');
  const kind = raw.toLocaleLowerCase('en-US');
  if (!isParserKind(kind)) {
    throw new Error(
      `PDF_PARSER must be one of ${VALID_PARSERS.map((k) => `'${k}'`).join(', ')} (got '${raw}')`,
    );
  }
  const keyName = kind === 'reducto' ? 'REDUCTO_API_KEY' : 'LLAMAPARSE_API_KEY';
  const apiKey = process.env[keyName];
  if (apiKey === undefined || apiKey === null || apiKey.trim().length === 0) {
    throw new Error(`PDF_PARSER is '${kind}' but ${keyName} is missing or empty`);
  }
  return { kind, apiKey };
}

function isParserKind(v: string): v is ParserKind {
  return (VALID_PARSERS as readonly string[]).includes(v);
}
