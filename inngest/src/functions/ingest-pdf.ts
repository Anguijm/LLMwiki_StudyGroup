// ingest.pdf Inngest function — the vertical slice.
//
// Steps, each step.run + idempotent by ingestion_jobs.id:
//   1. parse: magic-byte check + parser call; zero-text -> pdf_no_text_content
//   2. chunk: heading-aware; exceeding MAX_CHUNKS -> pdf_too_many_chunks
//   3. token_budget_reserve: idempotent via ingestion_jobs.reserved_tokens
//   4. simplify: batched Haiku with <untrusted_content> framing
//   5. embed: Voyage-3; over-budget -> embed_input_too_long
//   6. persist: app-side UUID + slug collision retry; unique index on
//      source_ingestion_id makes retries no-op
//   7. post-ingest.enqueue: emits link + flashcard stubs
//
// Function-level onFailure hook runs onIngestFailure() for atomic token
// refund + storage cleanup on any terminal failure, including watchdog.
import { createHash } from 'node:crypto';
import slugify from 'slugify';
import { inngest } from '../client';
import { chunkParsed, TooManyChunksError } from './chunker';
import { onIngestFailure } from './on-failure';
import { counter, histogram, withDuration, errorMetric } from '@llmwiki/lib-metrics';
import { supabaseService } from '@llmwiki/db/server';
import { sanitizeNoteTitle } from '@llmwiki/db/sanitize';
import type { IngestionError, IngestionErrorKind } from '@llmwiki/db/types';
import {
  makeAnthropicClient,
  makeVoyageClient,
  makePdfParserClient,
  resolvePdfParser,
  AiResponseShapeError,
  AiRequestTimeoutError,
} from '@llmwiki/lib-ai';
import { requireEnv } from '@llmwiki/lib-utils/env';
import {
  makeTokenBudgetLimiter,
  RateLimitExceededError,
  RatelimitUnavailableError,
} from '@llmwiki/lib-ratelimit';
import { SIMPLIFIER_V1 } from '@llmwiki/prompts';

const VOYAGE_MAX_EMBED_CHARS = 30_000;
const SIMPLIFY_BATCH_SIZE = 8;

async function markFailed(
  supabase: ReturnType<typeof supabaseService>,
  jobId: string,
  kind: IngestionErrorKind,
  message: string,
  step: string,
): Promise<void> {
  const error: IngestionError = { kind, message, step };
  // No updated_at here — the set_updated_at trigger owns that column so the
  // watchdog's `updated_at < now() - interval '2 hours'` predicate isn't
  // susceptible to Inngest worker clock skew. (council batch-9+ bugs fix).
  await supabase
    .from('ingestion_jobs')
    .update({ status: 'failed', error })
    .eq('id', jobId);
  errorMetric('ingestion.jobs.failed', 1, { kind, step });
}

