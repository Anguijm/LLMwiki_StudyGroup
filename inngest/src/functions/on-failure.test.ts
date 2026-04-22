// SECURITY-CRITICAL test (r6 security must-do 2).
// Asserts the onFailure hook refunds tokens exactly once even when invoked
// twice — the atomic claim is on the Postgres side via an RPC that returns
// the pre-update value and sets it to NULL in one transaction. A second
// call sees NULL and no-ops.
import { describe, it, expect, vi } from 'vitest';
import { onIngestFailure, type OnFailureDeps } from './on-failure';

function makeDeps(previouslyReserved: number | null) {
  let called = 0;
  const rpc = vi.fn(async (name: string) => {
    expect(name).toBe('atomic_null_reserved_tokens');
    called++;
    return {
      data: [
        {
          reserved_tokens_before: called === 1 ? previouslyReserved : null,
        },
      ],
      error: null,
    };
  });
  const supabase = { rpc } as unknown as OnFailureDeps['supabase'];
  const refund = vi.fn(async () => undefined);
  const remove = vi.fn(async () => undefined);
  return {
    supabase,
    tokenBudget: { refund },
    storage: { remove },
    __refund: refund,
    __remove: remove,
    __rpc: rpc,
  };
}

describe('onIngestFailure — double-invocation refund safety', () => {
  it('refunds exactly once when invoked twice on the same job', async () => {
    const deps = makeDeps(50_000);
    const args = {
      jobId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      ownerId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
      storagePath: 'ingest/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.pdf',
    };

    await onIngestFailure(args, deps);
    await onIngestFailure(args, deps);

    // The atomic claim RPC is called on BOTH invocations (cheap idempotent
    // write), but only the FIRST one returns a non-null pre-update value,
    // so refund fires once.
    expect(deps.__rpc).toHaveBeenCalledTimes(2);
    expect(deps.__refund).toHaveBeenCalledTimes(1);
    expect(deps.__refund).toHaveBeenCalledWith(args.ownerId, 50_000);
    // Storage remove is idempotent on the service; calling twice is fine.
    expect(deps.__remove).toHaveBeenCalledTimes(2);
  });

  it('no-ops refund when reserved_tokens was already null', async () => {
    const deps = makeDeps(null);
    await onIngestFailure(
      { jobId: 'j1', ownerId: 'u1', storagePath: null },
      deps,
    );
    expect(deps.__refund).not.toHaveBeenCalled();
  });

  it('proceeds to storage cleanup even if refund path throws', async () => {
    const deps = makeDeps(10_000);
    deps.tokenBudget.refund = vi.fn(async () => {
      throw new Error('upstash down');
    });
    await onIngestFailure(
      { jobId: 'j1', ownerId: 'u1', storagePath: 'ingest/j1.pdf' },
      deps,
    );
    expect(deps.__remove).toHaveBeenCalledOnce();
  });
});

// Note: flashcard-gen's onFailure refund coverage lives in
// flashcard-gen.test.ts (see the "refundFlashcardBudget" describe block).
// Kept there rather than here because the two test files use different
// module-mock topologies — vi.mock hoisting doesn't cleanly compose
// across files that both mock @llmwiki/db/server and
// @llmwiki/lib-ratelimit. Council r1 step 7 intent (cover refund
// behavior on failure) is satisfied there.

