// #39 phase 3b helpers — sectioned-persist primitives extracted from
// ingest-pdf.ts so the load-bearing tests (council r4 non-negotiable)
// can import them without dragging the server-only supabaseService
// transitive dependency in. The Inngest function in ingest-pdf.ts
// re-exports + composes these helpers; this file is pure logic +
// vendor-client interfaces.
import { createHash } from 'node:crypto';
import { NonRetriableError } from 'inngest';
import slugify from 'slugify';
import type { Section } from './chunker';
import { sanitizeNoteTitle } from '@llmwiki/db/sanitize';
import type { makeAnthropicClient, makeVoyageClient } from '@llmwiki/lib-ai';

export const VOYAGE_MAX_EMBED_CHARS = 30_000;

// Minimal Supabase surface the helpers need. Tests inject mocks shaped
// like this; production passes the real supabaseService() return value.
// Kept as a structural type to avoid pulling in @llmwiki/db/server (which
// imports 'server-only' and would prevent the test file from loading).
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- structural
export type SupabaseLike = any;

export const SIMPLIFIER_SYSTEM_PROMPT_REF = 'simplifier:v1';

// Cost (callsite):
//   simplifySections — Haiku, ~10k tokens in + ~2k tokens out per section.
//   At 80 ingests/mo × 10 sections avg = 800 calls/mo ≈ $13/mo.
//   Per-section batching (1 section per call) is intentional: section
//   sizes (up to 30k tokens each) are too large to batch the way the
//   single-note path does (8 chunks of 1.2k each).
export async function simplifySections(
  deps: { anthropic: ReturnType<typeof makeAnthropicClient> },
  sections: Section[],
  systemPrompt: string,
): Promise<string[]> {
  return Promise.all(
    sections.map(async (s) => {
      // Skip empty-text sections (heading-only). The downstream
      // flashcard-gen handler short-circuits on empty body, so persisting
      // the structural placeholder is fine.
      if (s.text.trim().length === 0) return '';
      const { text } = await deps.anthropic.simplifyBatch({
        systemPrompt,
        chunks: [s.text],
      });
      // Treat NO_TEXT_CONTENT or empty/whitespace as "this section has
      // no usable simplified content." Downstream renderer handles ''.
      if (text.includes('[[NO_TEXT_CONTENT]]') || text.trim().length === 0) {
        return '';
      }
      return text;
    }),
  );
}

// Cost (callsite):
//   embedSections — Voyage-3, 1 call per non-empty simplified section,
//   $0.0001 per call. 800 sections/mo ≈ $0.08/mo.
export async function embedSections(
  deps: { voyage: ReturnType<typeof makeVoyageClient> },
  simplifications: string[],
): Promise<(number[] | null)[]> {
  return Promise.all(
    simplifications.map(async (text) => {
      if (text.length === 0) return null;
      if (text.length > VOYAGE_MAX_EMBED_CHARS) return null;
      return deps.voyage.embed(text);
    }),
  );
}

export interface SectionedPersistArgs {
  jobId: string;
  ownerId: string;
  cohortId: string;
  title: string;
  sections: Section[];
  simplifications: string[];
  embeddings: (number[] | null)[];
}

export interface SectionedPersistResult {
  parentId: string;
  sectionIds: string[];
  idempotencyHit: boolean;
}

export function makeSlugCandidate(
  rawTitle: string,
  hashSeed: string,
  hashLen: number,
): string {
  let base: string;
  try {
    base = slugify(rawTitle, { lower: true, strict: true, locale: 'en' });
  } catch {
    base = '';
  }
  const hash = createHash('sha256').update(hashSeed).digest('hex');
  const suffix = hash.slice(0, hashLen);
  return base.length > 0 ? `${base}-${suffix}` : `-${suffix}`;
}

