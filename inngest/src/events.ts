// Typed Inngest event catalogue. Every event that crosses the boundary
// between `apps/web` and the Inngest functions has its payload schema here.
import { z } from 'zod';

export const IngestPdfRequested = z.object({
  name: z.literal('ingest.pdf.requested'),
  data: z.object({
    job_id: z.string().uuid(),
    idempotency_key: z.string().min(1),
    owner_id: z.string().uuid(),
    cohort_id: z.string().uuid(),
    storage_path: z.string().min(1),
    title: z.string().min(1),
  }),
});

export const NoteCreatedLink = z.object({
  name: z.literal('note.created.link'),
  data: z.object({ note_id: z.string().uuid() }),
});

export const NoteCreatedFlashcards = z.object({
  name: z.literal('note.created.flashcards'),
  data: z.object({ note_id: z.string().uuid() }),
});

export const Events = z.discriminatedUnion('name', [
  IngestPdfRequested,
  NoteCreatedLink,
  NoteCreatedFlashcards,
]);

export type IngestPdfRequestedEvent = z.infer<typeof IngestPdfRequested>;
