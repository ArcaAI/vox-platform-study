/**
 * TASK-1023 D-C — one download job's view of "has an admin cancelled me?".
 *
 * The signal the job threads into every transfer (Hub fetch, staging write,
 * bucket upload). It fires when the gateway's Redis flag
 * (`PublisherCancelFlags`) is seen — polled every heartbeat interval and at
 * every file boundary — or when the heartbeat reads `cancelRequestedAt` on the
 * row (`trigger()`), so a flag lost with Redis still stops the job.
 */
import type { PublisherCancelFlags } from './publisher-cancel-flags';
import { DOWNLOAD_CANCELLED_CODE } from './model-download-meta.util';

/** The abort reason of a cancelled job — never retried. */
export class PublisherJobCancelledError extends Error {
  readonly code = DOWNLOAD_CANCELLED_CODE;
  constructor(readonly jobId: string) {
    super(`${DOWNLOAD_CANCELLED_CODE}: download job ${jobId} was cancelled by an administrator`);
    this.name = 'PublisherJobCancelledError';
  }
}

export class PublisherCancelWatch {
  private readonly controller = new AbortController();
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly jobId: string,
    private readonly flags: PublisherCancelFlags | null | undefined,
    private readonly opts: { intervalMs: number; onError?: (error: Error) => void },
  ) {}

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  get cancelled(): boolean {
    return this.controller.signal.aborted;
  }

  /** Cancel now (the row says so, or the flag was seen). Idempotent. */
  trigger(): void {
    if (!this.cancelled) this.controller.abort(new PublisherJobCancelledError(this.jobId));
  }

  start(): void {
    if (this.timer || !this.flags) return;
    this.timer = setInterval(() => void this.poll(), this.opts.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** A file boundary: read the flag now, and throw the cancel reason if it is set. */
  async check(): Promise<void> {
    await this.poll();
    this.signal.throwIfAborted();
  }

  private async poll(): Promise<void> {
    if (this.cancelled || !this.flags) return;
    try {
      if (await this.flags.isRequested(this.jobId)) this.trigger();
    } catch (error) {
      // swallow-ok: a Redis blip only delays the cancel to the next poll (or the row's cancelRequestedAt).
      this.opts.onError?.(error instanceof Error ? error : new Error(String(error)));
    }
  }
}
