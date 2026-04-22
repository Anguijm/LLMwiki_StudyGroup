// Tests for the flashcard-gen Inngest function (PR #37 / issue #30
// handler-surface; council r1-r3).
//
// Strategy: the pure handler body is exported as runNoteCreatedFlashcards.
// We test it directly with a trivial step.run shim (`(id, fn) => fn()`)
// so the real Inngest runtime isn't involved.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NonRetriableError } from 'inngest';

// requireEnv('ANTHROPIC_API_KEY') runs inside the handler before the
// @llmwiki/lib-ai mock's makeAnthropicClient is invoked. Set a placeholder
// so requireEnv passes; the mock intercepts the actual Claude call so
// the key value is never used.
process.env.ANTHROPIC_API_KEY = 'test-key-placeholder';
import {
  estimateFlashcardTokens,
  refundFlashcardBudget,
  runNoteCreatedFlashcards,
  NoteNotFoundError,
} from './flashcard-gen';
import type { FlashcardHandlerArgs } from './flashcard-gen';

// ---------------------------------------------------------------------------
// Shared mocks. supabaseService and makeAnthropicClient are module-level
// deps; we intercept them here. makeTokenBudgetLimiter runs live but
// against a fake redis so no network.
// ---------------------------------------------------------------------------

const noteRow = {
  id: 'note-abc',
  body: 'The mitochondrion produces ATP via oxidative phosphorylation.',
  user_id: 'user-xyz',
  cohort_id: 'cohort-123',
};

const mockSupabase = {
  from: vi.fn(),
};

vi.mock('@llmwiki/db/server', () => ({
  supabaseService: () => mockSupabase,
}));

const generateFlashcardsMock = vi.fn();
vi.mock('@llmwiki/lib-ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@llmwiki/lib-ai')>();
  return {
    ...actual,
    makeAnthropicClient: () => ({
      generateFlashcards: generateFlashcardsMock,
      simplifyBatch: vi.fn(),
    }),
  };
});

// Rate limiter: an in-memory fake.
const reserveSpy = vi.fn(async () => undefined);
const refundSpy = vi.fn(async () => undefined);
vi.mock('@llmwiki/lib-ratelimit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@llmwiki/lib-ratelimit')>();
  return {
    ...actual,
    makeTokenBudgetLimiter: () => ({
      reserve: reserveSpy,
      refund: refundSpy,
    }),
  };
});

