/**
 * `hope.dnaWritingStyle` — submit a clinician's time-ordered writing samples
 * so the platform's hidden `dna-writing-style-analyst` agent (TASK-974) can
 * regenerate their writing-style report, and track the resulting job.
 *
 * Backed by `DnaWritingStyleIngestController`
 * (`apps/api/src/modules/dna-writing-style/dna-writing-style-ingest.controller.ts`):
 *
 * ```
 * POST /api/v1/dna-writing-styles/ingest             -> ingest()
 * GET  /api/v1/dna-writing-styles/ingest/jobs/{jobId} -> getIngestJob()
 * ```
 *
 * Hand-authored, like `hope.agents`/`hope.jobs`: this is the BUSINESS plane.
 * Unlike `hope.workflows`/`hope.agents`, it is reachable by BOTH machine
 * credential classes — an API key holding scope `dna-writing-style:ingest`,
 * or a service account holding `svc:dna-writing-style:ingest` — so, like
 * `hope.jobs`, this resource applies no `assertCredentialClass` restriction
 * of its own.
 *
 * **No SSE on this route** — the gateway exposes none for it (ticket
 * follow-up F-1). {@link DnaWritingStyleResource.waitForIngestJob} therefore
 * only polls {@link DnaWritingStyleResource.getIngestJob}; it never attempts
 * a stream, unlike `hope.jobs.waitFor`.
 */

import { DnaIngestJobTimeoutError } from '../core/errors';
import { generateUuidV7 } from '../core/idempotency';
import type { Transport } from '../core/transport';
import { encodePathSegment } from '../core/url';
import type { DnaIngestJobResponse, DnaIngestJobStatus, DnaWritingSamplesIngestRequest } from '../types/dna-writing-style';

const INGEST_PATH = 'dna-writing-styles/ingest';

function ingestJobPath(jobId: string): string {
  return `${INGEST_PATH}/jobs/${encodePathSegment(jobId)}`;
}

/** Every terminal `DnaIngestJobStatus.status` value. */
const TERMINAL_STATUSES: ReadonlySet<DnaIngestJobStatus['status']> = new Set(['completed', 'failed']);

function isTerminal(status: DnaIngestJobStatus['status']): boolean {
  return TERMINAL_STATUSES.has(status);
}

/** Options for {@link DnaWritingStyleResource.ingest}. */
export interface DnaWritingStyleIngestOptions {
  signal?: AbortSignal;
  /**
   * Sent as the `Idempotency-Key` header (at most 200 characters; a longer one
   * is a 400). Reuse the same value to retry a submission safely.
   *
   * The gateway DERIVES the job id from `(tenant, credential, key)`, so a retry
   * joins the job the first attempt enqueued and answers that job's handle —
   * the same `jobId`, `clinicianUserId`, `acceptedItems` and `window`, whatever
   * the retry's own body says. The dedupe holds for as long as the queue
   * RETAINS that job; once it is evicted, the same key starts a new analysis.
   *
   * Scoped to the calling credential: two callers reusing the same string never
   * join each other's batch, and a key never reaches across tenants.
   *
   * Sending one also makes this POST retryable by the SDK's own transport — an
   * idempotent request is safe to repeat after a 5xx, and a bare one is not.
   */
  idempotencyKey?: string;
  /** Mint an `Idempotency-Key` (UUIDv7) for this call when you have no natural key of your own. Ignored when {@link idempotencyKey} is set. */
  idempotent?: boolean;
}

/** Options for {@link DnaWritingStyleResource.getIngestJob}. */
export interface DnaWritingStyleJobRequestOptions {
  signal?: AbortSignal;
}

/** Options for {@link DnaWritingStyleResource.waitForIngestJob}. */
export interface WaitForIngestJobOptions {
  signal?: AbortSignal;
  /** Delay between polls, in ms. Default `1000`. */
  pollIntervalMs?: number;
  /** Ceiling on total wait time, in ms, before throwing {@link DnaIngestJobTimeoutError}. Default `120000`. */
  timeoutMs?: number;
}

function idempotencyHeaders(options: DnaWritingStyleIngestOptions): Record<string, string> | undefined {
  const key = options.idempotencyKey ?? (options.idempotent === true ? generateUuidV7() : undefined);
  return key === undefined ? undefined : { 'Idempotency-Key': key };
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw signal.reason ?? new DOMException('The operation was aborted.', 'AbortError');
  }
}

export class DnaWritingStyleResource {
  /**
   * @param sleep Injectable for tests — never a real timer in a unit test.
   *   Defaults to a real `setTimeout`-based sleep. Not part of the public
   *   `HopeClient` surface; `HopeClient` always constructs this resource
   *   with the default.
   */
  constructor(
    private readonly transport: Transport,
    private readonly sleep: (ms: number) => Promise<void> = defaultSleep,
  ) {}

  /**
   * `POST /api/v1/dna-writing-styles/ingest` — submit a time-ordered batch of
   * writing samples for a clinician. Enqueues report regeneration and
   * returns immediately (HTTP 202); use {@link getIngestJob} or
   * {@link waitForIngestJob} to track completion.
   */
  async ingest(request: DnaWritingSamplesIngestRequest, options: DnaWritingStyleIngestOptions = {}): Promise<DnaIngestJobResponse> {
    const headers = idempotencyHeaders(options);
    return this.transport.request<DnaIngestJobResponse>({
      method: 'POST',
      path: INGEST_PATH,
      body: request,
      headers,
      signal: options.signal,
      hasIdempotencyKey: headers !== undefined,
    });
  }

  /** `GET /api/v1/dna-writing-styles/ingest/jobs/{jobId}`. */
  async getIngestJob(jobId: string, options: DnaWritingStyleJobRequestOptions = {}): Promise<DnaIngestJobStatus> {
    return this.transport.request<DnaIngestJobStatus>({ path: ingestJobPath(jobId), signal: options.signal });
  }

  /**
   * Poll {@link getIngestJob} until `status` is `'completed'` or `'failed'` —
   * both RESOLVE (a failed job is a valid terminal answer, not a thrown
   * error). Throws {@link DnaIngestJobTimeoutError} once `timeoutMs` elapses
   * without a terminal status, and propagates `options.signal`'s abort
   * reason immediately, before or between polls.
   */
  async waitForIngestJob(jobId: string, options: WaitForIngestJobOptions = {}): Promise<DnaIngestJobStatus> {
    const { signal, pollIntervalMs = 1000, timeoutMs = 120_000 } = options;
    const deadline = Date.now() + timeoutMs;
    throwIfAborted(signal);

    for (;;) {
      const status = await this.getIngestJob(jobId, { signal });
      if (isTerminal(status.status)) return status;

      if (Date.now() >= deadline) {
        throw new DnaIngestJobTimeoutError(jobId, timeoutMs);
      }
      throwIfAborted(signal);
      await this.sleep(pollIntervalMs);
    }
  }
}
