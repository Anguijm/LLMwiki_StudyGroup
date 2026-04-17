// Hand-curated DB row types. Once `supabase gen types typescript` is wired
// in CI (commit 9), this file re-exports from the generated `database.ts`;
// for v0 the schema is small enough to maintain by hand.

export type TierEnum = 'bedrock' | 'active' | 'cold';

export type IngestionStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface Cohort {
  id: string;
  name: string;
  created_at: string;
}

export interface CohortMember {
  cohort_id: string;
  user_id: string;
  role: 'member' | 'admin';
  created_at: string;
}

export interface IngestionJob {
  id: string;
  idempotency_key: string;
  kind: 'pdf';
  status: IngestionStatus;
  owner_id: string;
  cohort_id: string;
  storage_path: string | null;
  error: IngestionError | null;
  chunk_count: number | null;
  reserved_tokens: number | null;
  started_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface IngestionError {
  kind: IngestionErrorKind;
  message: string;
  step?: string;
}

// Exhaustive union. Adding a new kind triggers a typecheck failure in
// /apps/web/lib/error-kind-classifier.ts until the UI classifies it.
export type IngestionErrorKind =
  | 'pdf_unparseable'
  | 'pdf_no_text_content'
  // r2-diff council: chunk step fails loud if max_chunks (200) is exceeded
  // instead of silently truncating. Distinct from pdf_content_too_long
  // (which is the pre-chunk size check) so users see a useful error.
  | 'pdf_too_many_chunks'
  | 'pdf_content_too_long'
  | 'pdf_timeout'
  | 'embed_input_too_long'
  | 'token_budget_exhausted'
  | 'ratelimit_unavailable'
  | 'ai_response_shape_error'
  | 'ai_request_timeout_error'
  | 'stale_job_watchdog';

export interface Note {
  id: string;
  slug: string;
  title: string;
  body_md: string;
  tier: TierEnum;
  author_id: string;
  cohort_id: string;
  embedding: number[] | null;
  source_ingestion_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface ConceptLink {
  source_note_id: string;
  target_note_id: string;
  cohort_id: string;
  strength: number | null;
  created_at: string;
}

export interface SrsCard {
  id: string;
  note_id: string;
  question: string;
  answer: string;
  fsrs_state: Record<string, unknown>;
  due_at: string | null;
  user_id: string;
  cohort_id: string;
  created_at: string;
}

export interface ReviewHistory {
  id: string;
  card_id: string;
  user_id: string;
  rating: number;
  reviewed_at: string;
  prev_state: Record<string, unknown> | null;
  next_state: Record<string, unknown> | null;
}

export interface NoteView {
  note_id: string;
  user_id: string;
  viewed_day: string;
  view_count: number;
}