export const ingestPdf = inngest.createFunction(
  {
    id: 'ingest-pdf',
    retries: 3,
    onFailure: async ({ event, error: _err }) => {
      // `event.data.event.data` is the original event payload in the
      // Inngest onFailure envelope.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Inngest envelope untyped here
      const orig = (event as any)?.data?.event?.data as
        | { job_id: string; owner_id: string; storage_path?: string }
        | undefined;
      if (!orig) return;
      const supabase = supabaseService();
      const tokenBudget = makeTokenBudgetLimiter();
      await onIngestFailure(
        {
          jobId: orig.job_id,
          ownerId: orig.owner_id,
          storagePath: orig.storage_path ?? null,
        },
        {
          supabase,
          tokenBudget,
          storage: {
            async remove(path: string) {
              const { error } = await supabase.storage.from('ingest').remove([path]);
              if (error) throw error;
            },
          },
          metrics: {
            tokensRefunded: (amount, jobId) =>
              counter('ingestion.tokens.refunded_count', { job_id: jobId, amount }),
            storageCleaned: (jobId) =>
              counter('ingestion.storage.cleaned_count', { job_id: jobId }),
            storageCleanupFailed: (jobId) =>
              counter('ingestion.storage.cleanup_failed_count', { job_id: jobId }),
          },
        },
      );
    },
  },
  { event: 'ingest.pdf.requested' },
  async ({ event, step }) => {
    const { job_id, owner_id, cohort_id, storage_path, title } = event.data;
    const supabase = supabaseService();

    counter('ingestion.funnel', { job_id, stage: 'upload' });

    await step.run('mark-running', async () => {
      await supabase
        .from('ingestion_jobs')
        .update({ status: 'running', started_at: new Date().toISOString() })
        .eq('id', job_id);
    });

    // ----- parse ---------------------------------------------------------
    const parsed = await step.run('parse', async () => {
      counter('ingestion.funnel', { job_id, stage: 'parse' });
      const { kind: parserKind, apiKey } = resolvePdfParser();

      const { data: signedUrl } = await supabase.storage
        .from('ingest')
        .createSignedUrl(storage_path, 60);
      if (!signedUrl?.signedUrl) {
        throw new Error(`could not sign ingest url: ${storage_path}`);
      }

      const parser = makePdfParserClient({ kind: parserKind, apiKey });
      return withDuration(
        'ingestion.step.duration_seconds',
        { job_id, step: 'parse' },
        () => parser.parse(signedUrl.signedUrl),
      );
    }).catch(async (e) => {
      const kind: IngestionErrorKind =
        e instanceof AiRequestTimeoutError
          ? 'pdf_timeout'
          : e instanceof AiResponseShapeError
            ? 'pdf_unparseable'
            : 'pdf_unparseable';
      await markFailed(supabase, job_id, kind, String(e), 'parse');
      counter('ingestion.parse.failure_reason_count', { reason: kind });
      throw e;
    });

    if (
      parsed.page_count === 0 ||
      parsed.blocks.every((b) => b.text.trim().length === 0)
    ) {
      await markFailed(
        supabase,
        job_id,
        'pdf_no_text_content',
        'parser returned zero usable text',
        'parse',
      );
      counter('ingestion.parse.failure_reason_count', { reason: 'pdf_no_text_content' });
      throw new Error('pdf_no_text_content');
    }

    // ----- chunk ---------------------------------------------------------
    const chunks = await step.run('chunk', async () => {
      counter('ingestion.funnel', { job_id, stage: 'chunk' });
      try {
        return chunkParsed(parsed);
      } catch (e) {
        if (e instanceof TooManyChunksError) {
          await markFailed(supabase, job_id, 'pdf_too_many_chunks', String(e), 'chunk');
        }
        throw e;
      }
    });

    await supabase.from('ingestion_jobs').update({ chunk_count: chunks.length }).eq('id', job_id);

    // ----- token_budget_reserve (idempotent) ----------------------------
    await step.run('token_budget_reserve', async () => {
      counter('ingestion.funnel', { job_id, stage: 'token_budget_reserve' });
      const { data, error } = await supabase
        .from('ingestion_jobs')
        .select('reserved_tokens')
        .eq('id', job_id)
        .single();
      if (error) throw error;
      if (data.reserved_tokens !== null) return; // already reserved on a prior attempt

      // Rough estimate: each chunk ~ 1.2k in + 1.2k out + embed.
      const estimate =
        chunks.reduce((s, c) => s + c.estimatedTokens * 2, 0) + chunks.length * 50;

      const tokenBudget = makeTokenBudgetLimiter();
      try {
        await tokenBudget.reserve(owner_id, estimate);
      } catch (e) {
        if (e instanceof RateLimitExceededError) {
          await markFailed(
            supabase,
            job_id,
            'token_budget_exhausted',
            `resets at ${e.resetsAt.toISOString()}`,
            'token_budget_reserve',
          );
        } else if (e instanceof RatelimitUnavailableError) {
          await markFailed(
            supabase,
            job_id,
            'ratelimit_unavailable',
            String(e),
            'token_budget_reserve',
          );
        }
        throw e;
      }
      await supabase
        .from('ingestion_jobs')
        .update({ reserved_tokens: estimate })
        .eq('id', job_id);
    });

    // ----- simplify ------------------------------------------------------
    const simplified = await step.run('simplify', async () => {
      counter('ingestion.funnel', { job_id, stage: 'simplify' });
      const anthropic = makeAnthropicClient({ apiKey: requireEnv('ANTHROPIC_API_KEY') });

      const batches: string[][] = [];
      for (let i = 0; i < chunks.length; i += SIMPLIFY_BATCH_SIZE) {
        batches.push(chunks.slice(i, i + SIMPLIFY_BATCH_SIZE).map((c) => c.text));
      }

      const parts: string[] = [];
      for (const batch of batches) {
        const { text } = await withDuration(
          'ingestion.step.duration_seconds',
          { job_id, step: 'simplify' },
          () =>
            anthropic.simplifyBatch({
              systemPrompt: SIMPLIFIER_V1,
              chunks: batch,
            }),
        );
        if (text.includes('[[NO_TEXT_CONTENT]]')) {
          throw new Error('[[NO_TEXT_CONTENT]]');
        }
        // A 200-OK with a Zod-valid shape but empty/whitespace content is
        // still a no-text outcome — treat it as pdf_no_text_content instead
        // of passing '' through to embed (council batch-9+ bugs fix).
        if (text.trim().length === 0) {
          throw new Error('[[NO_TEXT_CONTENT]]');
        }
        parts.push(text);
      }
      const joined = parts.join('\n\n');
      if (joined.trim().length === 0) {
        throw new Error('[[NO_TEXT_CONTENT]]');
      }
      return joined;
    }).catch(async (e) => {
      const msg = String(e);
      if (msg.includes('[[NO_TEXT_CONTENT]]')) {
        await markFailed(supabase, job_id, 'pdf_no_text_content', msg, 'simplify');
      } else if (e instanceof AiRequestTimeoutError) {
        await markFailed(supabase, job_id, 'ai_request_timeout_error', msg, 'simplify');
      } else if (e instanceof AiResponseShapeError) {
        await markFailed(supabase, job_id, 'ai_response_shape_error', msg, 'simplify');
      }
      throw e;
    });

    // ----- embed ---------------------------------------------------------
    if (simplified.length > VOYAGE_MAX_EMBED_CHARS) {
      await markFailed(
        supabase,
        job_id,
        'embed_input_too_long',
        `simplified body is ${simplified.length} chars (max ${VOYAGE_MAX_EMBED_CHARS})`,
        'embed',
      );
      throw new Error('embed_input_too_long');
    }
    const embedding = await step.run('embed', async () => {
      counter('ingestion.funnel', { job_id, stage: 'embed' });
      const voyage = makeVoyageClient({ apiKey: requireEnv('VOYAGE_API_KEY') });
      return withDuration(
        'ingestion.step.duration_seconds',
        { job_id, step: 'embed' },
        () => voyage.embed(simplified),
      );
    });

    // ----- persist -------------------------------------------------------
    const noteId = await step.run('persist', async () => {
      counter('ingestion.funnel', { job_id, stage: 'persist' });
      const sanitizedTitle = sanitizeNoteTitle(title);
      const id = crypto.randomUUID();
      const hash = createHash('sha256').update(id).digest('hex');

      const makeSlug = (hashLen: number) => {
        let base: string;
        try {
          base = slugify(sanitizedTitle, { lower: true, strict: true, locale: 'en' });
        } catch {
          base = ''; // fall back to hash-only if slugify throws on malformed unicode
        }
        const suffix = hash.slice(0, hashLen);
        return base.length > 0 ? `${base}-${suffix}` : `-${suffix}`;
      };

      // Primary: insert with 6-char hash; catch unique_violation and retry
      // with 12-char; final fallback is full UUID.
      const insert = async (slug: string) =>
        supabase
          .from('notes')
          .insert({
            id,
            slug,
            title: sanitizedTitle,
            body_md: simplified,
            tier: 'active',
            author_id: owner_id,
            cohort_id,
            embedding,
            source_ingestion_id: job_id,
          })
          .select('id')
          .single();

      // First try the idempotent retry case — if persist has already run,
      // the unique index on source_ingestion_id fires and we return that id.
      let attempt = await insert(makeSlug(6));
      if (attempt.error?.code === '23505' && attempt.error.message.includes('source_ingestion_id')) {
        const existing = await supabase
          .from('notes')
          .select('id')
          .eq('source_ingestion_id', job_id)
          .single();
        if (existing.data) return existing.data.id as string;
      }
      // Slug collision path.
      if (attempt.error?.code === '23505' && attempt.error.message.includes('notes_slug_key')) {
        attempt = await insert(makeSlug(12));
        if (attempt.error?.code === '23505') {
          attempt = await insert(makeSlug(id.length));
        }
      }
      if (attempt.error) throw attempt.error;
      return attempt.data.id as string;
    });

    // ----- mark completed + emit post-ingest stubs ----------------------
    await step.run('mark-completed', async () => {
      await supabase
        .from('ingestion_jobs')
        .update({ status: 'completed' })
        .eq('id', job_id);
      counter('ingestion.jobs.completed', { job_id });
      counter('notes.created.count', { user_id: owner_id });
    });

    await step.sendEvent('post-ingest-link', {
      name: 'note.created.link',
      data: { note_id: noteId },
    });
    await step.sendEvent('post-ingest-flashcards', {
      name: 'note.created.flashcards',
      data: { note_id: noteId },
    });

    histogram('ingestion.upload.file_size_bytes', chunks.length, { job_id });
    return { note_id: noteId };
  },
);
