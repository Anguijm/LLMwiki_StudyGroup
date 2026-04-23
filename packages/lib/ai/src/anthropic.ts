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

// -----------------------------------------------------------------------
// Flashcard generation — see packages/prompts/src/flashcard-gen/v1.md
// -----------------------------------------------------------------------
//
// Cost (callsite documentation, CLAUDE.md non-negotiable):
//   generateFlashcards — Haiku 4.5, per-call:
//     ~2k tokens in (note body + prompt), ~800 tokens out (5–10 cards).
//     Cost: ~$0.005 per call.
//     Call volume: 1 per successful PDF ingest, 4-user × ~20/mo scale =
//     ~80 calls/mo (~$0.40/mo).

const FlashcardDraftSchema = z.object({
  // Length bounds (council r1–r3 PR #37): defense against prompt-injection
  // blowout + pathological outputs. Questions/answers beyond these bounds
  // are almost certainly Claude getting confused, not meaningful content.
  question: z.string().trim().min(1).max(500),
  answer: z.string().trim().min(1).max(2000),
});

const MAX_CARDS_PER_RESPONSE = 10;

const FlashcardArraySchema = z.array(FlashcardDraftSchema).max(MAX_CARDS_PER_RESPONSE);

export type FlashcardDraft = z.infer<typeof FlashcardDraftSchema>;

export interface GenerateFlashcardsInput {
  systemPrompt: string;
  noteBody: string;
  /** Max tokens for Claude's response (default 1500 — fits 10 cards at ~150 tokens/card). */
  maxTokensOut?: number;
}

export interface GenerateFlashcardsResult {
  cards: readonly FlashcardDraft[];
  usage: HaikuUsage;
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

  async function generateFlashcards(
    input: GenerateFlashcardsInput,
  ): Promise<GenerateFlashcardsResult> {
    return withTimeout('anthropic', timeoutMs, async (signal) => {
      const raw = await client.messages.create(
        {
          model: HAIKU_MODEL,
          max_tokens: input.maxTokensOut ?? 1500,
          system: [{ type: 'text', text: input.systemPrompt }],
          messages: [
            {
              role: 'user',
              // Same <untrusted_content> wrapping pattern as simplifyBatch —
              // belt-and-suspenders with the prompt's refusal clause.
              content: `<untrusted_content>\n${input.noteBody}\n</untrusted_content>`,
            },
          ],
        },
        { signal },
      );

      const parsedResponse = HaikuResponseSchema.safeParse(raw);
      if (!parsedResponse.success) {
        throw new AiResponseShapeError(
          'anthropic',
          parsedResponse.error.message,
          parsedResponse.error,
        );
      }

      const text = parsedResponse.data.content.map((b) => b.text).join('\n').trim();

      // Claude is instructed to return bare JSON. Parse + validate shape +
      // enforce the array-length cap. Any deviation → AiResponseShapeError
      // so the caller (Inngest step) retries or fails.
      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(text);
      } catch (err) {
        throw new AiResponseShapeError(
          'anthropic',
          'flashcard response is not valid JSON',
          err,
        );
      }

      const cardsResult = FlashcardArraySchema.safeParse(parsedJson);
      if (!cardsResult.success) {
        throw new AiResponseShapeError(
          'anthropic',
          `flashcard response did not match schema: ${cardsResult.error.message}`,
          cardsResult.error,
        );
      }

      return {
        cards: cardsResult.data,
        usage: parsedResponse.data.usage,
      };
    });
  }

  return { simplifyBatch, generateFlashcards };
}

export type AnthropicClient = ReturnType<typeof makeAnthropicClient>;
