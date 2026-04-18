// Error taxonomy UI classifier (r7 approval-gate Q3).
// Maps IngestionErrorKind to a display category. Adding a new kind to the
// union in @llmwiki/db/types causes this switch to fail typecheck on the
// exhaustiveness check until classified — impossible to introduce a new
// error silently.
import type { IngestionErrorKind } from '@llmwiki/db/types';

export type ErrorDisplayCategory = 'user_correctable' | 'system_transient';

export function classifyErrorKind(kind: IngestionErrorKind): ErrorDisplayCategory {
  switch (kind) {
    case 'pdf_unparseable':
    case 'pdf_no_text_content':
    case 'pdf_too_many_chunks':
    case 'pdf_content_too_long':
    case 'embed_input_too_long':
    case 'pdf_timeout':
      return 'user_correctable';
    case 'token_budget_exhausted':
    case 'ratelimit_unavailable':
    case 'ai_response_shape_error':
    case 'ai_request_timeout_error':
    case 'stale_job_watchdog':
      return 'system_transient';
    default: {
      // Exhaustiveness check: if a new kind is added, this line fails to
      // typecheck — forcing a deliberate classification decision.
      const _exhaustive: never = kind;
      void _exhaustive;
      return 'system_transient';
    }
  }
}
