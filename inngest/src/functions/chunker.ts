// Semantic chunker — splits a parsed PDF into per-section units that the
// ingest pipeline persists as one notes row each (issue #39 phase 2).
//
// Boundary detection priority:
//   1. Heading-based — every block whose `type` matches /^heading/i opens
//      a new section. Heading "level" is parsed from the type string
//      (`heading_2` → level 2; bare `heading` → level 1) and pushed onto
//      a stack so each section's `path` is the active heading hierarchy.
//   2. Length fallback — after the heading pass, if the doc collapsed to
//      0 or 1 sections AND that section exceeds SECTION_TARGET_TOKENS
//      (60% of Haiku 200k input), split at paragraph boundaries.
//   3. Hard ceiling — any single section above MAX_SECTION_TOKENS
//      throws SectionTooLargeError (handled upstream as
//      pdf_section_too_large). MAX_SECTIONS caps the total count.
//
// Council folds applied here:
//   - Null bytes (`\0`) stripped from every text input before measurement
//     or storage (council r3 [bugs] edge case).
//   - title:null is a valid Section (empty heading or fallback split
//     continuation); downstream renderer handles the absence.
//   - Heading text containing '/', '\', '"', emoji preserved verbatim;
//     `path` is string[] (jsonb), no separator escaping needed.

import type { ParsedPdf } from '@llmwiki/lib-ai/pdfparser';

export const MAX_SECTIONS = 200;
export const SECTION_TARGET_TOKENS = 30_000;  // 60% of Haiku 200k input
export const MAX_SECTION_TOKENS = 50_000;     // hard per-section ceiling
const CHARS_PER_TOKEN = 4;                    // conservative English estimate

export interface Section {
  index: number;
  title: string | null;
  path: string[];
  text: string;
  estimatedTokens: number;
}

export class TooManyChunksError extends Error {
  override readonly name = 'TooManyChunksError';
  constructor(public readonly produced: number) {
    super(`chunker produced ${produced} sections; cap is ${MAX_SECTIONS}`);
  }
}

export class SectionTooLargeError extends Error {
  override readonly name = 'SectionTooLargeError';
  constructor(public readonly sectionIndex: number, public readonly tokens: number) {
    super(
      `section ${sectionIndex} estimated ${tokens} tokens; cap is ${MAX_SECTION_TOKENS}`,
    );
  }
}

// String.fromCharCode(0) (= U+0000 NULL) used instead of a literal
// escape in the regex to keep the source byte-clean. Council r3
// [bugs] edge case: PDF parsers occasionally emit \0 in extracted
// text and Postgres rejects it on insert; strip at the chunker
// boundary.
const NULL_BYTE = String.fromCharCode(0);
function stripNullBytes(s: string): string {
  return s.split(NULL_BYTE).join('');
}

function parseHeadingLevel(type: string): number {
  if (!/^heading/i.test(type)) return 0;
  const m = type.match(/heading[_\-\s]?(\d+)/i);
  return m && m[1] ? Math.max(1, parseInt(m[1], 10)) : 1;
}

function tokensForChars(charCount: number): number {
  return Math.ceil(charCount / CHARS_PER_TOKEN);
}

export function chunkParsed(parsed: ParsedPdf): Section[] {
  const sections: Section[] = [];

  // Heading stack tracks (level, text) so each new section's `path` is
  // the active hierarchy. Popping happens when we see a heading at the
  // same-or-shallower level (a sibling or ancestor takes the floor).
  const headingStack: { level: number; text: string }[] = [];

  let buffer: string[] = [];
  let bufferTokens = 0;
  let currentTitle: string | null = null;
  let currentPath: string[] = [];

  const flush = () => {
    if (buffer.length === 0 && currentTitle === null) return;
    const text = buffer.join('\n\n').trim();
    sections.push({
      index: sections.length,
      title: currentTitle,
      path: [...currentPath],
      text,
      estimatedTokens: bufferTokens,
    });
    if (sections.length > MAX_SECTIONS) {
      throw new TooManyChunksError(sections.length);
    }
    buffer = [];
    bufferTokens = 0;
  };

  for (const block of parsed.blocks) {
    const text = stripNullBytes(block.text).trim();
    if (!text) continue;

    const level = parseHeadingLevel(block.type);

    if (level > 0) {
      flush();
      while (
        headingStack.length > 0 &&
        headingStack[headingStack.length - 1]!.level >= level
      ) {
        headingStack.pop();
      }
      headingStack.push({ level, text });
      currentTitle = text;
      currentPath = headingStack.map((h) => h.text);
      continue;
    }

    buffer.push(text);
    bufferTokens += tokensForChars(text.length);
  }

  flush();

  // Length fallback: doc has no usable heading structure but is still
  // large. Split the single section at paragraph boundaries so each
  // chunk fits within SECTION_TARGET_TOKENS.
  let result = sections;
  if (
    sections.length <= 1 &&
    sections[0] &&
    sections[0].estimatedTokens > SECTION_TARGET_TOKENS
  ) {
    result = splitOversized(sections[0]);
    if (result.length > MAX_SECTIONS) {
      throw new TooManyChunksError(result.length);
    }
  }

  for (const s of result) {
    if (s.estimatedTokens > MAX_SECTION_TOKENS) {
      throw new SectionTooLargeError(s.index, s.estimatedTokens);
    }
  }

  return result;
}

// Paragraph-split a single oversized section. Preserves title/path on
// the first chunk; subsequent chunks carry a "(cont.)" suffix on the
// title and the same path so downstream consumers can group them.
function splitOversized(section: Section): Section[] {
  const paragraphs = section.text.split(/\n{2,}/).filter((p) => p.trim().length > 0);
  if (paragraphs.length <= 1) {
    // Single oversized paragraph — can't split further. Return as-is and
    // let the MAX_SECTION_TOKENS ceiling catch it upstream.
    return [section];
  }

  const out: Section[] = [];
  let buf: string[] = [];
  let bufTokens = 0;
  let chunkIndex = 0;

  const emit = () => {
    if (buf.length === 0) return;
    const text = buf.join('\n\n');
    out.push({
      index: out.length,
      title:
        chunkIndex === 0
          ? section.title
          : section.title
            ? `${section.title} (cont.)`
            : null,
      path: section.path,
      text,
      estimatedTokens: bufTokens,
    });
    buf = [];
    bufTokens = 0;
    chunkIndex += 1;
  };

  for (const para of paragraphs) {
    const paraTokens = tokensForChars(para.length);
    if (bufTokens > 0 && bufTokens + paraTokens > SECTION_TARGET_TOKENS) {
      emit();
    }
    buf.push(para);
    bufTokens += paraTokens;
  }
  emit();

  return out;
}
