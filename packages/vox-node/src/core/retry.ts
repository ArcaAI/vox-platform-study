/**
 * Retry policy: 408/429/5xx and connection errors, exponential backoff with
 * FULL jitter, `Retry-After` honored, and a hard rule against retrying
 * non-idempotent writes.
 */

import { APIConnectionError, HopeAPIError, RateLimitError } from './errors';

const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_BASE_DELAY_MS = 500;
const DEFAULT_MAX_DELAY_MS = 8_000;

const RETRYABLE_STATUSES: ReadonlySet<number> = new Set([408, 429]);

function isRetryableStatus(status: number): boolean {
  return RETRYABLE_STATUSES.has(status) || (status >= 500 && status <= 599);
}

/** Inputs to a single retry/no-retry decision. */
export interface ShouldRetryInput {
  /** HTTP method of the request being retried. */
  method: string;
  /** The response status of the failed attempt, if a response was received. */
  status?: number;
  /** `true` when the attempt failed before any response was received (DNS/connect/timeout). */
  isConnectionError?: boolean;
  /** `true` when the caller supplied an idempotency key for this request. */
  hasIdempotencyKey?: boolean;
  /** Number of retries already performed (0 on the first failure). */
  attempt: number;
  /** Maximum number of retries allowed. */
  maxRetries: number;
  /**
   * Statuses this particular request must NEVER retry, whatever the general
   * rules say — an escape hatch for a status that is retryable-shaped but
   * deterministic for the route in question.
   *
   * The motivating case (TASK-850) is `POST …/runs?mode=blocking`: its 504 is
   * a fixed ~60s CEILING on the HTTP wait, not a transient upstream failure.
   * It is a 5xx, so the default rule would retry it — and because that POST
   * carries an `Idempotency-Key`, the non-idempotent-POST guard would not stop
   * it either. The retry would then wait the same 60s, join the same still-
   * running run, and time out identically: three minutes spent to reach the
   * same answer. Streaming or polling is the recovery, and only the caller can
   * choose it.
   */
  nonRetryableStatuses?: ReadonlySet<number>;
}

/**
 * Decide whether a failed attempt should be retried.
 *
 * `POST` is HOPE's non-idempotent write verb (create + fire-a-generation
 * routes) — retrying one blind risks double-billing an LLM call or creating
 * a duplicate row. It is retried ONLY when the caller supplied an
 * idempotency key (the gateway then Redis-dedupes by
 * `(tenantId, userId, key)` — see `GenerateSummaryRequest.idempotencyKey`),
 * which makes a retry provably safe. Every other verb (GET, PATCH with
 * `If-Match`, etc.) is retried per the status/connection rules below.
 */
export function shouldRetry(input: ShouldRetryInput): boolean {
  if (input.attempt >= input.maxRetries) return false;

  // Checked FIRST: an explicit per-request refusal outranks every rule below,
  // including the connection-error rule. See `nonRetryableStatuses`.
  if (input.status !== undefined && input.nonRetryableStatuses?.has(input.status)) return false;

  const isNonIdempotentPost = input.method.toUpperCase() === 'POST';
  if (isNonIdempotentPost && !input.hasIdempotencyKey) return false;

  if (input.isConnectionError) return true;
  if (input.status !== undefined && isRetryableStatus(input.status)) return true;
  return false;
}

/** Options for {@link computeBackoffDelayMs}. */
export interface BackoffOptions {
  baseDelayMs: number;
  maxDelayMs: number;
  /** Returns a float in `[0, 1)`. Injectable so tests are deterministic — never draw from `Math.random()` in a test. */
  random: () => number;
}

/**
 * Exponential backoff with FULL JITTER:
 * `delay = random(0, min(cap, base * 2**attempt))`.
 *
 * Plain exponential backoff (no jitter) is a hazard the moment more than one
 * client is affected by the same outage: every client that failed at
 * roughly the same moment computes roughly the same delay and retries in
 * lockstep, re-flooring a gateway that was in the middle of recovering.
 * Full jitter (AWS's "Exponential Backoff And Jitter") spreads retries
 * across the *entire* `[0, cap]` window on every attempt instead of merely
 * lengthening a fixed-width window — this is why the formula draws from
 * `[0, cap]` rather than something like `cap/2 ± cap/2`.
 */
export function computeBackoffDelayMs(attempt: number, options: BackoffOptions): number {
  const cap = Math.min(options.maxDelayMs, options.baseDelayMs * 2 ** attempt);
  return options.random() * cap;
}

function resolveDelayMs(attempt: number, options: BackoffOptions, retryAfterMs: number | undefined): number {
  return retryAfterMs ?? computeBackoffDelayMs(attempt, options);
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Options for {@link executeWithRetry}. */
export interface ExecuteWithRetryOptions {
  /** HTTP method of the request — drives the non-idempotent-POST rule. */
  method: string;
  /** Whether an idempotency key was supplied for this request. */
  hasIdempotencyKey?: boolean;
  /** Default `2`. */
  maxRetries?: number;
  /** Default `500`. */
  baseDelayMs?: number;
  /** Default `8000`. */
  maxDelayMs?: number;
  /** Default `Math.random`. Inject a deterministic function in tests. */
  random?: () => number;
  /** Default a real `setTimeout`-based sleep. Inject a stub in tests — never use real timers. */
  sleep?: (ms: number) => Promise<void>;
  /** See {@link ShouldRetryInput.nonRetryableStatuses}. */
  nonRetryableStatuses?: ReadonlySet<number>;
}

/**
 * Run `attempt` (given the 0-based attempt number), retrying on failure per
 * {@link shouldRetry}. `attempt` must THROW to signal failure — a
 * {@link HopeAPIError} (its `status` drives the retry decision) or an
 * {@link APIConnectionError}/`APITimeoutError` (its subclass) for a
 * connect-phase/timeout failure. A thrown {@link RateLimitError}'s
 * `retryAfterMs`, when present, overrides the computed backoff delay for
 * that wait (honoring the server's `Retry-After`). Any other thrown value,
 * or a non-retryable outcome, propagates immediately.
 */
export async function executeWithRetry<T>(attempt: (attemptNumber: number) => Promise<T>, options: ExecuteWithRetryOptions): Promise<T> {
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const backoffOptions: BackoffOptions = {
    baseDelayMs: options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS,
    maxDelayMs: options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS,
    random: options.random ?? Math.random,
  };
  const sleep = options.sleep ?? defaultSleep;

  let attemptNumber = 0;
  for (;;) {
    try {
      return await attempt(attemptNumber);
    } catch (err) {
      const isConnectionError = err instanceof APIConnectionError;
      const status = err instanceof HopeAPIError && !isConnectionError ? err.status : undefined;
      const retryAfterMs = err instanceof RateLimitError ? err.retryAfterMs : undefined;

      const canRetry = shouldRetry({
        method: options.method,
        status,
        isConnectionError,
        hasIdempotencyKey: options.hasIdempotencyKey,
        attempt: attemptNumber,
        maxRetries,
        nonRetryableStatuses: options.nonRetryableStatuses,
      });
      if (!canRetry) throw err;

      await sleep(resolveDelayMs(attemptNumber, backoffOptions, retryAfterMs));
      attemptNumber += 1;
    }
  }
}
