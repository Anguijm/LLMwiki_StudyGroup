// Load-bearing tests for the #39 sectioned-persist path. Per CLAUDE.md
// §"Rebutting council findings" rule #2 + council r4 non-negotiable:
// db-tests is continue-on-error (#7) so the cohort-integrity + PII-safety
// proofs must live here at the TS level. The pgTAP suite at
// supabase/tests/notes_section_hierarchy.sql is corroborating only.
//
// Coverage:
//   - simplifySections: per-section Haiku batching, empty-text skip,
//     NO_TEXT_CONTENT → empty.
//   - embedSections: per-section Voyage call, empty/oversized → null.
//   - callInsertNoteWithSectionsRpc:
//     • happy path returns parentId + sectionIds
//     • TOCTOU: 23505 on source_ingestion_id → idempotency hit
//     • cohort_mismatch (P0001) → NonRetriableError + structured log
//     • PII-safety: error log contains job_id/owner_id/cohort_id/
//       errorName only — never body/body_md/title/section_path/text
//       (sentinel-string defense-in-depth)
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NonRetriableError } from 'inngest';
import {
  simplifySections,
  embedSections,
  callInsertNoteWithSectionsRpc,
} from './ingest-pdf-persist';
import type { Section } from './chunker';

function mkSection(overrides: Partial<Section>): Section {
  return {
    index: 0,
    title: 'Section title',
    path: ['Section title'],
    text: 'section body text',
    estimatedTokens: 100,
    ...overrides,
  };
}

describe('simplifySections', () => {
  it('calls anthropic.simplifyBatch once per non-empty section', async () => {
    const simplifyBatch = vi
      .fn()
      .mockResolvedValueOnce({ text: 'simplified A' })
      .mockResolvedValueOnce({ text: 'simplified B' });
    const out = await simplifySections(
      { anthropic: { simplifyBatch } as never },
      [mkSection({ text: 'a' }), mkSection({ index: 1, text: 'b' })],
      'system-prompt',
    );
    expect(out).toEqual(['simplified A', 'simplified B']);
    expect(simplifyBatch).toHaveBeenCalledTimes(2);
  });

  it('skips empty-text sections (no Anthropic call)', async () => {
    const simplifyBatch = vi.fn().mockResolvedValue({ text: 'should not call' });
    const out = await simplifySections(
      { anthropic: { simplifyBatch } as never },
      [mkSection({ text: '' }), mkSection({ index: 1, text: '   \n\t' })],
      'system-prompt',
    );
    expect(out).toEqual(['', '']);
    expect(simplifyBatch).not.toHaveBeenCalled();
  });

  it('returns "" when Claude responds with [[NO_TEXT_CONTENT]]', async () => {
    const simplifyBatch = vi.fn().mockResolvedValue({ text: '[[NO_TEXT_CONTENT]]' });
    const [out] = await simplifySections(
      { anthropic: { simplifyBatch } as never },
      [mkSection({ text: 'real input' })],
      'system-prompt',
    );
    expect(out).toBe('');
  });

  it('returns "" when Claude responds with whitespace-only text', async () => {
    const simplifyBatch = vi.fn().mockResolvedValue({ text: '   \n\t' });
    const [out] = await simplifySections(
      { anthropic: { simplifyBatch } as never },
      [mkSection({ text: 'real input' })],
      'system-prompt',
    );
    expect(out).toBe('');
  });
});

describe('embedSections', () => {
  it('calls voyage.embed once per non-empty simplification', async () => {
    const dims = new Array(1024).fill(0.1);
    const embed = vi.fn().mockResolvedValue(dims);
    const out = await embedSections(
      { voyage: { embed } as never },
      ['simplified A', 'simplified B'],
    );
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual(dims);
    expect(out[1]).toEqual(dims);
    expect(embed).toHaveBeenCalledTimes(2);
  });

  it('returns null for empty simplifications without calling Voyage', async () => {
    const embed = vi.fn();
    const out = await embedSections({ voyage: { embed } as never }, ['']);
    expect(out).toEqual([null]);
    expect(embed).not.toHaveBeenCalled();
  });

  it('returns null for oversized simplifications (> VOYAGE_MAX_EMBED_CHARS)', async () => {
    const embed = vi.fn();
    const oversized = 'x'.repeat(30_001);
    const out = await embedSections({ voyage: { embed } as never }, [oversized]);
    expect(out).toEqual([null]);
    expect(embed).not.toHaveBeenCalled();
  });
});

