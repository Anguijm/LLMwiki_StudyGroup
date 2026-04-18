// Anthropic wrapper — Haiku simplify + future Opus calls.
// Every function: Zod-validated response shape + 30s HTTP timeout.
//
// Cost (callsite documentation, CLAUDE.md non-negotiable):
//   simplifyBatch — Haiku 4.5, prompt-cached system prefix, per-call:
//     ~2k tokens in, ~1.5k tokens out, $0.002 per call.
//     Call volume: 80 PDFs/mo × ~3 batches/PDF = ~240 calls/mo (~$0.50/mo).
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { AiResponseShapeError } from './errors';
import { DEFAULT_TIMEOUT_MS, withTimeout } from './with-timeout';

const HAIKU_MODEL = 'claude-haiku-4-5-20251001';

const TextBlockSchema = z.object({
  type: z.literal('text'),
  text: z.string().min(1),
});

const HaikuResponseSchema = z.object({
  content: z.array(TextBlockSchema).min(1),
  stop_reason: z.string().nullable(),
  usage: z
    .object({
      input_tokens: z.number(),
      output_tokens: z.number(),
      cache_read_input_tokens: z.number().optional(),
      cache_creation_input_tokens: z.number().optional(),
    })
    .passthrough(),
});

export type HaikuUsage = z.infer<typeof HaikuResponseSchema>['usage'];

export interface SimplifyBatchResult {
  text: string;
  usage: HaikuUsage;
}

export interface SimplifyBatchInput {
  systemPrompt: string;
  chunks: string[]; // already wrapped in <untrusted_content> by caller
  maxTokensOut?: number;
}

export interface AnthropicClientDeps {
  apiKey: string;
  timeoutMs?: number;
  // Optional DI seam for tests — lets __mocks__ replace the SDK.
  sdk?: Anthropic;
}

export function makeAnthropicClient(deps: AnthropicClientDeps) {
  const client = deps.sdk ?? new Anthropic({ apiKey: deps.apiKey });
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  async function simplifyBatch(input: SimplifyBatchInput): Promise<SimplifyBatchResult> {
    return withTimeout('anthropic', timeoutMs, async (signal) => {
      const raw = await client.messages.create(
        {
          model: HAIKU_MODEL,
          max_tokens: input.maxTokensOut ?? 2048,
          // Prompt-cache breakpoint deferred to v1 — the 0.30.x SDK types
          // don't expose `cache_control` on system text blocks. Cost
          // impact is small (~30% of a small fraction). Re-add alongside
          // an @anthropic-ai/sdk bump + dep-vetting pass.
          system: [{ type: 'text', text: input.systemPrompt }],
          messages: [
            {
              role: 'user',
              content: input.chunks
                .map(
                  (c, i) => `<untrusted_content index="${i}">\n${c}\n</untrusted_content>`,
                )
                .join('\n\n'),
            },
          ],
        },
        { signal },
      );

      const parsed = HaikuResponseSchema.safeParse(raw);
      if (!parsed.success) {
        throw new AiResponseShapeError('anthropic', parsed.error.message, parsed.error);
      }
      const text = parsed.data.content.map((b) => b.text).join('\n');
      return { text, usage: parsed.data.usage };
    });
  }

  return { simplifyBatch };
}

export type AnthropicClient = ReturnType<typeof makeAnthropicClient>;
