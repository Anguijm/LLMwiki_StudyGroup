import type { PdfParserClient, ParsedPdf } from '../pdfparser';

export interface PdfParserMockOptions {
  parse?: (url: string) => Promise<ParsedPdf>;
}

export function makePdfParserMock(opts: PdfParserMockOptions = {}): PdfParserClient {
  return {
    parse:
      opts.parse ??
      (async () => ({
        blocks: [
          { type: 'heading', text: 'Test PDF', page: 1 },
          { type: 'paragraph', text: 'hello world', page: 1 },
        ],
        page_count: 1,
      })),
  };
}
