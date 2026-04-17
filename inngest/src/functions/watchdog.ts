// ingest.watchdog — hourly cron that marks stale jobs failed.
//
// A job is "stale" if status in ('queued','running') AND updated_at is
// older than 2 hours (r5 bug-fix: bumped from 1h because a 200-chunk PDF
// with batched Haiku + embed + parse can realistically run past 1h).
//
// Marking stale triggers the function-level onFailure hook on each row,
// so orphaned storage files get cleaned up and reserved tokens refunded
// in the same pass.
import { inngest } from '../client';
import { supabaseService } from '@llmwiki/db/server';
import { counter } from '@llmwiki/lib-metrics';
import { onIngestFailure } from './on-failure';
import { makeTokenBudgetLimiter } from '@llmwiki/lib-ratelimit';

const STALE_INTERVAL = "now() - interval '2 hours'";

export const ingestWatchdog = inngest.createFunction(
  { id: 'ingest-watchdog', retries: 2 },
  { cron: '0 * * * *' }, // every hour
  async ({ step }) => {
    const supabase = supabaseService();
    const tokenBudget = makeTokenBudgetLimiter();

    const { data: stale } = await step.run('find-stale', async () => {
      return supabase
        .from('ingestion_jobs')
        .select('id, owner_id, storage_path')
        .in('status', ['queued', 'running'])
        .filter('updated_at', 'lt', STALE_INTERVAL)
        .limit(100);
    });

    if (!stale || stale.length === 0) return { rescued: 0 };

    for (const row of stale) {
      await step.run(`rescue-${row.id}`, async () => {
        await supabase
          .from('ingestion_jobs')
          .update({
            status: 'failed',
            error: { kind: 'stale_job_watchdog', message: 'no progress > 2h', step: 'watchdog' },
          })
          .eq('id', row.id);

        await onIngestFailure(
          {
            jobId: row.id,
            ownerId: row.owner_id,
            storagePath: row.storage_path ?? null,
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
            },
          },
        );

        counter('ingestion.watchdog.rescued_count', { job_id: row.id });
      });
    }

    return { rescued: stale.length };
  },
);
