/**
 * P0.5 — async consultation-job lifecycle: `get`/`cancel`/`stream`/`waitFor`.
 * Backed by `apps/api/src/modules/consultation/consultation-job.controller.ts`
 * (`consultations/jobs/:jobId*`), the endpoints returned by
 * `ConsultationSummariesResource.generateAsync`/`generatePreSummaryAsync`.
 *
 * **G5** — `POST :id/summary/async`'s `AsyncJobResponse.status`
 * (`pending|processing|completed|failed`) and this module's
 * `JobStatusResponse.status` (`PENDING|RUNNING|COMPLETED|FAILED|CANCELLED`)
 * are TWO DIFFERENT VOCABULARIES on the same logical job lifecycle — a
 * gateway inconsistency (tracked separately), not something this SDK
 * silently normalizes. {@link isTerminalJobStatus} accepts both.
 */

import { encodePathSegment } from '../core/url';
import { parseSseStream } from '../core/sse';
import type { Transport } from '../core/transport';
import type { AsyncJobResponse, JobStatusResponse, JobStatusType, JobStreamEvent } from '../types/consultation';

/** Every terminal literal from BOTH job-status vocabularies (see the module docstring's G5 note). */
const TERMINAL_STATUSES: ReadonlySet<string> = new Set<JobStatusType | AsyncJobResponse['status']>([
  'COMPLETED',
  'FAILED',
  'CANCELLED',
  'completed',
  'failed',
]);

/**
 * `true` when `status` is a terminal value in EITHER job-status vocabulary
 * (`JobStatusResponse.status` — `PENDING|RUNNING|COMPLETED|FAILED|CANCELLED`
 * — or `AsyncJobResponse.status` — `pending|processing|completed|failed`).
 * Deliberately accepts both rather than normalizing one onto the other — see
 * the module docstring's G5 note.
 */
export function isTerminalJobStatus(status: JobStatusType | AsyncJobResponse['status']): boolean {
  return TERMINAL_STATUSES.has(status);
}

/** `JobStreamEvent` is `JobStatusResponse | { error, jobId }` with no `event:` discriminator on the wire. `JobStatusResponse` itself may ALSO carry an `error` field (a FAILED job's error message), so the only reliable discriminator is the presence of `status` — never `'error' in evt`. */
function isJobStatusResponse(event: JobStreamEvent): event is JobStatusResponse {
  return 'status' in event;
}

/** Per-call options shared by {@link JobsResource.get}/{@link JobsResource.cancel}/{@link JobsResource.stream}. */
export interface JobRequestOptions {
  signal?: AbortSignal;
}

/** Options for {@link JobsResource.waitFor}. */
export interface WaitForOptions {
  signal?: AbortSignal;
  /** Delay between polls once the SSE stream has fallen back to polling. Default `2000`. */
  pollIntervalMs?: number;
}

function jobPath(jobId: string): string {
  return `consultations/jobs/${encodePathSegment(jobId)}`;
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

export class JobsResource {
  /**
   * @param sleep Injectable for tests — never a real timer in a unit test.
   *   Defaults to a real `setTimeout`-based sleep. Not part of the public
   *   `HopeClient` surface; `HopeClient` always constructs `JobsResource`
   *   with the default.
   */
  constructor(
    private readonly transport: Transport,
    private readonly sleep: (ms: number) => Promise<void> = defaultSleep,
  ) {}

  /** `GET /api/v1/consultations/jobs/:jobId`. Throws {@link NotFoundError} (from `core/errors.ts`) when the job is unknown or expired. */
  async get(jobId: string, options: JobRequestOptions = {}): Promise<JobStatusResponse> {
    return this.transport.request<JobStatusResponse>({ path: jobPath(jobId), signal: options.signal });
  }

  /** `PATCH /api/v1/consultations/jobs/:jobId/cancel`. */
  async cancel(jobId: string, options: JobRequestOptions = {}): Promise<{ ok: true }> {
    return this.transport.request<{ ok: true }>({ method: 'PATCH', path: `${jobPath(jobId)}/cancel`, signal: options.signal });
  }

  /**
   * `GET /api/v1/consultations/jobs/:jobId/stream` (SSE). Yields one parsed
   * {@link JobStreamEvent} per frame; the iterable completes when the server
   * closes the connection — which it always does once a terminal status is
   * reached (or immediately, for an unknown `jobId`) — see the module
   * docstring's `subscribeToJobUpdates` reference.
   */
  async *stream(jobId: string, options: JobRequestOptions = {}): AsyncGenerator<JobStreamEvent, void, void> {
    const response = await this.transport.stream({
      path: `${jobPath(jobId)}/stream`,
      headers: { Accept: 'text/event-stream' },
      signal: options.signal,
    });
    if (!response.body) return;
    for await (const frame of parseSseStream(response.body, { signal: options.signal })) {
      yield JSON.parse(frame.data) as JobStreamEvent;
    }
  }

  /**
   * Resolve once the job reaches a terminal status, preferring the live SSE
   * stream and falling back to polling `get()` if the stream ends without
   * ever emitting a terminal frame (a dropped connection, or any other
   * non-abort stream failure). Respects `options.signal` throughout — an
   * abort propagates immediately rather than triggering the poll fallback.
   *
   * A `{ error: 'Job not found', jobId }` stream frame is treated as
   * non-terminal (not the answer this method is waiting for) rather than
   * thrown directly: falling through to the poll fallback's `get()` call
   * surfaces the SAME {@link NotFoundError} the rest of this SDK uses for a
   * missing/cross-tenant resource, instead of a bespoke shape here.
   */
  async waitFor(jobId: string, options: WaitForOptions = {}): Promise<JobStatusResponse> {
    const { signal, pollIntervalMs = 2000 } = options;
    throwIfAborted(signal);

    try {
      for await (const event of this.stream(jobId, { signal })) {
        if (!isJobStatusResponse(event)) continue;
        if (isTerminalJobStatus(event.status)) return event;
      }
      // Stream ended cleanly without a terminal frame — connection dropped. Fall through to polling.
    } catch (err) {
      if (signal?.aborted) throw err;
      // Non-abort stream failure — fall through to polling.
    }

    for (;;) {
      throwIfAborted(signal);
      const status = await this.get(jobId, { signal });
      if (isTerminalJobStatus(status.status)) return status;
      await this.sleep(pollIntervalMs);
    }
  }
}