export async function callInsertNoteWithSectionsRpc(
  deps: { supabase: SupabaseLike },
  args: SectionedPersistArgs,
): Promise<SectionedPersistResult> {
  const { supabase } = deps;
  const { jobId, ownerId, cohortId, title, sections, simplifications, embeddings } =
    args;

  // Build parent payload. body_md is the joined simplified text from all
  // sections; the parent acts as a navigation node + whole-doc search
  // fallback (plan §"Open questions" #1 default: retain full body).
  const parentJoined = simplifications.filter((t) => t.length > 0).join('\n\n');

  const parentId = (globalThis as { crypto?: { randomUUID(): string } }).crypto!.randomUUID();
  const parent = {
    id: parentId,
    slug: makeSlugCandidate(title, parentId, 6),
    title: sanitizeNoteTitle(title),
    body_md: parentJoined,
    tier: 'active' as const,
    author_id: ownerId,
    cohort_id: cohortId,
    embedding: null as number[] | null,
    source_ingestion_id: jobId,
  };

  const sectionPayloads = sections.map((s, i) => {
    const sectionId = (globalThis as { crypto?: { randomUUID(): string } }).crypto!.randomUUID();
    const titleForSlug = s.title ?? `section-${i + 1}`;
    return {
      id: sectionId,
      slug: makeSlugCandidate(titleForSlug, sectionId, 6),
      title: sanitizeNoteTitle(s.title ?? `Section ${i + 1}`),
      body_md: simplifications[i] ?? '',
      tier: 'active' as const,
      author_id: ownerId,
      cohort_id: cohortId,
      embedding: embeddings[i] ?? null,
      section_path: s.path,
    };
  });

  const { data, error } = await supabase.rpc('insert_note_with_sections', {
    parent,
    sections: sectionPayloads,
  });

  if (error) {
    const errMsg = String(error.message ?? '');
    // Council r2 [bugs] TOCTOU fold: a concurrent runner already
    // persisted the hierarchy. The unique constraint on
    // source_ingestion_id catches the race; treat as a successful
    // idempotency hit by reading the existing rows.
    if (error.code === '23505' && errMsg.includes('source_ingestion_id')) {
      return await findExistingHierarchy(supabase, jobId);
    }
    // Council r3 [bugs] error-surfacing fold: trigger violations
    // (section_note_cohort_mismatch + parent_cohort_mutation +
    // self_parent + missing parent) raise P0001. Surface as a
    // structured log with high-signal fields ONLY (no PII). Always
    // non-retryable: a deterministic data-shape failure won't recover
    // on retry.
    if (error.code === 'P0001' && errMsg.includes('section_note')) {
      const errorName = errMsg.split(':')[0]?.trim() ?? 'section_note_violation';
      // eslint-disable-next-line no-console
      console.error('[ingest-pdf] persist trigger violation', {
        alert: true,
        tier: 'ingest_pdf_persist',
        errorName,
        errorCode: error.code,
        job_id: jobId,
        owner_id: ownerId,
        cohort_id: cohortId,
      });
      throw new NonRetriableError(
        `persist trigger violation on job ${jobId}: ${errorName}`,
      );
    }
    throw error;
  }

  // RPC returns `table (parent_id uuid, section_ids uuid[])`. PostgREST
  // surfaces this as a single object or an array of one — handle both.
  const row = Array.isArray(data) ? data[0] : data;
  if (!row || !row.parent_id) {
    throw new Error('insert_note_with_sections returned no parent_id');
  }
  return {
    parentId: row.parent_id as string,
    sectionIds: ((row.section_ids as string[] | null | undefined) ?? []),
    idempotencyHit: false,
  };
}

async function findExistingHierarchy(
  supabase: SupabaseLike,
  jobId: string,
): Promise<SectionedPersistResult> {
  const { data: parent, error: pe } = await supabase
    .from('notes')
    .select('id')
    .eq('source_ingestion_id', jobId)
    .single();
  if (pe || !parent) {
    throw pe ?? new Error('idempotency lookup: parent not found despite 23505');
  }
  const { data: children } = await supabase
    .from('notes')
    .select('id')
    .eq('parent_note_id', parent.id);
  return {
    parentId: parent.id as string,
    sectionIds: ((children ?? []) as { id: string }[]).map((c) => c.id),
    idempotencyHit: true,
  };
}
