/**
 * Progress + liveness for one publish job (TASK-1019 D-4).
 *
 * Bytes arrive per network chunk — thousands of times a second — while the
 * row they are reported on is a Postgres JSON column behind optimistic
 * concurrency. So the heartbeat THROTTLES: at most one write per
 * `intervalMs`, never two in flight, and a failed write is reported and
 * dropped (the next interval retries). A missed heartbeat only ever makes the
 * row look staler; it must never fail the job it is reporting on.
 *
 * `start()` also beats on a timer, so the upload of one very large object —
 * during which no byte counter moves — still refreshes `heartbeatAt` and the
 * row is not mistaken for a stalled worker.
 */

export interface DownloadHeartbeatSnapshot {
  bytesDone: number;
  bytesTotal: number | null;
  heartbeatAt: string;
}

export interface DownloadHeartbeatOptions {
  intervalMs: number;
  now?: () => number;
  onError?: (error: Error) => void;
}

export class DownloadHeartbeat {
  private bytesDone = 0;
  private bytesTotal: number | null = null;
  private lastWriteAt = Number.NEGATIVE_INFINITY;
  private inFlight: Promise<void> | null = null;
  private timer: NodeJS.Timeout | null = null;
  private readonly now: () => number;

  constructor(
    private readonly write: (snapshot: DownloadHeartbeatSnapshot) => Promise<void>,
    private readonly opts: DownloadHeartbeatOptions,
  ) {
    this.now = opts.now ?? Date.now;
  }

  /** Bytes fetched so far. */
  get done(): number {
    return this.bytesDone;
  }

  get total(): number | null {
    return this.bytesTotal;
  }

  setTotal(bytesTotal: number): void {
    this.bytesTotal = bytesTotal;
    this.tick();
  }

  addBytes(bytes: number): void {
    this.bytesDone += bytes;
    this.tick();
  }

  /** Liveness only — no new bytes (e.g. between uploads). */
  beat(): void {
    this.tick();
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), this.opts.intervalMs);
    this.timer.unref?.();
  }

  /** Stop the timer and wait for any write in flight, so the caller's own write never races it. */
  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.inFlight;
  }

  private tick(): void {
    const now = this.now();
    if (this.inFlight || now - this.lastWriteAt < this.opts.intervalMs) return;
    this.lastWriteAt = now;
    const snapshot: DownloadHeartbeatSnapshot = { bytesDone: this.bytesDone, bytesTotal: this.bytesTotal, heartbeatAt: new Date(now).toISOString() };
    this.inFlight = this.write(snapshot)
      .catch((error: unknown) => this.opts.onError?.(error instanceof Error ? error : new Error(String(error))))
      .finally(() => {
        this.inFlight = null;
      });
  }
}
