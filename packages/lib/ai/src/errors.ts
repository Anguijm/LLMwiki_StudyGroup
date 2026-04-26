// Typed errors for the AI abstraction layer. All vendor calls funnel into
// these two error classes so callers (Inngest steps) can map them to a
// specific IngestionErrorKind without parsing vendor-specific messages.

export class AiResponseShapeError extends Error {
  override readonly name = 'AiResponseShapeError';
  constructor(
    public readonly vendor: 'anthropic' | 'voyage' | 'pdfparser',
    message: string,
    // `cause` is a field on Error in modern runtimes — override is required.
    public override readonly cause?: unknown,
  ) {
    super(`${vendor}: ${message}`);
  }
}

export class AiRequestTimeoutError extends Error {
  override readonly name = 'AiRequestTimeoutError';
  constructor(
    public readonly vendor: 'anthropic' | 'voyage' | 'pdfparser',
    public readonly timeoutMs: number,
  ) {
    super(`${vendor}: request timed out after ${timeoutMs}ms`);
  }
}

// Distinguishes transient upstream failures (HTTP 5xx, network errors)
// from deterministic shape errors (4xx, malformed body, schema mismatch).
// Callers wrap calls in retry loops that only catch this class —
// AiResponseShapeError is non-retryable. Council r1 [bugs] external-API
// flakiness fold for #39 phase 3.
export class AiUpstreamError extends Error {
  override readonly name = 'AiUpstreamError';
  constructor(
    public readonly vendor: 'anthropic' | 'voyage' | 'pdfparser',
    // null = pre-response failure (network, DNS); number = HTTP status.
    public readonly status: number | null,
    message: string,
    public override readonly cause?: unknown,
  ) {
    super(`${vendor}: upstream ${status ?? 'network'} ${message}`);
  }
}
