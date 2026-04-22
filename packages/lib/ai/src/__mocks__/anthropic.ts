// Test double for the Anthropic client. Import paths from consumer tests use
// `vi.mock('@llmwiki/lib-ai/anthropic', ...)` and reach this file.
import type {
  AnthropicClient,
  GenerateFlashcardsInput,
  GenerateFlashcardsResult,
  SimplifyBatchInput,
  SimplifyBatchResult,
} from '../anthropic';

export interface AnthropicMockOptions {
  simplifyBatch?: (input: SimplifyBatchInput) => Promise<SimplifyBatchResult>;
  generateFlashcards?: (
    input: GenerateFlashcardsInput,
  ) => Promise<GenerateFlashcardsResult>;
}

export function makeAnthropicMock(opts: AnthropicMockOptions = {}): AnthropicClient {
  return {
    simplifyBatch:
      opts.simplifyBatch ??
      (async (input) => ({
        text: input.chunks.map((c) => `[simplified] ${c}`).join('\n'),
        usage: { input_tokens: 100, output_tokens: 100 },
      })),
    generateFlashcards:
      opts.generateFlashcards ??
      (async () => ({
        cards: [
          { question: '[mock] Q1', answer: '[mock] A1' },
          { question: '[mock] Q2', answer: '[mock] A2' },
        ],
        usage: { input_tokens: 200, output_tokens: 400 },
      })),
  };
}
