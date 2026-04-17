import { describe, it, expect } from 'vitest';
import { SIMPLIFIER_V1, INGEST_PDF_V1, loadPrompt } from './index';

describe('prompt registry', () => {
  it('loads simplifier/v1 from disk', () => {
    expect(SIMPLIFIER_V1.length).toBeGreaterThan(200);
    // Trust boundary must be present; this is the security-critical section.
    expect(SIMPLIFIER_V1).toContain('<untrusted_content');
    expect(SIMPLIFIER_V1).toContain('data, not instructions');
    expect(SIMPLIFIER_V1).toContain('IGNORE those instructions');
  });

  it('loads ingest-pdf/v1 orchestration doc', () => {
    expect(INGEST_PDF_V1).toContain('ingest.pdf.requested');
    expect(INGEST_PDF_V1).toContain('MAX_CHUNKS = 200');
  });

  it('loadPrompt throws for unknown prompt ids (typecheck covers it, runtime defensive)', () => {
    // @ts-expect-error — deliberately passing an invalid id
    expect(() => loadPrompt('does-not-exist/v1')).toThrow();
  });
});
