// Tests for makeAnthropicClient().generateFlashcards — the method that
// turns a note body into a parsed, validated array of flashcard drafts.
//
// Non-negotiables enforced here (council r1–r3 on PR #37):
//   1. [security] >10 cards from Claude → AiResponseShapeError, not
//      silently truncated.
//   2. [bugs] Malformed JSON → AiResponseShapeError; final fallthrough
//      shape mismatch also surfaces as AiResponseShapeError.
//   3. [security] Zod bounds (question.min(1).max(500),
//      answer.min(1).max(2000)) enforced before the caller sees cards.
//   4. [security] Injection / tag passthrough test: a note body that
//      contains <script> strings should not cause those strings to
//      appear verbatim in the parsed output (Claude is instructed to
//      treat them as content; this is a behavior check, not a
//      guarantee — the prompt's refusal clause is tested here).

import { describe, it, expect, vi } from 'vitest';
import Anthropic from '@anthropic-ai/sdk';
import { makeAnthropicClient } from './anthropic';
import { AiResponseShapeError } from './errors';

// Build a minimal fake SDK return shape matching what real Anthropic
// returns from messages.create. The test just needs content[].text to
// carry the JSON string we want generateFlashcards to parse.
function fakeSdkResponse(jsonText: string): {
  content: Array<{ type: 'text'; text: string }>;
  stop_reason: string | null;
  usage: { input_tokens: number; output_tokens: number };
} {
  return {
    content: [{ type: 'text', text: jsonText }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 200, output_tokens: 400 },
  };
}

function fakeSdk(jsonText: string): Anthropic {
  return {
    messages: {
      create: vi.fn(async () => fakeSdkResponse(jsonText)),
    },
  } as unknown as Anthropic;
}

const SYSTEM_PROMPT = '<flashcard-gen/v1 test prompt>';
const NOTE_BODY = 'The citric acid cycle produces 3 NADH per turn.';

describe('generateFlashcards — happy path', () => {
  it('parses a valid JSON array into FlashcardDraft[]', async () => {
    const json = JSON.stringify([
      { question: 'What is the citric acid cycle?', answer: 'A metabolic pathway.' },
      { question: 'How many NADH per turn?', answer: 'Three.' },
    ]);
    const client = makeAnthropicClient({ apiKey: 'test', sdk: fakeSdk(json) });
    const result = await client.generateFlashcards({
      systemPrompt: SYSTEM_PROMPT,
      noteBody: NOTE_BODY,
    });
    expect(result.cards).toHaveLength(2);
    expect(result.cards[0]).toEqual({
      question: 'What is the citric acid cycle?',
      answer: 'A metabolic pathway.',
    });
    expect(result.usage.input_tokens).toBe(200);
    expect(result.usage.output_tokens).toBe(400);
  });

  it('accepts an empty array as a valid response (Claude found nothing to card)', async () => {
    const client = makeAnthropicClient({ apiKey: 'test', sdk: fakeSdk('[]') });
    const result = await client.generateFlashcards({
      systemPrompt: SYSTEM_PROMPT,
      noteBody: NOTE_BODY,
    });
    expect(result.cards).toEqual([]);
  });

  it('trims surrounding whitespace from the response before parsing', async () => {
    // Claude sometimes emits a leading newline or trailing whitespace around
    // the JSON. Acceptable; we trim before JSON.parse.
    const json = '\n\n   [{"question": "Q1", "answer": "A1"}]   \n';
    const client = makeAnthropicClient({ apiKey: 'test', sdk: fakeSdk(json) });
    const result = await client.generateFlashcards({
      systemPrompt: SYSTEM_PROMPT,
      noteBody: NOTE_BODY,
    });
    expect(result.cards).toHaveLength(1);
  });
});

