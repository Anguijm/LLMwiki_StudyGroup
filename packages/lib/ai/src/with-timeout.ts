// withTimeout: shared helper for every outbound vendor request.
// Implements the r3 bug fix 5 "30s HTTP timeout on every vendor call" via
// AbortController. On timeout, raises AiRequestTimeoutError with the vendor
// label so the calling Inngest step produces a typed ingestion error.
import { AiRequestTimeoutError } from './errors';

export const DEFAULT_TIMEOUT_MS = 30_000;

type Vendor = ConstructorParameters<typeof AiRequestTimeoutError>[0];

export async function withTimeout<T>(
  vendor: Vendor,
  timeoutMs: number,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await run(controller.signal);
  } catch (err) {
    if (controller.signal.aborted) {
      throw new AiRequestTimeoutError(vendor, timeoutMs);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
