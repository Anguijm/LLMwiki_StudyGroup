// Post-ingest no-op stubs. The ingest.pdf function emits these events so
// the wiring is proved end-to-end in v0. Each handler logs + exits until
// replaced by a real implementation.
//
// note.created.flashcards — REPLACED by inngest/src/functions/flashcard-gen.ts
//   in PR #37 (issue closed: first post-ingest feature handler).
// note.created.link — still a no-op; tracked for a future PR (wiki linking).
import { inngest } from '../client';
import { counter } from '@llmwiki/lib-metrics';

export const noteCreatedLink = inngest.createFunction(
  { id: 'note-created-link', retries: 0 },
  { event: 'note.created.link' },
  async ({ event }) => {
    counter('note.created.link.received', { note_id: event.data.note_id });
    return { ok: true, v0: 'noop' };
  },
);
