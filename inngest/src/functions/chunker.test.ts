import { describe, it, expect } from 'vitest';
import {
  chunkParsed,
  MAX_SECTIONS,
  MAX_SECTION_TOKENS,
  SECTION_TARGET_TOKENS,
  CONTINUATION_SUFFIX,
  TooManyChunksError,
  SectionTooLargeError,
} from './chunker';
import type { ParsedPdf } from '@llmwiki/lib-ai/pdfparser';

const NULL_BYTE = String.fromCharCode(0);

function mkPdf(blocks: ParsedPdf['blocks']): ParsedPdf {
  return { blocks, page_count: 1 };
}

describe('chunker — heading boundaries', () => {
  it('splits at every heading and carries title + path', () => {
    const sections = chunkParsed(
      mkPdf([
        { type: 'heading', text: 'Intro' },
        { type: 'paragraph', text: 'a'.repeat(200) },
        { type: 'heading', text: 'Body' },
        { type: 'paragraph', text: 'b'.repeat(200) },
      ]),
    );
    expect(sections).toHaveLength(2);
    expect(sections[0]?.title).toBe('Intro');
    expect(sections[0]?.path).toEqual(['Intro']);
    expect(sections[0]?.text).toContain('aaa');
    expect(sections[1]?.title).toBe('Body');
    expect(sections[1]?.path).toEqual(['Body']);
  });

  it('builds hierarchical path from heading_N type strings', () => {
    const sections = chunkParsed(
      mkPdf([
        { type: 'heading_1', text: 'Chapter 1' },
        { type: 'paragraph', text: 'intro' },
        { type: 'heading_2', text: 'Section 1.1' },
        { type: 'paragraph', text: 'sec body' },
        { type: 'heading_3', text: 'Subsection 1.1.a' },
        { type: 'paragraph', text: 'sub body' },
        { type: 'heading_2', text: 'Section 1.2' },
        { type: 'paragraph', text: 'next sec' },
      ]),
    );
    // Each heading opens its own section; path reflects the active stack.
    expect(sections.map((s) => s.path)).toEqual([
      ['Chapter 1'],
      ['Chapter 1', 'Section 1.1'],
      ['Chapter 1', 'Section 1.1', 'Subsection 1.1.a'],
      ['Chapter 1', 'Section 1.2'],
    ]);
  });

  it('preserves special characters in heading text without escaping', () => {
    const sections = chunkParsed(
      mkPdf([
        { type: 'heading', text: 'Files / Paths \\ Slashes "quoted" 🚀' },
        { type: 'paragraph', text: 'body' },
      ]),
    );
    expect(sections[0]?.title).toBe('Files / Paths \\ Slashes "quoted" 🚀');
    expect(sections[0]?.path).toEqual(['Files / Paths \\ Slashes "quoted" 🚀']);
  });
});

describe('chunker — edge cases', () => {
  it('returns [] for an empty or whitespace-only doc', () => {
    expect(chunkParsed(mkPdf([]))).toHaveLength(0);
    expect(chunkParsed(mkPdf([{ type: 'paragraph', text: '   \n\t' }]))).toHaveLength(0);
  });

  it('strips null bytes from heading and body text before persisting', () => {
    const sections = chunkParsed(
      mkPdf([
        { type: 'heading', text: `Title${NULL_BYTE}With${NULL_BYTE}Nulls` },
        { type: 'paragraph', text: `body${NULL_BYTE}content${NULL_BYTE}` },
      ]),
    );
    expect(sections[0]?.title).toBe('TitleWithNulls');
    expect(sections[0]?.text).toBe('bodycontent');
    expect(sections[0]?.title).not.toContain(NULL_BYTE);
    expect(sections[0]?.text).not.toContain(NULL_BYTE);
  });

  it('emits a heading-only section even when the body is empty', () => {
    const sections = chunkParsed(
      mkPdf([
        { type: 'heading', text: 'Empty Section' },
        { type: 'heading', text: 'Next' },
        { type: 'paragraph', text: 'next body' },
      ]),
    );
    expect(sections[0]?.title).toBe('Empty Section');
    expect(sections[0]?.text).toBe('');
    expect(sections[0]?.estimatedTokens).toBe(0);
  });

  it('drops blocks that are entirely whitespace', () => {
    const sections = chunkParsed(
      mkPdf([
        { type: 'heading', text: 'H' },
        { type: 'paragraph', text: '   ' },
        { type: 'paragraph', text: 'real text' },
      ]),
    );
    expect(sections).toHaveLength(1);
    expect(sections[0]?.text).toContain('real text');
  });
});

