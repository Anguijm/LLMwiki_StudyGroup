// Typed errors for the AI abstraction layer. All vendor calls funnel into
// these two error classes so callers (Inngest steps) can map them to a
// specific IngestionErrorKind without parsing vendor-specific messages.

export class AiResponseShapeError extends Error {
  override readonly name = 'AiResponseShapeError';
  constructor(
    public readonly vendor: 'anthropic' | 'voyage' | 'pdfparser',
    message: string,
    public readonly cause?: unknown,
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
