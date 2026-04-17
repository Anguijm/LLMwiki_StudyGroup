// Inngest webhook entry. Signature-validated by the Inngest SDK using
// INNGEST_SIGNING_KEY; unsigned requests are rejected.
import { serve } from 'inngest/next';
import {
  inngest,
  ingestPdf,
  ingestWatchdog,
  noteCreatedLink,
  noteCreatedFlashcards,
} from '../../../../../inngest/src';

export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [ingestPdf, ingestWatchdog, noteCreatedLink, noteCreatedFlashcards],
  signingKey: process.env.INNGEST_SIGNING_KEY,
});
