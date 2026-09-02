import { Inject, Injectable, Logger, OnModuleDestroy, Optional } from '@nestjs/common';
import { IConfigService, IWorkflowExposureService } from '@arcaai/applications';
import { RESUME_FROM_BEGINNING, decodeResumeToken, encodeResumeToken, parseAsyncEnvelope } from '@arcaai/async-contract';
import { ClsService } from 'nestjs-cls';
import Redis from 'ioredis';
import type { Response } from 'express';
import {
  RUN_EVENT_TRANSPORT,
  WORKFLOW_RUN_COMPLETED,
  buildWorkflowRunEventEnvelope,
  formatSseFrame,
  isTerminalRunStatus,
  runEventStreamKey,
} from './workflow-run-event';

/** How long a single blocking `XREAD` parks before looping. NOT a poll interval — the read
 *  RETURNS THE INSTANT the harness appends, so this is only the ceiling on how long the loop
 *  waits before re-checking its own liveness (client closed, response ended). */
export const WORKFLOW_STREAM_BLOCK_MS = 15_000;

/** SSE heartbeat cadence — mirrors `TextProxyController`'s own `SSE_HEARTBEAT_INTERVAL_MS`, so
 *  an idle connection is never mistaken for a dead one by an intermediate proxy/load balancer. */
export const WORKFLOW_STREAM_HEARTBEAT_INTERVAL_MS = 15_000;

/** Entries pulled per `XREAD`. Bounded so one very chatty run cannot monopolise the loop. */
const WORKFLOW_STREAM_READ_COUNT = 200;

/**
 * `WorkflowStreamService` — the gateway-side half of `GET /workflows/:slug/runs/:runId/stream`.
 *
 * **This service used to POLL, and the poll is gone (TASK-849 lane A).** Its previous class doc
 * explained why it had to: the interpreter dispatcher exposes no `text/event-stream` endpoint
 * (only `POST …:start`, `GET …/{runId}` and `POST …:cancel`, all plain JSON), and TASK-717
 * shipped the async-contract envelope + resume-token package while explicitly deferring
 * "Phase C" — a reference PRODUCER wired into a service. There was nothing upstream to consume.
 *
 * That producer now exists (`apps/harness/.../interpreter/run_events.py`), so this reads the
 * run's Redis Stream with a blocking `XREAD` instead of re-asking the dispatcher every two
 * seconds. It is the same mechanism `TextStreamConsumerService` already uses for TEXT chunks —
 * reused, not reinvented (F-21).
 *
 * **The client contract is snapshot-then-delta.**
 *
 * 1. **Snapshot.** ONE `getRunStatus` read (which also performs the pre-stream tenant-ownership
 *    check, before any header is written — a 404 here is a normal HTTP response, never a leaked
 *    200 stream). It is written as a `workflow.run.progress` / `workflow.run.completed` envelope,
 *    exactly the shape the polling version emitted, so an existing client keeps working.
 *    It carries NO `id:` line: a snapshot is not a stream position, and async-contract §3.6
 *    forbids minting a resume token the transport did not assign.
 * 2. **Deltas.** Every subsequent frame is one producer envelope, and its `id:` IS the opaque
 *    resume token wrapping Redis' own message id. The browser echoes it back as `Last-Event-ID`
 *    on reconnect, and never parses it.
 * 3. **Reconnect.** `Last-Event-ID` decodes to the cursor and the read resumes from exactly
 *    there — nothing between the two connections is lost.
 * 4. **Trimmed-id gap.** The producer's stream is `MAXLEN`-bounded, so a client that was away
 *    long enough may name a cursor Redis has already evicted. Redis does not report that: an
 *    `XREAD` from an evicted id silently returns whatever survived, which would hand the client
 *    a hole it cannot see. So the gap is detected explicitly (compare the cursor against the
 *    oldest RETAINED id) and answered by RE-SNAPSHOTTING — the client is told the truth by
 *    resynchronising, never by pretending the missing events did not exist.
 *
 * Redis being unreachable is not fatal here either: the snapshot is still written and the
 * stream ends. The client sees a truthful terminal-or-current state rather than a hang.
 */
@Injectable()
export class WorkflowStreamService implements OnModuleDestroy {
  private readonly logger = new Logger(WorkflowStreamService.name);
  private readerRedis: Redis | null = null;
  private redisUnavailable = false;