describe('callInsertNoteWithSectionsRpc — happy path', () => {
  it('calls supabase.rpc("insert_note_with_sections") and returns parentId + sectionIds', async () => {
    const rpcResult = {
      data: { parent_id: 'parent-uuid', section_ids: ['s1', 's2'] },
      error: null,
    };
    const rpc = vi.fn().mockResolvedValue(rpcResult);
    const supabase = { rpc } as never;
    const result = await callInsertNoteWithSectionsRpc(
      { supabase },
      {
        jobId: 'job-1',
        ownerId: 'owner-1',
        cohortId: 'cohort-1',
        title: 'Doc',
        sections: [
          mkSection({ index: 0, title: 'A', path: ['A'] }),
          mkSection({ index: 1, title: 'B', path: ['B'] }),
        ],
        simplifications: ['body A', 'body B'],
        embeddings: [null, null],
      },
    );
    expect(result.parentId).toBe('parent-uuid');
    expect(result.sectionIds).toEqual(['s1', 's2']);
    expect(result.idempotencyHit).toBe(false);
    expect(rpc).toHaveBeenCalledOnce();
    const [fnName, payload] = rpc.mock.calls[0]!;
    expect(fnName).toBe('insert_note_with_sections');
    expect(payload).toMatchObject({
      parent: expect.objectContaining({
        source_ingestion_id: 'job-1',
        cohort_id: 'cohort-1',
        author_id: 'owner-1',
      }),
      sections: [
        expect.objectContaining({
          cohort_id: 'cohort-1',
          author_id: 'owner-1',
          section_path: ['A'],
        }),
        expect.objectContaining({
          cohort_id: 'cohort-1',
          author_id: 'owner-1',
          section_path: ['B'],
        }),
      ],
    });
  });

  it('handles RPC returning data as an array (PostgREST convention)', async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: [{ parent_id: 'p', section_ids: ['s'] }],
      error: null,
    });
    const result = await callInsertNoteWithSectionsRpc(
      { supabase: { rpc } as never },
      {
        jobId: 'job-1',
        ownerId: 'o',
        cohortId: 'c',
        title: 'T',
        sections: [mkSection({})],
        simplifications: ['x'],
        embeddings: [null],
      },
    );
    expect(result.parentId).toBe('p');
    expect(result.sectionIds).toEqual(['s']);
  });
});

describe('callInsertNoteWithSectionsRpc — idempotency (council r2 TOCTOU fold)', () => {
  it('treats 23505 on source_ingestion_id as a successful idempotency hit', async () => {
    // First call: RPC fails with unique-constraint violation.
    const rpc = vi.fn().mockResolvedValue({
      data: null,
      error: {
        code: '23505',
        message:
          'duplicate key value violates unique constraint "notes_source_ingestion_id_key"',
      },
    });

    // Idempotency lookup: parent + 2 children already exist.
    const eqSingle = vi
      .fn()
      .mockResolvedValueOnce({ data: { id: 'existing-parent' }, error: null });
    const eqList = vi.fn().mockResolvedValueOnce({
      data: [{ id: 'existing-s1' }, { id: 'existing-s2' }],
      error: null,
    });
    const fromSelect = vi.fn().mockImplementation(() => ({
      select: () => ({
        eq: (col: string) =>
          col === 'source_ingestion_id'
            ? { single: eqSingle }
            : { single: eqSingle, then: undefined, ...eqList(), then2: eqList },
      }),
    }));

    // Build the supabase mock using a chain pattern: from(table).select(cols).eq(col, val).single() OR .eq(col, val) returning rows.
    const from = vi.fn((table: string) => {
      void table;
      return {
        select: () => ({
          eq: (col: string) => {
            if (col === 'source_ingestion_id') {
              return { single: eqSingle };
            }
            // parent_note_id lookup returns a thenable resolving to a list.
            return eqList();
          },
        }),
      };
    });
    void fromSelect;

    const supabase = { rpc, from } as never;
    const result = await callInsertNoteWithSectionsRpc(
      { supabase },
      {
        jobId: 'job-1',
        ownerId: 'o',
        cohortId: 'c',
        title: 'T',
        sections: [mkSection({})],
        simplifications: ['x'],
        embeddings: [null],
      },
    );
    expect(result.idempotencyHit).toBe(true);
    expect(result.parentId).toBe('existing-parent');
    expect(result.sectionIds).toEqual(['existing-s1', 'existing-s2']);
    expect(rpc).toHaveBeenCalledOnce();
  });
});

