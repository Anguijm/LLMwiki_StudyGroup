// Three-tier retrieval helper. v0 is pgvector cosine + tier filter + RLS.
//
// - `bedrock+active` is the default scope (always-on + current-semester).
// - `bedrock+active+cold` explicitly pulls archived tier for the rare case a
//   caller asks for the full corpus (exam generator, wiki-wide search).
//
// Guards:
// - Empty/whitespace-only query → return [] without calling Voyage.
// - Over-length query → truncate at VOYAGE_MAX_INPUT_CHARS; emit a warning
//   metric so we see if the limit bites in practice.
//
// Expected call volume: per note page render + per "Related notes" lookup.
// Cost per call (v0, Voyage-3 cheapest tier): < $0.001.
import type { SupabaseClient } from '@supabase/supabase-js';
import { sanitizeContextQuery } from './sanitize';
import type { Note, TierEnum } from './types';

export interface GetContextOptions {
  tierScope?: 'bedrock+active' | 'bedrock+active+cold';
  k?: number;
}

export const VOYAGE_MAX_INPUT_CHARS = 30_000;

type EmbedFn = (text: string) => Promise<number[]>;

export interface GetContextDeps {
  supabase: SupabaseClient;
  embed: EmbedFn;
  onTruncate?: (info: { from: number; to: number }) => void;
}

export async function getContext(
  query: string,
  opts: GetContextOptions,
  deps: GetContextDeps,
): Promise<Note[]> {
  const sanitized = sanitizeContextQuery(query);
  if (sanitized.trim().length === 0) {
    // Return-empty guard (r5 bug fix 3): avoid wasted Voyage call + vendor 4xx.
    return [];
  }

  const truncated =
    sanitized.length > VOYAGE_MAX_INPUT_CHARS
      ? sanitized.slice(0, VOYAGE_MAX_INPUT_CHARS)
      : sanitized;
  if (truncated.length < sanitized.length) {
    deps.onTruncate?.({ from: sanitized.length, to: truncated.length });
  }

  const embedding = await deps.embed(truncated);

  const scope: TierEnum[] =
    opts.tierScope === 'bedrock+active+cold'
      ? ['bedrock', 'active', 'cold']
      : ['bedrock', 'active'];

  const k = opts.k ?? 5;

  // pgvector cosine via RPC. An RPC lets us keep the similarity expression
  // in SQL (faster, index-friendly) rather than round-tripping via the REST
  // API. The RPC itself is defined in a follow-up migration; until then the
  // call will fail loud and callers see the error cleanly.
  const { data, error } = await deps.supabase.rpc('notes_by_similarity', {
    query_embedding: embedding,
    tier_scope: scope,
    match_count: k,
  });

  if (error) throw new Error(`getContext RPC failed: ${error.message}`);
  return (data ?? []) as Note[];
}
