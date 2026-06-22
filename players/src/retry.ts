/**
 * Retry-with-backoff for transient network failures. A live match makes many RPC and inference
 * round-trips over ~10+ minutes against flaky testnet endpoints; a single dropped connection
 * (ETIMEDOUT / RPC timeout / NAT64 ENETUNREACH) would otherwise abort the whole match. This
 * retries only *transient* errors — never contract reverts or bad-request (4xx) errors, which
 * would just fail again and must surface immediately.
 */
export interface RetryOptions {
  /** Max additional attempts after the first (default 4 → up to 5 tries). */
  retries?: number;
  /** First backoff delay; doubles each attempt up to maxDelayMs (default 500). */
  baseDelayMs?: number;
  /** Backoff ceiling (default 8000). */
  maxDelayMs?: number;
  /** Decide whether an error is worth retrying (default {@link isTransientError}). */
  isRetryable?: (err: unknown) => boolean;
  /** Observe each retry (logging). */
  onRetry?: (err: unknown, attempt: number, delayMs: number) => void;
  /** Injectable sleep (tests pass a synchronous virtual clock). */
  delay?: (ms: number) => Promise<void>;
}

/** Transient (worth retrying) vs. permanent (revert / bad request) error classification. */
export function isTransientError(err: unknown): boolean {
  const e = err as { code?: unknown; message?: unknown; errors?: unknown };
  const code = typeof e?.code === "string" ? e.code : "";
  const msg = String(e?.message ?? err ?? "").toLowerCase();

  // Definitely permanent: contract reverts and malformed requests must not be retried.
  if (code === "CALL_EXCEPTION") return false;
  if (/execution reverted|deadline passed|invalid_request|must be integer|\b400\b|bad request/.test(msg)) {
    return false;
  }

  // Network/transport transient codes (ethers + Node).
  const transientCodes = [
    "TIMEOUT", "NETWORK_ERROR", "SERVER_ERROR", "ETIMEDOUT", "ECONNRESET",
    "ECONNREFUSED", "ENETUNREACH", "EAI_AGAIN", "EPIPE", "ECONNABORTED",
  ];
  if (transientCodes.includes(code)) return true;

  // AggregateError (e.g. happy-eyeballs IPv4+IPv6) — transient if any inner error is.
  if (Array.isArray(e?.errors) && e.errors.some((x) => isTransientError(x))) return true;

  return /timeout|timed out|etimedout|econnreset|econnrefused|enetunreach|eai_again|socket hang up|network error|fetch failed|rate limit|\b429\b|\b50[234]\b/.test(
    msg,
  );
}

export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const {
    retries = 4,
    baseDelayMs = 500,
    maxDelayMs = 8000,
    isRetryable = isTransientError,
    onRetry,
    delay = (ms) => new Promise<void>((r) => setTimeout(r, ms)),
  } = opts;

  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt === retries || !isRetryable(err)) throw err;
      const d = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt);
      onRetry?.(err, attempt + 1, d);
      await delay(d);
    }
  }
  throw lastErr;
}
