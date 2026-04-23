// Prompt registry. Prompt text lives in .md files next to this file so the
// council can review diffs as text, not escaped string literals.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

export type PromptId = 'simplifier/v1' | 'ingest-pdf/v1' | 'flashcard-gen/v1';

const PROMPT_FILES: Record<PromptId, string> = {
  'simplifier/v1': join(here, 'simplifier', 'v1.md'),
  'ingest-pdf/v1': join(here, 'ingest-pdf', 'v1.md'),
  'flashcard-gen/v1': join(here, 'flashcard-gen', 'v1.md'),
};

export function loadPrompt(id: PromptId): string {
  const path = PROMPT_FILES[id];
  // readFileSync at module init time is fine — prompts are small, static,
  // and read once per Inngest function instance.
  return readFileSync(path, 'utf8');
}

export const SIMPLIFIER_V1 = loadPrompt('simplifier/v1');
export const INGEST_PDF_V1 = loadPrompt('ingest-pdf/v1');
export const FLASHCARD_GEN_V1 = loadPrompt('flashcard-gen/v1');
