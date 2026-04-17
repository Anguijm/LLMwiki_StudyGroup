// Function-level onFailure handler for the ingest.pdf pipeline.
//
// SECURITY-CRITICAL (r5 security must-do 1). The refund sequence is:
//
//   1. UPDATE ingestion_jobs SET reserved_tokens = NULL WHERE id = $1
//      RETURNING reserved_tokens;
//   2. If the RETURNING value is non-null -> Upstash INCRBY that amount.
//   3. If NULL -> a previous hook call already refunded; no-op.
//
// This order makes the DB the claim-owner. A retry of the hook finds the
// column already NULL and short-circuits, so the refund fires exactly once
// even if Inngest re-invokes us (watchdog + natural retry).
//
// Unit test (commit 7): invoke twice, assert INCRBY called exactly once.
import type { SupabaseClient } from '@supabase/supabase-js';

export interface TokenRefunder {
  refund(userId: string, tokens: number): Promise<void>;
}

export interface StorageRemover {
  remove(path: string): Promise<void>;
}

export interface OnFailureDeps {
  supabase: SupabaseClient;
  tokenBudget: TokenRefunder;
  storage: StorageRemover;
  metrics?: {
    tokensRefunded?: (amount: number, jobId: string) => void;
    storageCleaned?: (jobId: string) => void;
    storageCleanupFailed?: (jobId: string) => void;
  };
}

export interface OnFailureArgs {
  jobId: string;
  ownerId: string;
  storagePath: string | null;
}

const HOOK_STEP_TIMEOUT_MS = 10_000;

function withTimeoutMs<T>(ms: number, p: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`onFailure step timeout ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

export async function onIngestFailure(args: OnFailureArgs, deps: OnFailureDeps): Promise<void> {
  // ----- Step 1: atomic token refund -------------------------------------
  // Call the SQL helper atomic_null_reserved_tokens(_job_id) which returns
  // the PRE-update value and sets the column to NULL in a single tx. A
  // retry of the hook sees a NULL return and no-ops. Supabase's
  // .update().select() returns the POST-update row, so we can't use that.
  try {
    const { data, error } = await withTimeoutMs(
      HOOK_STEP_TIMEOUT_MS,
      deps.supabase.rpc('atomic_null_reserved_tokens', { _job_id: args.jobId }),
    );
    if (error) throw error;
    const row = Array.isArray(data) ? data[0] : data;
    const previouslyReserved = (row as { reserved_tokens_before?: number } | null)
      ?.reserved_tokens_before;
    if (typeof previouslyReserved === 'number' && previouslyReserved > 0) {
      await withTimeoutMs(
        HOOK_STEP_TIMEOUT_MS,
        deps.tokenBudget.refund(args.ownerId, previouslyReserved),
      );
      deps.metrics?.tokensRefunded?.(previouslyReserved, args.jobId);
    }
  } catch {
    // Refund failure is non-fatal: budget auto-expires in the 1h window.
    // Do NOT throw — we still want to attempt storage cleanup below.
  }

  // ----- Step 2: delete the orphaned Storage object ----------------------
  if (args.storagePath) {
    try {
      await withTimeoutMs(HOOK_STEP_TIMEOUT_MS, deps.storage.remove(args.storagePath));
      deps.metrics?.storageCleaned?.(args.jobId);
    } catch {
      deps.metrics?.storageCleanupFailed?.(args.jobId);
      // watchdog will re-run onFailure on next pass; don't throw here.
    }
  }
}