  constructor(
    @Inject(IWorkflowExposureService) private readonly workflowExposureService: IWorkflowExposureService,
    private readonly clsService: ClsService,
    @Optional() @Inject(IConfigService) private readonly configService?: IConfigService,
  ) {}

  async onModuleDestroy(): Promise<void> {
    if (this.readerRedis) {
      await this.readerRedis.quit().catch(() => {});
      this.readerRedis = null;
    }
  }

  async stream(slug: string, runId: string, res: Response, lastEventId?: string): Promise<void> {
    // Pre-stream ownership check BEFORE any header is written — a 404 here is a normal HTTP
    // response, not a leaked 200 stream (the exact race `TenantOwnedResourceSseGuard`'s own doc
    // names for a bare @Sse() handler; this hand-rolled handler avoids it by construction,
    // since nothing is written until this resolves).
    const first = await this.workflowExposureService.getRunStatus(slug, runId);
    const tenantId = this.clsService.get('tenantId') as string;

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    this.writeSnapshot(res, tenantId, first);
    if (isTerminalRunStatus(first.status)) {
      res.end();
      return;
    }

    const redis = this.reader();
    if (redis === null) {
      // No push transport. Ending is the honest answer: the snapshot above is real and the
      // client can reconnect. Hanging on a stream that can never deliver would be worse.
      this.logger.warn({ message: 'Redis unavailable — workflow run stream ends after snapshot', runId });
      res.end();
      return;
    }

    const state = { ended: false };
    const end = (): void => {
      if (state.ended) return;
      state.ended = true;
      clearInterval(heartbeatTimer);
      if (!res.writableEnded) res.end();
    };

    const heartbeatTimer = setInterval(() => {
      if (!res.writableEnded) res.write(':keepalive\n\n');
    }, WORKFLOW_STREAM_HEARTBEAT_INTERVAL_MS);

    res.on('close', end);

    await this.consume(redis, slug, runId, res, tenantId, lastEventId, state);
    end();
  }

  /**
   * Read the run's stream until it terminates, the client disconnects, or the response ends.
   *
   * The cursor starts at the resume token's own position, or at the beginning of the retained
   * stream on a first connect. Starting at the BEGINNING (rather than at `$`) is deliberate:
   * a client that connects a moment after a node completed must still learn that it did, and
   * re-delivering an event the snapshot already reflected is harmless precisely because every
   * envelope's `idempotencyKey` is derived from intent (async-contract §3.5) — which is what
   * makes the duplicate collapsible rather than a second, contradictory fact.
   */
  private async consume(
    redis: Redis,
    slug: string,
    runId: string,
    res: Response,
    tenantId: string,
    lastEventId: string | undefined,
    state: { ended: boolean },
  ): Promise<void> {
    const streamKey = runEventStreamKey(runId);
    let cursor = this.resolveCursor(lastEventId);

    if (cursor !== RESUME_FROM_BEGINNING && (await this.hasTrimmedGap(redis, streamKey, cursor))) {
      // The client's position was evicted by the producer's MAXLEN trim. There is no gap-fill
      // available, so tell it the current truth instead of silently skipping the hole.
      const resync = await this.workflowExposureService.getRunStatus(slug, runId);
      this.writeSnapshot(res, tenantId, resync);
      if (isTerminalRunStatus(resync.status)) return;
      cursor = RESUME_FROM_BEGINNING;
    }

    while (!state.ended && !res.writableEnded) {
      let entries: [string, string[]][];
      try {
        const result = await redis.xread('COUNT', WORKFLOW_STREAM_READ_COUNT, 'BLOCK', WORKFLOW_STREAM_BLOCK_MS, 'STREAMS', streamKey, cursor);
        if (!result) continue; // BLOCK expired with nothing new — loop and re-check liveness.
        entries = result[0][1] as [string, string[]][];
      } catch (err) {
        // Never forward the raw error to the client (it may echo transport-internal detail) —
        // just end the stream, mirroring the SSE proxy exemplar's own posture.
        this.logger.warn({
          message: 'Workflow run stream read failed — ending stream',
          runId,
          error: err instanceof Error ? err.message : String(err),
        });
        return;
      }

      for (const [entryId, fields] of entries) {
        cursor = entryId;
        const envelope = this.parseEntry(fields);
        if (envelope === null) continue;
        if (res.writableEnded) return;
        // The `id:` line is the RESUME TOKEN, not the envelope's own identity: it is what the
        // browser echoes back as `Last-Event-ID`, and only a transport-assigned cursor can
        // actually resume (§3.6).
        res.write(formatSseFrame(envelope, encodeResumeToken(RUN_EVENT_TRANSPORT, entryId)));
        if (envelope.type === WORKFLOW_RUN_COMPLETED) return;
      }
    }
  }