describe('callInsertNoteWithSectionsRpc — cohort-integrity + PII (council r3+r4 folds)', () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  // PII sentinel: every test in this block uses these strings as the
  // section's title / body / path. The defense-in-depth assertions then
  // confirm none of these strings appears anywhere in any console.error
  // payload, even after future field renames or accidental logging.
  const PII_TITLE = 'PII_SENTINEL_TITLE_XYZZY';
  const PII_BODY = 'PII_SENTINEL_BODY_FOOBAR';
  const PII_PATH = 'PII_SENTINEL_PATH_QUUX';

  function piiSentinelArgs() {
    return {
      jobId: 'job-pii',
      ownerId: 'owner-pii',
      cohortId: 'cohort-pii',
      title: PII_TITLE,
      sections: [
        mkSection({
          index: 0,
          title: PII_TITLE,
          path: [PII_PATH],
          text: PII_BODY,
        }),
      ],
      simplifications: [PII_BODY],
      embeddings: [null],
    };
  }

  it('throws NonRetriableError on section_note_cohort_mismatch (P0001)', async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: null,
      error: {
        code: 'P0001',
        message:
          'section_note_cohort_mismatch: parent_cohort=11111111-1111-1111-1111-111111111111, section_cohort=22222222-2222-2222-2222-222222222222, parent_id=ccc',
      },
    });
    await expect(
      callInsertNoteWithSectionsRpc({ supabase: { rpc } as never }, piiSentinelArgs()),
    ).rejects.toBeInstanceOf(NonRetriableError);
  });

  it('logs structured error with high-signal fields ONLY on cohort_mismatch', async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: null,
      error: { code: 'P0001', message: 'section_note_cohort_mismatch: ...' },
    });
    await expect(
      callInsertNoteWithSectionsRpc({ supabase: { rpc } as never }, piiSentinelArgs()),
    ).rejects.toBeInstanceOf(NonRetriableError);
    expect(consoleErrorSpy).toHaveBeenCalledOnce();
    const [_msg, ctx] = consoleErrorSpy.mock.calls[0]!;
    expect(ctx).toMatchObject({
      alert: true,
      tier: 'ingest_pdf_persist',
      errorName: 'section_note_cohort_mismatch',
      errorCode: 'P0001',
      job_id: 'job-pii',
      owner_id: 'owner-pii',
      cohort_id: 'cohort-pii',
    });
  });

  it('NEVER includes PII fields (body, body_md, section_path, title, text) in error logs', async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: null,
      error: { code: 'P0001', message: 'section_note_cohort_mismatch: ...' },
    });
    await expect(
      callInsertNoteWithSectionsRpc({ supabase: { rpc } as never }, piiSentinelArgs()),
    ).rejects.toBeInstanceOf(NonRetriableError);
    const [_msg, ctx] = consoleErrorSpy.mock.calls[0]!;
    // Explicit per-field absence assertions.
    expect(ctx).not.toHaveProperty('body');
    expect(ctx).not.toHaveProperty('body_md');
    expect(ctx).not.toHaveProperty('section_path');
    expect(ctx).not.toHaveProperty('title');
    expect(ctx).not.toHaveProperty('text');
    // Sentinel-string defense-in-depth: serialize ANY captured arg and
    // assert no PII string slipped in via a future field rename.
    const allArgs = JSON.stringify(consoleErrorSpy.mock.calls);
    expect(allArgs).not.toContain(PII_TITLE);
    expect(allArgs).not.toContain(PII_BODY);
    expect(allArgs).not.toContain(PII_PATH);
  });

  it('NEVER includes PII fields in any-trigger-violation log (parent_cohort_mutation, self_parent)', async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: null,
      error: {
        code: 'P0001',
        message: 'section_note_parent_cohort_mutation: id=abc, child_count=2, ...',
      },
    });
    await expect(
      callInsertNoteWithSectionsRpc({ supabase: { rpc } as never }, piiSentinelArgs()),
    ).rejects.toBeInstanceOf(NonRetriableError);
    const allArgs = JSON.stringify(consoleErrorSpy.mock.calls);
    expect(allArgs).not.toContain(PII_TITLE);
    expect(allArgs).not.toContain(PII_BODY);
    expect(allArgs).not.toContain(PII_PATH);
    // The errorName field captured the trigger's identifying token.
    const [, ctx] = consoleErrorSpy.mock.calls[0]!;
    expect(ctx).toMatchObject({ errorName: 'section_note_parent_cohort_mutation' });
  });

  it('rethrows non-trigger errors as-is (no structured log, no NonRetriable)', async () => {
    const oddError = { code: '99999', message: 'unexpected DB error' };
    const rpc = vi.fn().mockResolvedValue({ data: null, error: oddError });
    await expect(
      callInsertNoteWithSectionsRpc({ supabase: { rpc } as never }, piiSentinelArgs()),
    ).rejects.toMatchObject({ code: '99999' });
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });
});
