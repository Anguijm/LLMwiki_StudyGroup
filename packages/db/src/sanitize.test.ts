import { describe, it, expect } from 'vitest';
import { sanitizeUserText, sanitizeNoteTitle, sanitizeFilename, NOTE_TITLE_MAX } from './sanitize';

describe('sanitizeUserText', () => {
  it('strips null bytes', () => {
    expect(sanitizeUserText('hello\0world', 100)).toBe('helloworld');
  });

  it('strips C0 controls except \\t \\n \\r', () => {
    const input = 'a\x01b\x07c\x08d\te\nf\rg\x0bh\x1fi';
    expect(sanitizeUserText(input, 100)).toBe('abcd\te\nf\rghi');
  });

  it('strips C1 controls (\\x80..\\x9f)', () => {
    expect(sanitizeUserText('a\x85b\x9fc', 100)).toBe('abc');
  });

  it('NFC-normalizes so visually-identical strings collapse', () => {
    // "é" as precomposed (U+00E9) vs decomposed (U+0065 U+0301).
    const precomposed = '\u00e9';
    const decomposed = 'e\u0301';
    expect(sanitizeUserText(decomposed, 100)).toBe(precomposed);
  });

  it('enforces max length after stripping + normalizing', () => {
    const input = '\0\0\0\0\0' + 'x'.repeat(1000);
    const out = sanitizeUserText(input, 10);
    expect(out).toBe('xxxxxxxxxx');
  });

  it('does not trim whitespace (callers decide)', () => {
    expect(sanitizeUserText('   hello   ', 100)).toBe('   hello   ');
  });

  it('sanitizeNoteTitle enforces NOTE_TITLE_MAX', () => {
    expect(sanitizeNoteTitle('a'.repeat(1000))).toHaveLength(NOTE_TITLE_MAX);
  });
});

describe('sanitizeFilename', () => {
  it('drops path separators', () => {
    expect(sanitizeFilename('../../../etc/passwd')).toBe('___________etc_passwd');
  });

  it('drops null bytes and control chars', () => {
    expect(sanitizeFilename('f\0o\x07o.pdf')).toBe('f_o_o.pdf');
  });

  it('replaces leading dots so hidden files cannot be produced', () => {
    expect(sanitizeFilename('..hidden')).toBe('_hidden');
    expect(sanitizeFilename('.env')).toBe('_env');
  });

  it('keeps safe filenames intact', () => {
    expect(sanitizeFilename('Lecture-01.pdf')).toBe('Lecture-01.pdf');
  });
});