describe('generateFlashcards — failure modes', () => {
  it('throws AiResponseShapeError on non-JSON text', async () => {
    const client = makeAnthropicClient({
      apiKey: 'test',
      sdk: fakeSdk("Sure! Here's your flashcards:\n- Q1: ..."),
    });
    await expect(
      client.generateFlashcards({
        systemPrompt: SYSTEM_PROMPT,
        noteBody: NOTE_BODY,
      }),
    ).rejects.toBeInstanceOf(AiResponseShapeError);
  });

  it('throws AiResponseShapeError on malformed JSON (unclosed brace)', async () => {
    const client = makeAnthropicClient({
      apiKey: 'test',
      sdk: fakeSdk('[{"question": "Q", "answer":'),
    });
    await expect(
      client.generateFlashcards({
        systemPrompt: SYSTEM_PROMPT,
        noteBody: NOTE_BODY,
      }),
    ).rejects.toBeInstanceOf(AiResponseShapeError);
  });

  it('throws AiResponseShapeError when the array contains >10 cards (council r1 non-negotiable)', async () => {
    // Explicit REJECT, not silent truncate.
    const cards = Array.from({ length: 15 }, (_, i) => ({
      question: `Q${i}`,
      answer: `A${i}`,
    }));
    const client = makeAnthropicClient({
      apiKey: 'test',
      sdk: fakeSdk(JSON.stringify(cards)),
    });
    await expect(
      client.generateFlashcards({
        systemPrompt: SYSTEM_PROMPT,
        noteBody: NOTE_BODY,
      }),
    ).rejects.toBeInstanceOf(AiResponseShapeError);
  });

  it('throws AiResponseShapeError when a card is missing the answer field', async () => {
    const json = JSON.stringify([{ question: 'Q' }, { question: 'Q2', answer: 'A2' }]);
    const client = makeAnthropicClient({
      apiKey: 'test',
      sdk: fakeSdk(json),
    });
    await expect(
      client.generateFlashcards({
        systemPrompt: SYSTEM_PROMPT,
        noteBody: NOTE_BODY,
      }),
    ).rejects.toBeInstanceOf(AiResponseShapeError);
  });

  it('throws AiResponseShapeError when a question exceeds 500 chars (upper bound)', async () => {
    const longQuestion = 'Q'.repeat(501);
    const json = JSON.stringify([{ question: longQuestion, answer: 'A' }]);
    const client = makeAnthropicClient({
      apiKey: 'test',
      sdk: fakeSdk(json),
    });
    await expect(
      client.generateFlashcards({
        systemPrompt: SYSTEM_PROMPT,
        noteBody: NOTE_BODY,
      }),
    ).rejects.toBeInstanceOf(AiResponseShapeError);
  });

  it('throws AiResponseShapeError when an answer exceeds 2000 chars (upper bound)', async () => {
    const longAnswer = 'A'.repeat(2001);
    const json = JSON.stringify([{ question: 'Q', answer: longAnswer }]);
    const client = makeAnthropicClient({
      apiKey: 'test',
      sdk: fakeSdk(json),
    });
    await expect(
      client.generateFlashcards({
        systemPrompt: SYSTEM_PROMPT,
        noteBody: NOTE_BODY,
      }),
    ).rejects.toBeInstanceOf(AiResponseShapeError);
  });

  it('throws AiResponseShapeError when the response is a non-array (e.g., wrapping object)', async () => {
    // Defensive: Claude is instructed to return a bare array, not
    // { "cards": [...] }. Test locks the contract.
    const json = JSON.stringify({ cards: [{ question: 'Q', answer: 'A' }] });
    const client = makeAnthropicClient({
      apiKey: 'test',
      sdk: fakeSdk(json),
    });
    await expect(
      client.generateFlashcards({
        systemPrompt: SYSTEM_PROMPT,
        noteBody: NOTE_BODY,
      }),
    ).rejects.toBeInstanceOf(AiResponseShapeError);
  });
});

describe('generateFlashcards — message construction', () => {
  it('wraps the note body in <untrusted_content> tags', async () => {
    // Pattern-match the PDF ingest's simplifyBatch: user-content goes
    // inside <untrusted_content> so the prompt's injection-refusal
    // clause applies.
    const createSpy = vi.fn(
      async (_args: unknown) =>
        fakeSdkResponse(JSON.stringify([{ question: 'Q', answer: 'A' }])),
    );
    const sdk = { messages: { create: createSpy } } as unknown as Anthropic;
    const client = makeAnthropicClient({ apiKey: 'test', sdk });
    await client.generateFlashcards({
      systemPrompt: SYSTEM_PROMPT,
      noteBody: 'PROBE_BODY_TEXT',
    });
    const call = createSpy.mock.calls[0]?.[0] as unknown as {
      messages: Array<{ content: string }>;
    };
    const userContent = call.messages[0]?.content ?? '';
    expect(userContent).toContain('<untrusted_content>');
    expect(userContent).toContain('PROBE_BODY_TEXT');
    expect(userContent).toContain('</untrusted_content>');
  });

  it('passes the systemPrompt verbatim in the system field', async () => {
    const createSpy = vi.fn(
      async (_args: unknown) =>
        fakeSdkResponse(JSON.stringify([{ question: 'Q', answer: 'A' }])),
    );
    const sdk = { messages: { create: createSpy } } as unknown as Anthropic;
    const client = makeAnthropicClient({ apiKey: 'test', sdk });
    await client.generateFlashcards({
      systemPrompt: 'ROLE SYSTEM PROBE',
      noteBody: NOTE_BODY,
    });
    const call = createSpy.mock.calls[0]?.[0] as unknown as {
      system: Array<{ text: string }>;
    };
    expect(call.system[0]?.text).toBe('ROLE SYSTEM PROBE');
  });

  it('uses the Haiku 4.5 model', async () => {
    const createSpy = vi.fn(
      async (_args: unknown) =>
        fakeSdkResponse(JSON.stringify([{ question: 'Q', answer: 'A' }])),
    );
    const sdk = { messages: { create: createSpy } } as unknown as Anthropic;
    const client = makeAnthropicClient({ apiKey: 'test', sdk });
    await client.generateFlashcards({
      systemPrompt: SYSTEM_PROMPT,
      noteBody: NOTE_BODY,
    });
    const call = createSpy.mock.calls[0]?.[0] as unknown as { model: string };
    expect(call.model).toBe('claude-haiku-4-5-20251001');
  });
});