vi.mock('@llmwiki/prompts', () => ({
  FLASHCARD_GEN_V1: '[test flashcard-gen prompt]',
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * A step.run that just calls the provided fn. Matches the real Inngest
 * step.run semantics well enough for a handler that doesn't rely on
 * per-step memoization (the UNIQUE-constraint + idempotency: 'event.id'
 * do our retry-safety work).
 */
const directStep: FlashcardHandlerArgs['step'] = {
  run: async <T>(_id: string, fn: () => Promise<T>): Promise<T> => fn(),
};

function handlerArgs(noteId = 'note-abc'): FlashcardHandlerArgs {
  return {
    event: { data: { note_id: noteId } },
    step: directStep,
  };
}

function mockNoteFetch(data: unknown, error: unknown = null) {
  // Supabase chainable stub returning .single() shape.
  const single = vi.fn(async () => ({ data, error }));
  const eq = vi.fn(() => ({ single }));
  const select = vi.fn(() => ({ eq }));
  mockSupabase.from.mockImplementation((table: string) => {
    if (table === 'notes') return { select };
    // fall through for 'srs_cards' upsert
    return {
      upsert: vi.fn(async () => ({ error: null })),
    };
  });
  return { single, eq, select };
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe('estimateFlashcardTokens (pure)', () => {
  it('minimum floor is 1500 tokens for empty/short bodies', () => {
    expect(estimateFlashcardTokens(0)).toBe(1500);
    expect(estimateFlashcardTokens(100)).toBe(1525); // floor + 25
    expect(estimateFlashcardTokens(500)).toBe(1625);
  });

  it('~body.length/4 + 1500 for typical note sizes', () => {
    expect(estimateFlashcardTokens(4000)).toBe(2500); // 1000 + 1500
    expect(estimateFlashcardTokens(8000)).toBe(3500);
    expect(estimateFlashcardTokens(40_000)).toBe(11_500);
  });

  it('ceilings to nearest integer', () => {
    expect(estimateFlashcardTokens(3)).toBe(1501); // ceil(3/4)=1, +1500
    expect(estimateFlashcardTokens(5)).toBe(1502);
  });
});

// ---------------------------------------------------------------------------
// Full-handler tests (via direct invocation of runNoteCreatedFlashcards)
// ---------------------------------------------------------------------------

let errorSpy: ReturnType<typeof vi.spyOn>;
let logSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  mockSupabase.from.mockReset();
  generateFlashcardsMock.mockReset();
  reserveSpy.mockReset();
  reserveSpy.mockResolvedValue(undefined);
  refundSpy.mockReset();
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
});

afterEach(() => {
  errorSpy.mockRestore();
  logSpy.mockRestore();
});

describe('runNoteCreatedFlashcards — happy path', () => {
  it('generates cards and upserts them with the correct row shape', async () => {
    mockNoteFetch(noteRow);
    const upsertSpy = vi.fn(async () => ({ error: null }));
    // Override srs_cards destination after the note-fetch mock set up.
    mockSupabase.from.mockImplementation((table: string) => {
      if (table === 'notes') {
        return {
          select: () => ({ eq: () => ({ single: async () => ({ data: noteRow, error: null }) }) }),
        };
      }
      if (table === 'srs_cards') return { upsert: upsertSpy };
      return {};
    });
    generateFlashcardsMock.mockResolvedValueOnce({
      cards: [
        { question: 'Q1?', answer: 'A1.' },
        { question: 'Q2?', answer: 'A2.' },
      ],
      usage: { input_tokens: 200, output_tokens: 300 },
    });
    const res = await runNoteCreatedFlashcards(handlerArgs());
    expect(res).toEqual({ ok: true, count: 2 });
    expect(upsertSpy).toHaveBeenCalledTimes(1);
    const [rows, opts] = upsertSpy.mock.calls[0] as unknown as [
      unknown[],
      { onConflict?: string; ignoreDuplicates?: boolean },
    ];
    expect(rows).toEqual([
      {
        note_id: 'note-abc',
        question: 'Q1?',
        answer: 'A1.',
        user_id: 'user-xyz',
        cohort_id: 'cohort-123',
      },
      {
        note_id: 'note-abc',
        question: 'Q2?',
        answer: 'A2.',
        user_id: 'user-xyz',
        cohort_id: 'cohort-123',
      },
    ]);
    expect(opts.onConflict).toBe('note_id,question');
    expect(opts.ignoreDuplicates).toBe(true);
  });

  it('returns { count: 0 } cleanly when Claude returns []', async () => {
    mockSupabase.from.mockImplementation((table: string) => {
      if (table === 'notes') {
        return {
          select: () => ({ eq: () => ({ single: async () => ({ data: noteRow, error: null }) }) }),
        };
      }
      return {};
    });
    generateFlashcardsMock.mockResolvedValueOnce({
      cards: [],
      usage: { input_tokens: 200, output_tokens: 50 },
    });
    const res = await runNoteCreatedFlashcards(handlerArgs());
    expect(res).toEqual({ ok: true, count: 0 });
    // srs_cards insert NOT attempted when no cards.
    expect(mockSupabase.from).not.toHaveBeenCalledWith('srs_cards');
  });
});

describe('runNoteCreatedFlashcards — skip branches (council r1/r2 bugs)', () => {
  it('empty note body → skipped: empty_body, no Claude call, no reservation', async () => {
    mockSupabase.from.mockImplementation(() => ({
      select: () => ({
        eq: () => ({
          single: async () => ({
            data: { ...noteRow, body: '' },
            error: null,
          }),
        }),
      }),
    }));
    const res = await runNoteCreatedFlashcards(handlerArgs());
    expect(res).toEqual({ ok: true, count: 0, skipped: 'empty_body' });
    expect(generateFlashcardsMock).not.toHaveBeenCalled();
    expect(reserveSpy).not.toHaveBeenCalled();
  });

  it('whitespace-only body → skipped: empty_body', async () => {
    mockSupabase.from.mockImplementation(() => ({
      select: () => ({
        eq: () => ({
          single: async () => ({
            data: { ...noteRow, body: '   \n\t   ' },
            error: null,
          }),
        }),
      }),
    }));
    const res = await runNoteCreatedFlashcards(handlerArgs());
    expect((res as { skipped?: string }).skipped).toBe('empty_body');
    expect(generateFlashcardsMock).not.toHaveBeenCalled();
  });

  it('null body → skipped: empty_body', async () => {
    mockSupabase.from.mockImplementation(() => ({
      select: () => ({
        eq: () => ({
          single: async () => ({
            data: { ...noteRow, body: null },
            error: null,
          }),
        }),
      }),
    }));
    const res = await runNoteCreatedFlashcards(handlerArgs());
    expect((res as { skipped?: string }).skipped).toBe('empty_body');
  });

  it('body > 500_000 chars → skipped: body_too_long, no Claude call', async () => {
    mockSupabase.from.mockImplementation(() => ({
      select: () => ({
        eq: () => ({
          single: async () => ({
            data: { ...noteRow, body: 'x'.repeat(500_001) },
            error: null,
          }),
        }),
      }),
    }));
    const res = await runNoteCreatedFlashcards(handlerArgs());
    expect(res).toEqual({ ok: true, count: 0, skipped: 'body_too_long' });
    expect(generateFlashcardsMock).not.toHaveBeenCalled();
    expect(reserveSpy).not.toHaveBeenCalled();
  });
});

describe('runNoteCreatedFlashcards — error branches', () => {
  it('load-note fails → throws NoteNotFoundError', async () => {
    mockSupabase.from.mockImplementation(() => ({
      select: () => ({
        eq: () => ({
          single: async () => ({ data: null, error: { message: 'no rows' } }),
        }),
      }),
    }));
    await expect(runNoteCreatedFlashcards(handlerArgs())).rejects.toBeInstanceOf(
      NoteNotFoundError,
    );
    expect(reserveSpy).not.toHaveBeenCalled();
  });

  it('token-budget exceeded → throws NonRetriableError (council r3)', async () => {
    mockSupabase.from.mockImplementation(() => ({
      select: () => ({
        eq: () => ({
          single: async () => ({ data: noteRow, error: null }),
        }),
      }),
    }));
    const { RateLimitExceededError } = await import('@llmwiki/lib-ratelimit');
    reserveSpy.mockRejectedValueOnce(
      new RateLimitExceededError('token_budget', new Date(Date.now() + 3600_000)),
    );
    await expect(runNoteCreatedFlashcards(handlerArgs())).rejects.toBeInstanceOf(
      NonRetriableError,
    );
    expect(generateFlashcardsMock).not.toHaveBeenCalled();
  });

  it('persist FK violation (code 23503) → wraps in NonRetriableError (council r3)', async () => {
    const upsertSpy = vi.fn(async () => ({
      error: { code: '23503', message: 'foreign key violation' },
    }));
    mockSupabase.from.mockImplementation((table: string) => {
      if (table === 'notes') {
        return {
          select: () => ({
            eq: () => ({ single: async () => ({ data: noteRow, error: null }) }),
          }),
        };
      }
      if (table === 'srs_cards') return { upsert: upsertSpy };
      return {};
    });
    generateFlashcardsMock.mockResolvedValueOnce({
      cards: [{ question: 'Q', answer: 'A' }],
      usage: { input_tokens: 100, output_tokens: 100 },
    });
    await expect(runNoteCreatedFlashcards(handlerArgs())).rejects.toBeInstanceOf(
      NonRetriableError,
    );
  });

  it('persist non-FK error (e.g., timeout) propagates (retryable)', async () => {
    const upsertSpy = vi.fn(async () => ({
      error: { code: '57014', message: 'canceling statement due to statement timeout' },
    }));
    mockSupabase.from.mockImplementation((table: string) => {
      if (table === 'notes') {
        return {
          select: () => ({
            eq: () => ({ single: async () => ({ data: noteRow, error: null }) }),
          }),
        };
      }
      if (table === 'srs_cards') return { upsert: upsertSpy };
      return {};
    });
    generateFlashcardsMock.mockResolvedValueOnce({
      cards: [{ question: 'Q', answer: 'A' }],
      usage: { input_tokens: 100, output_tokens: 100 },
    });
    const err = await runNoteCreatedFlashcards(handlerArgs()).catch((e) => e);
    // Not NonRetriableError (Inngest retries will fire, backing off).
    expect(err).not.toBeInstanceOf(NonRetriableError);
    expect(err?.code).toBe('57014');
  });
});

describe('runNoteCreatedFlashcards — no PII / API keys in logs', () => {
  it('never logs the raw note body on any failure path', async () => {
    const PROBE = 'PROBE-SECRET-NOTE-BODY';
    mockSupabase.from.mockImplementation(() => ({
      select: () => ({
        eq: () => ({
          single: async () => ({
            data: { ...noteRow, body: PROBE },
            error: null,
          }),
        }),
      }),
    }));
    generateFlashcardsMock.mockRejectedValueOnce(new Error('claude went sideways'));
    await runNoteCreatedFlashcards(handlerArgs()).catch(() => undefined);
    for (const call of errorSpy.mock.calls) {
      for (const arg of call) {
        const repr = typeof arg === 'string' ? arg : JSON.stringify(arg);
        expect(repr).not.toContain(PROBE);
      }
    }
    for (const call of logSpy.mock.calls) {
      for (const arg of call) {
        const repr = typeof arg === 'string' ? arg : JSON.stringify(arg);
        expect(repr).not.toContain(PROBE);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// onFailure refund helper (refundFlashcardBudget) — council r1 security
// ---------------------------------------------------------------------------

describe('refundFlashcardBudget', () => {
  it('refunds the estimated amount for a fetchable note', async () => {
    mockSupabase.from.mockImplementation(() => ({
      select: () => ({
        eq: () => ({
          single: async () => ({
            data: { user_id: 'user-xyz', body: 'x'.repeat(4000) },
            error: null,
          }),
        }),
      }),
    }));
    await refundFlashcardBudget('note-abc');
    expect(refundSpy).toHaveBeenCalledTimes(1);
    // Estimate for 4000-char body = ceil(4000/4) + 1500 = 2500.
    expect(refundSpy).toHaveBeenCalledWith('user-xyz', 2500);
  });

  it('skips refund when note cannot be fetched (e.g., deleted before hook ran)', async () => {
    mockSupabase.from.mockImplementation(() => ({
      select: () => ({
        eq: () => ({
          single: async () => ({ data: null, error: { message: 'not found' } }),
        }),
      }),
    }));
    await refundFlashcardBudget('note-abc');
    expect(refundSpy).not.toHaveBeenCalled();
  });

  it('refunds exactly the amount that token-budget-reserve would have consumed (council r1 step 7)', async () => {
    // End-to-end contract: the onFailure path refunds the SAME number of
    // tokens that the in-function token-budget-reserve step would have
    // consumed, because both paths use estimateFlashcardTokens(note.body.length).
    const body = 'y'.repeat(12_000);
    mockSupabase.from.mockImplementation(() => ({
      select: () => ({
        eq: () => ({
          single: async () => ({
            data: { user_id: 'user-zed', body },
            error: null,
          }),
        }),
      }),
    }));
    await refundFlashcardBudget('note-xyz');
    // 12000 / 4 + 1500 = 4500. Same formula the handler uses.
    expect(refundSpy).toHaveBeenCalledWith('user-zed', 4500);
    expect(refundSpy).toHaveBeenCalledWith(
      'user-zed',
      estimateFlashcardTokens(body.length),
    );
  });

  it('applies the minimum floor (1500) when body is empty/null', async () => {
    mockSupabase.from.mockImplementation(() => ({
      select: () => ({
        eq: () => ({
          single: async () => ({
            data: { user_id: 'user-xyz', body: null },
            error: null,
          }),
        }),
      }),
    }));
    await refundFlashcardBudget('note-abc');
    expect(refundSpy).toHaveBeenCalledWith('user-xyz', 1500);
  });
});
