// Inngest client. Constructed once per runtime. Events are typed via the
// EventSchemas helper so calls like inngest.send({name: 'ingest.pdf.requested', data: {...}})
// are type-safe at the callsite.
import { EventSchemas, Inngest } from 'inngest';
import { z } from 'zod';
import { IngestPdfRequested, NoteCreatedLink, NoteCreatedFlashcards } from './events';

type EventDataOnly<T extends z.ZodObject<{ name: z.ZodLiteral<string>; data: z.ZodTypeAny }>> = {
  data: z.infer<T>['data'];
};

// Inngest EventSchemas shape: map event name -> { data: ... }. Must have a
// string index signature, hence `type` + index-compatible shape.
type EventMap = {
  'ingest.pdf.requested': EventDataOnly<typeof IngestPdfRequested>;
  'note.created.link': EventDataOnly<typeof NoteCreatedLink>;
  'note.created.flashcards': EventDataOnly<typeof NoteCreatedFlashcards>;
};

export const inngest = new Inngest({
  id: 'llmwiki-studygroup',
  schemas: new EventSchemas().fromRecord<EventMap>(),
});

export type InngestClient = typeof inngest;
