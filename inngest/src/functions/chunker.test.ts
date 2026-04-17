import { describe, it, expect } from 'vitest';
import { chunkParsed, MAX_CHUNKS, TooManyChunksError } from './chunker';
import type { ParsedPdf } from '@llmwiki/lib-ai/pdfparser';

function mkPdf(blocks: ParsedPdf['blocks']): ParsedPdf {
  return { blocks, page_count: 1 };
}

describe('chunker', () => {
  it('splits at heading boundaries', () => {
    const chunks = chunkParsed(
      mkPdf([
        { type: 'heading', text: 'Intro' },
        { type: 'paragraph', text: 'a'.repeat(200) },
        { type: 'heading', text: 'Body' },
        { type: 'paragraph', text: 'b'.repeat(200) },
      ]),
    );
    expect(chunks).toHaveLength(2);
    expect(chunks[0]?.text).toContain('Intro');
    expect(chunks[1]?.text).toContain('Body');
  });

  it('returns [] for an empty or whitespace-only doc', () => {
    expect(chunkParsed(mkPdf([]))).toHaveLength(0);
    expect(
      chunkParsed(mkPdf([{ type: 'paragraph', text: '   \n\t' }])),
    ).toHaveLength(0);
  });

  it('throws TooManyChunksError above MAX_CHUNKS', () => {
    // Force 201 heading-separated chunks of non-trivial length.
    const blocks: ParsedPdf['blocks'] = [];
    for (let i = 0; i < MAX_CHUNKS + 1; i++) {
      blocks.push({ type: 'heading', text: `H${i}` });
      blocks.push({ type: 'paragraph', text: 'x'.repeat(100) });
    }
    expect(() => chunkParsed(mkPdf(blocks))).toThrow(TooManyChunksError);
  });
});