  /** `Last-Event-ID` -> a Redis stream cursor, or "from the beginning" when absent/unusable. */
  private resolveCursor(lastEventId: string | undefined): string {
    if (!lastEventId) return RESUME_FROM_BEGINNING;
    const decoded = decodeResumeToken(lastEventId);
    if (decoded === null || decoded.transport !== RUN_EVENT_TRANSPORT) {
      // A malformed or foreign-transport token is a client error, not a reason to fail the
      // request: resync from the beginning of what is retained rather than 400 a reconnect.
      return RESUME_FROM_BEGINNING;
    }
    return decoded.cursor;
  }

  /**
   * Has the producer's `MAXLEN` trim already evicted the client's position?
   *
   * Redis will not say so — an `XREAD` from an evicted id returns the surviving tail with no
   * error — so this compares the cursor against the OLDEST RETAINED entry.
   *
   * The comparison is deliberately CONSERVATIVE: any oldest-retained id newer than the cursor
   * counts as a gap, because Redis cannot distinguish "the next entry" from "what survived the
   * trim". A false positive costs one extra snapshot read; a false negative silently drops
   * clinical events a client believes it received. In practice it almost never fires — the
   * cursor names an entry the client was just delivered, so that entry is normally still
   * retained and the oldest id is at or before it.
   */
  private async hasTrimmedGap(redis: Redis, streamKey: string, cursor: string): Promise<boolean> {
    try {
      const oldest = await redis.xrange(streamKey, '-', '+', 'COUNT', 1);
      if (oldest.length === 0) return false; // Nothing retained yet: no gap, just no data.
      return compareStreamIds(oldest[0][0], cursor) > 0;
    } catch {
      return false;
    }
  }

  private parseEntry(fields: string[]): ReturnType<typeof parseAsyncEnvelope> {
    for (let i = 0; i < fields.length; i += 2) {
      if (fields[i] !== 'data') continue;
      try {
        // Refuse-if-unknown: an entry this gateway does not understand is skipped, never
        // best-effort forwarded to a client that would understand it even less.
        return parseAsyncEnvelope(JSON.parse(fields[i + 1]));
      } catch {
        return null;
      }
    }
    return null;
  }

  private reader(): Redis | null {
    if (this.readerRedis) return this.readerRedis;
    if (this.redisUnavailable) return null;
    if (!this.configService?.isRedisConfigured()) {
      this.redisUnavailable = true;
      return null;
    }
    const config = this.configService.getRedisConfig();
    // A DEDICATED connection, like `TextStreamConsumerService`'s: a blocking `XREAD` occupies
    // its connection for the whole BLOCK window, so sharing the cache client would stall every
    // other consumer behind it.
    this.readerRedis = new Redis({
      host: config.host,
      port: config.port,
      password: config.password,
      maxRetriesPerRequest: null,
      lazyConnect: false,
    });
    return this.readerRedis;
  }

  private writeSnapshot(res: Response, tenantId: string, status: Parameters<typeof buildWorkflowRunEventEnvelope>[1]): void {
    if (res.writableEnded) return;
    // No `id:` — see the class doc, step 1.
    res.write(formatSseFrame(buildWorkflowRunEventEnvelope(tenantId, status)));
  }
}

/**
 * Order two Redis stream ids (`<ms>-<seq>`). Returns 1 / 0 / -1 like a comparator.
 *
 * String comparison is WRONG here and quietly so: `"10-0" < "9-0"` lexically, so a stream that
 * crosses a digit boundary would report a phantom gap. Both halves are compared numerically.
 */
export function compareStreamIds(left: string, right: string): number {
  const [leftMs, leftSeq] = left.split('-').map((part) => Number(part));
  const [rightMs, rightSeq] = right.split('-').map((part) => Number(part));
  if (leftMs !== rightMs) return leftMs > rightMs ? 1 : -1;
  if (leftSeq !== rightSeq) return leftSeq > rightSeq ? 1 : -1;
  return 0;
}
