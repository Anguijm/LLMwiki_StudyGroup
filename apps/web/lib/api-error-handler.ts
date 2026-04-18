// Central error -> HTTP response mapper for every Next.js route handler and
// server action. No raw Postgres / vendor errors reach the client.
//
// Covers the Postgres codes our schema can raise (via on-delete-restrict and
// the concept_links integrity trigger), the typed errors our AI abstraction
// layer throws, and the rate-limit errors from /packages/lib/ratelimit.
//
// r7 approval-gate: typecheck-forced exhaustiveness — adding a new
// IngestionErrorKind or rate-limit kind causes a compile error until it's
// classified here.
import { NextResponse } from 'next/server';
import {
  RateLimitExceededError,
  RatelimitUnavailableError,
} from '@llmwiki/lib-ratelimit';
import { AiResponseShapeError, AiRequestTimeoutError } from '@llmwiki/lib-ai';
import { redact } from '@llmwiki/db/logging';

// Shape of PostgrestError / Postgres pg-node errors — both expose `code` as
// a string (Postgres SQLSTATE). We probe for the common codes.
interface WithPgCode {
  code?: string;
  message?: string;
  details?: string;
}

function isWithPgCode(e: unknown): e is WithPgCode {
  return typeof e === 'object' && e !== null && 'code' in e;
}

export interface ApiErrorPayload {
  error: {
    message: string;
    kind: string;
    resetsAt?: string;
  };
}

export function apiError(
  err: unknown,
  opts: { correlationId?: string } = {},
): NextResponse<ApiErrorPayload> {
  const correlationId = opts.correlationId ?? cryptoRandomId();

  // Rate-limit and token-budget errors ------------------------------------
  if (err instanceof RateLimitExceededError) {
    return NextResponse.json<ApiErrorPayload>(
      {
        error: {
          message:
            err.kind === 'token_budget'
              ? 'Token budget exhausted; resets at the time below.'
              : 'Too many uploads; try again later.',
          kind: err.kind,
          resetsAt: err.resetsAt.toISOString(),
        },
      },
      { status: 429, headers: { 'x-correlation-id': correlationId } },
    );
  }
  if (err instanceof RatelimitUnavailableError) {
    return NextResponse.json<ApiErrorPayload>(
      {
        error: {
          message: 'Service unavailable (rate limiter unreachable); retry later.',
          kind: 'ratelimit_unavailable',
        },
      },
      { status: 503, headers: { 'x-correlation-id': correlationId } },
    );
  }

  // AI-vendor errors ------------------------------------------------------
  if (err instanceof AiResponseShapeError || err instanceof AiRequestTimeoutError) {
    return NextResponse.json<ApiErrorPayload>(
      {
        error: {
          message: 'Upstream AI service unavailable; please retry.',
          kind: err instanceof AiResponseShapeError
            ? 'ai_response_shape_error'
            : 'ai_request_timeout_error',
        },
      },
      { status: 502, headers: { 'x-correlation-id': correlationId } },
    );
  }

  // Postgres-specific codes ------------------------------------------------
  if (isWithPgCode(err)) {
    switch (err.code) {
      case '23503': // foreign_key_violation
        return NextResponse.json<ApiErrorPayload>(
          { error: { message: 'Resource not found.', kind: 'foreign_key_violation' } },
          { status: 404, headers: { 'x-correlation-id': correlationId } },
        );
      case '23505': // unique_violation
        return NextResponse.json<ApiErrorPayload>(
          {
            error: {
              message: 'Conflict; resource already exists.',
              kind: 'unique_violation',
            },
          },
          { status: 409, headers: { 'x-correlation-id': correlationId } },
        );
      case '23514': // check_violation
        return NextResponse.json<ApiErrorPayload>(
          { error: { message: 'Invalid request.', kind: 'check_violation' } },
          { status: 400, headers: { 'x-correlation-id': correlationId } },
        );
      case '42501': // insufficient_privilege (RLS / missing perm)
        return NextResponse.json<ApiErrorPayload>(
          {
            error: {
              message: 'Not authorized to perform this action.',
              kind: 'insufficient_privilege',
            },
          },
          { status: 403, headers: { 'x-correlation-id': correlationId } },
        );
    }
  }

  // Unknown fallback -------------------------------------------------------
  // Log the full error server-side with the correlation id; client gets a
  // generic message. The client can quote the correlation id to the user.
  //
  // error_summary is passed through redact() as a belt-and-suspenders guard
  // against a vendor error message ever carrying a leaked token or API key
  // in its text. redact() scrubs Bearer/JWT/known-vendor-prefix/long-hex
  // patterns inside string values (council batch-9+ security nice-to-have).
  const rawSummary = err instanceof Error ? err.message : String(err);
  const safeSummary = redact(rawSummary) as string;
  console.error(
    JSON.stringify({
      level: 'error',
      event: 'api.error.unhandled',
      correlation_id: correlationId,
      error_summary: safeSummary,
    }),
  );
  return NextResponse.json<ApiErrorPayload>(
    {
      error: {
        message: `Internal error (ref ${correlationId}).`,
        kind: 'internal',
      },
    },
    { status: 500, headers: { 'x-correlation-id': correlationId } },
  );
}

function cryptoRandomId(): string {
  // Short correlation id — not cryptographically important, just traceable.
  return crypto.randomUUID().slice(0, 8);
}