describe('chunker — caps + length fallback', () => {
  it('throws TooManyChunksError above MAX_SECTIONS', () => {
    const blocks: ParsedPdf['blocks'] = [];
    for (let i = 0; i < MAX_SECTIONS + 1; i++) {
      blocks.push({ type: 'heading', text: `H${i}` });
      blocks.push({ type: 'paragraph', text: 'x'.repeat(100) });
    }
    expect(() => chunkParsed(mkPdf(blocks))).toThrow(TooManyChunksError);
  });

  it('throws SectionTooLargeError when a single section exceeds MAX_SECTION_TOKENS', () => {
    // Build a single heading + one paragraph above the hard ceiling
    // (MAX_SECTION_TOKENS * 4 chars ≈ 200_000). The length-fallback path
    // can't split a single paragraph, so the ceiling fires.
    const giantParagraph = 'z'.repeat(MAX_SECTION_TOKENS * 4 + 10);
    const blocks: ParsedPdf['blocks'] = [
      { type: 'heading', text: 'Giant' },
      { type: 'paragraph', text: giantParagraph },
    ];
    expect(() => chunkParsed(mkPdf(blocks))).toThrow(SectionTooLargeError);
  });

  it('length-fallback splits an oversized no-heading doc at paragraph boundaries', () => {
    // No headings → 1 section above SECTION_TARGET_TOKENS. Many small
    // paragraphs let the splitter create multiple sections that each fit.
    const paragraphChars = 4_000; // 1k tokens each
    const paragraphs: string[] = [];
    for (let i = 0; i < 40; i++) {
      paragraphs.push('p' + i + '-' + 'a'.repeat(paragraphChars - 5));
    }
    // Single paragraph block per blocks entry; chunker joins with \n\n.
    const blocks: ParsedPdf['blocks'] = paragraphs.map((p) => ({
      type: 'paragraph',
      text: p,
    }));
    const sections = chunkParsed(mkPdf(blocks));
    // Single concatenated section was ~40k tokens > SECTION_TARGET_TOKENS,
    // so the fallback splits it; expect more than 1 section.
    expect(sections.length).toBeGreaterThan(1);
    for (const s of sections) {
      expect(s.estimatedTokens).toBeLessThanOrEqual(SECTION_TARGET_TOKENS);
    }
    // Fallback titles: first section keeps null (no heading was seen);
    // later sections inherit null too because there was no original title.
    expect(sections[0]?.title).toBeNull();
  });

  it('length-fallback marks "(cont.)" on continuation when an original title exists', () => {
    // Single heading then a body that needs splitting. Fallback only fires
    // when sections.length <= 1 — which is true here (1 section above
    // SECTION_TARGET_TOKENS). The first chunk keeps the original title;
    // subsequent chunks suffix " (cont.)".
    const paragraphs = Array.from({ length: 40 }, (_, i) => 'p' + i + '-' + 'a'.repeat(3995));
    const blocks: ParsedPdf['blocks'] = [
      { type: 'heading', text: 'Original Title' },
      ...paragraphs.map((p) => ({ type: 'paragraph' as const, text: p })),
    ];
    const sections = chunkParsed(mkPdf(blocks));
    expect(sections.length).toBeGreaterThan(1);
    expect(sections[0]?.title).toBe('Original Title');
    // Council r5 [a11y] fold: continuation suffix comes from the
    // exported CONTINUATION_SUFFIX constant, not a hardcoded literal,
    // so an i18n layer can substitute a localized string at runtime.
    expect(sections[1]?.title).toBe(`Original Title${CONTINUATION_SUFFIX}`);
    expect(CONTINUATION_SUFFIX).toBe(' (cont.)');
    // Path is preserved on continuation chunks.
    expect(sections[1]?.path).toEqual(['Original Title']);
  });
});
