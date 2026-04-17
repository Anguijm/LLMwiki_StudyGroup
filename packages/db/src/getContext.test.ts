import { describe, it, expect, vi } from 'vitest';
import { getContext } from './getContext';

function makeDeps(overrides: Partial<Parameters<typeof getContext>[2]> = {}) {
  const supabase = {
    rpc: vi.fn().mockResolvedValue({ data: [], error: null }),
  };
  const embed = vi.fn().mockResolvedValue(new Array(1024).fill(0.1));
  return {
    supabase: supabase as unknown as Parameters<typeof getContext>[2]['supabase'],
    embed,
    ...overrides,
  };
}

describe('getContext', () => {
  it('returns [] for an empty query without calling Voyage', async () => {
    const deps = makeDeps();
    const out = await getContext('', { tierScope: 'bedrock+active' }, deps);
    expect(out).toEqual([]);
    expect(deps.embed).not.toHaveBeenCalled();
  });

  it('returns [] for whitespace-only query', async () => {
    const deps = makeDeps();
    const out = await getContext('   \n\t ', { tierScope: 'bedrock+active' }, deps);
    expect(out).toEqual([]);
    expect(deps.embed).not.toHaveBeenCalled();
  });

  it('truncates over-long input and emits onTruncate', async () => {
    const onTruncate = vi.fn();
    const deps = makeDeps({ onTruncate });
    await getContext('x'.repeat(31_000), { tierScope: 'bedrock+active' }, deps);
    expect(onTruncate).toHaveBeenCalledOnce();
    expect(deps.embed).toHaveBeenCalledWith(expect.stringMatching(/^x{30000}$/));
  });

  it('passes the correct scope to the RPC', async () => {
    const deps = makeDeps();
    await getContext('hello', { tierScope: 'bedrock+active+cold', k: 3 }, deps);
    expect(deps.supabase.rpc).toHaveBeenCalledWith('notes_by_similarity', {
      query_embedding: expect.any(Array),
      tier_scope: ['bedrock', 'active', 'cold'],
      match_count: 3,
    });
  });

  it('throws if the RPC errors', async () => {
    const deps = makeDeps();
    (deps.supabase.rpc as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      data: null,
      error: { message: 'bad rpc' },
    });
    await expect(
      getContext('hi', { tierScope: 'bedrock+active' }, deps),
    ).rejects.toThrow(/bad rpc/);
  });
});
