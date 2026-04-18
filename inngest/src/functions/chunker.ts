// Heading-aware PDF chunker. Walks the parser's `blocks` output, emits
// chunks that respect heading boundaries and stay under a target token
// budget.
//
// Hard cap: MAX_CHUNKS = 200. Exceeding fails the job with
// pdf_too_many_chunks — no silent truncation.

import type { ParsedPdf } from '@llmwiki/lib-ai/pdfparser';

export const MAX_CHUNKS = 200;
export const CHUNK_TARGET_TOKENS = 1200;
const CHARS_PER_TOKEN = 4; // conservative English estimate

export interface Chunk {
  index: number;
  text: string;
  estimatedTokens: number;
}

export class TooManyChunksError extends Error {
  override readonly name = 'TooManyChunksError';
  constructor(public readonly produced: number) {
    super(`chunker produced ${produced} chunks; cap is ${MAX_CHUNKS}`);
  }
}

export function chunkParsed(parsed: ParsedPdf): Chunk[] {
  const chunks: Chunk[] = [];
  let buffer: string[] = [];
  let bufferTokens = 0;

  const flush = () => {
    if (buffer.length === 0) return;
    const text = buffer.join('\n\n').trim();
    if (text) {
      chunks.push({ index: chunks.length, text, estimatedTokens: bufferTokens });
      if (chunks.length > MAX_CHUNKS) {
        throw new TooManyChunksError(chunks.length);
      }
    }
    buffer = [];
    bufferTokens = 0;
  };

  for (const block of parsed.blocks) {
    const text = block.text.trim();
    if (!text) continue;
    const isHeading = /^heading/i.test(block.type);
    const blockTokens = Math.ceil(text.length / CHARS_PER_TOKEN);

    if (isHeading && bufferTokens > 0) flush();

    buffer.push(isHeading ? `\n## ${text}\n` : text);
    bufferTokens += blockTokens;

    if (bufferTokens >= CHUNK_TARGET_TOKENS) flush();
  }

  flush();
  return chunks;
}
