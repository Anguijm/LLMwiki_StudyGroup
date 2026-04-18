// Test double for the Anthropic client. Import paths from consumer tests use
// `vi.mock('@llmwiki/lib-ai/anthropic', ...)` and reach this file.
import type { AnthropicClient, SimplifyBatchInput, SimplifyBatchResult } from '../anthropic';

export interface AnthropicMockOptions {
  simplifyBatch?: (input: SimplifyBatchInput) => Promise<SimplifyBatchResult>;
}

export function makeAnthropicMock(opts: AnthropicMockOptions = {}): AnthropicClient {
  return {
    simplifyBatch:
      opts.simplifyBatch ??
      (async (input) => ({
        text: input.chunks.map((c) => `[simplified] ${c}`).join('\n'),
        usage: { input_tokens: 100, output_tokens: 100 },
      })),
  };
}
