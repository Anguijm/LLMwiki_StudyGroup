// Post-ingest no-op stubs. The ingest.pdf function emits these events so
// the wiring is proved end-to-end in v0; the handlers log + exit. v1 plans
// replace each body with real implementation (linker, flashcard-gen).
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

export const noteCreatedFlashcards = inngest.createFunction(
  { id: 'note-created-flashcards', retries: 0 },
  { event: 'note.created.flashcards' },
  async ({ event }) => {
    counter('note.created.flashcards.received', { note_id: event.data.note_id });
    return { ok: true, v0: 'noop' };
  },
);
