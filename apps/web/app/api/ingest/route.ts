// POST /api/ingest — server-side upload entry point.
//
// Enforces (server-authoritative):
//   - 25 MiB hard cap via Content-Length + the FormData file size check.
//   - 5 uploads/user/hour via Upstash Tier A (fail-closed).
//   - sha256(file_bytes) idempotency: duplicate submits collapse to the
//     same ingestion_jobs row (status-partial unique index). On collision
//     we return 200 + existing job id (council batch-3-5 bugs callout),
//     NOT a generic 409.
//   - Tight MIME/magic-byte check: rejects anything that doesn't look like
//     a PDF before a storage object is created.
//
// On success: inserts the ingestion_jobs row (status='queued'), uploads the
// file to Supabase Storage at `ingest/<job_id>.pdf`, and sends the
// `ingest.pdf.requested` Inngest event.

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { supabaseForRequest, supabaseService } from '../../../lib/supabase';
import { sanitizeNoteTitle } from '@llmwiki/db/sanitize';
import { makeIngestEventLimiter } from '@llmwiki/lib-ratelimit';
import { inngest } from '../../../../../inngest/src/client';
import { apiError } from '../../../lib/api-error-handler';
import { counter, errorMetric, histogram } from '@llmwiki/lib-metrics';

export const runtime = 'nodejs';
export const maxDuration = 60;

const MAX_BYTES = 25 * 1024 * 1024;

function isPdfMagic(first8: Uint8Array): boolean {
  // %PDF-1.x … every valid PDF starts with the ASCII bytes 25 50 44 46 2D.
  return (
    first8[0] === 0x25 &&
    first8[1] === 0x50 &&
    first8[2] === 0x44 &&
    first8[3] === 0x46 &&
    first8[4] === 0x2d
  );
}

export async function POST(req: NextRequest) {
  const correlationId = crypto.randomUUID().slice(0, 8);
  try {
    // --- auth ---------------------------------------------------------
    const rlsClient = await supabaseForRequest();
    const { data: userRes } = await rlsClient.auth.getUser();
    const user = userRes?.user;
    if (!user) {
      return NextResponse.json(
        { error: { message: 'Unauthorized', kind: 'unauthorized' } },
        { status: 401 },
      );
    }

    // --- cap check (content-length, pre-parse) ------------------------
    const cl = req.headers.get('content-length');
    if (cl && Number(cl) > MAX_BYTES + 16 * 1024) {
      // +16 KiB tolerates FormData overhead.
      return NextResponse.json(
        { error: { message: 'Payload too large', kind: 'file_too_large' } },
        { status: 413, headers: { 'x-correlation-id': correlationId } },
      );
    }

    // --- parse form ---------------------------------------------------
    const form = await req.formData();
    const file = form.get('file');
    const idempotencyKey = String(form.get('idempotency_key') ?? '');
    const cohortId = String(form.get('cohort_id') ?? '');
    const rawTitle = String(form.get('title') ?? 'Untitled');

    if (!(file instanceof File) || file.size === 0) {
      return NextResponse.json(
        { error: { message: 'file field missing or empty', kind: 'bad_request' } },
        { status: 400 },
      );
    }
    if (file.size > MAX_BYTES) {
      return NextResponse.json(
        { error: { message: 'File exceeds 25 MB', kind: 'file_too_large' } },
        { status: 413 },
      );
    }
    if (!/^[0-9a-f]{64}$/i.test(idempotencyKey)) {
      return NextResponse.json(
        { error: { message: 'idempotency_key must be a sha256 hex', kind: 'bad_request' } },
        { status: 400 },
      );
    }

    // --- magic byte ---------------------------------------------------
    const first8 = new Uint8Array(await file.slice(0, 8).arrayBuffer());
    if (!isPdfMagic(first8)) {
      return NextResponse.json(
        { error: { message: 'Not a PDF', kind: 'bad_request' } },
        { status: 400 },
      );
    }

    histogram('ingestion.upload.file_size_bytes', file.size, { owner: user.id });

    // --- rate limit (Tier A, fail-closed) -----------------------------
    const limiter = makeIngestEventLimiter();
    await limiter.reserve(user.id);

    // --- insert ingestion_jobs row (idempotent) -----------------------
    const svc = supabaseService();
    const title = sanitizeNoteTitle(rawTitle);

    // Pre-allocate the job id client-side so we can write storage_path on
    // the INSERT. Closes the orphan-file window where Storage upload
    // succeeds but a follow-up UPDATE of storage_path fails, leaving the
    // watchdog with no path to clean up (council batch-6-8 bug nice-to-have).
    const preJobId = crypto.randomUUID();
    const preStoragePath = `${preJobId}.pdf`;

    const { data: insertResult, error: insertError } = await svc
      .from('ingestion_jobs')
      .insert({
        id: preJobId,
        idempotency_key: idempotencyKey,
        owner_id: user.id,
        cohort_id: cohortId,
        status: 'queued',
        storage_path: preStoragePath,
      })
      .select('id, status, storage_path')
      .single();

    if (
      insertError?.code === '23505' &&
      insertError.message.includes('ingestion_jobs_owner_key_idx')
    ) {
      // A non-terminal job with this (owner, key) already exists. The
      // partial unique index specifically permits retries of terminally-
      // failed jobs; this branch runs for concurrent double-submits.
      // Return 200 with the existing job id (council batch-3-5 bugs fix).
      const { data: existing } = await svc
        .from('ingestion_jobs')
        .select('id, status')
        .eq('owner_id', user.id)
        .eq('idempotency_key', idempotencyKey)
        .order('created_at', { ascending: false })
        .limit(1)
        .single();
      counter('ingestion.jobs.idempotent_replay', { owner: user.id });
      return NextResponse.json({ job_id: existing?.id, status: existing?.status }, { status: 200 });
    }
    if (insertError) throw insertError;

    const jobId = insertResult.id as string;
    const storagePath = insertResult.storage_path as string;

    // --- upload to Storage (service role; RLS gates the READ path) ----
    const bytes = new Uint8Array(await file.arrayBuffer());
    const { error: upErr } = await svc.storage
      .from('ingest')
      .upload(storagePath, bytes, { contentType: 'application/pdf' });
    if (upErr) {
      await svc
        .from('ingestion_jobs')
        .update({
          status: 'failed',
          error: { kind: 'pdf_unparseable', message: `storage upload: ${upErr.message}`, step: 'upload' },
        })
        .eq('id', jobId);
      errorMetric('ingestion.upload.failed', 1, { reason: 'storage' });
      return NextResponse.json(
        { error: { message: 'Upload failed', kind: 'internal' } },
        { status: 500 },
      );
    }
    // storage_path was written on INSERT above — no follow-up UPDATE needed.

    // --- dispatch Inngest event ---------------------------------------
    await inngest.send({
      name: 'ingest.pdf.requested',
      data: {
        job_id: jobId,
        idempotency_key: idempotencyKey,
        owner_id: user.id,
        cohort_id: cohortId,
        storage_path: storagePath,
        title,
      },
    });

    counter('ingestion.jobs.created', { owner: user.id });
    return NextResponse.json({ job_id: jobId, status: 'queued' }, { status: 201 });
  } catch (err) {
    return apiError(err, { correlationId });
  }
}
