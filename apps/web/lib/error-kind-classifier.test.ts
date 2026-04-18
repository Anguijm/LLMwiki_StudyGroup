import { describe, it, expect } from 'vitest';
import { classifyErrorKind } from './error-kind-classifier';
import type { IngestionErrorKind } from '@llmwiki/db/types';

describe('classifyErrorKind', () => {
  const userCorrectable: IngestionErrorKind[] = [
    'pdf_unparseable',
    'pdf_no_text_content',
    'pdf_too_many_chunks',
    'pdf_content_too_long',
    'embed_input_too_long',
    'pdf_timeout',
  ];
  const systemTransient: IngestionErrorKind[] = [
    'token_budget_exhausted',
    'ratelimit_unavailable',
    'ai_response_shape_error',
    'ai_request_timeout_error',
    'stale_job_watchdog',
  ];

  for (const k of userCorrectable) {
    it(`classifies ${k} as user_correctable`, () => {
      expect(classifyErrorKind(k)).toBe('user_correctable');
    });
  }
  for (const k of systemTransient) {
    it(`classifies ${k} as system_transient`, () => {
      expect(classifyErrorKind(k)).toBe('system_transient');
    });
  }
});
