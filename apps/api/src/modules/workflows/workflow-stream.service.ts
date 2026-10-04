import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { IWorkflowExposureService, TenantSettingsService, WorkflowRunStatusResponse } from '@arcaai/applications';
import { RESUME_FROM_BEGINNING, decodeResumeToken, encodeResumeToken } from '@arcaai/async-contract';
import { ClsService } from 'nestjs-cls';
import type { Response } from 'express';
import { RunEventStreamHub } from './run-event-stream-hub';
import { parseRunStreamEntry, terminalCheckIntervalMs, writeWithBackpressure } from './run-stream-delivery';
import {
  RUN_EVENT_TRANSPORT,
  WORKFLOW_RUN_COMPLETED,
  buildWorkflowRunEventEnvelope,
  compareStreamIds,
  formatSseFrame,
  isTerminalRunStatus,
  runEventStreamKey,
} from './workflow-run-event';

/** How long a single read waits for new entries before looping. NOT a poll interval — the read
 *  RETURNS THE INSTANT the harness appends, so this is only the ceiling on how long the loop
 *  waits before re-checking its own liveness (client closed, response ended). */
export const WORKFLOW_STREAM_BLOCK_MS = 15_000;

/** SSE heartbeat cadence — mirrors `TextProxyController`'s own `SSE_HEARTBEAT_INTERVAL_MS`, so
 *  an idle connection is never mistaken for a dead one by an intermediate proxy/load balancer. */
export const WORKFLOW_STREAM_HEARTBEAT_INTERVAL_MS = 15_000;

/**
 * `WorkflowStreamService` — the gateway-side half of `GET /workflows/:slug/runs/:runId/stream`.
 *
 * **This service used to POLL, and the poll is gone.** Its previous class doc
 * explained why it had to: the interpreter dispatcher exposes no `text/event-stream` endpoint
 * (only `POST …:start`, `GET …/{runId}` and `POST …:cancel`, all plain JSON), and
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
 * It carries NO `id:` line: a snapshot is not a stream position, and async-contract
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
 *
 * **TASK-1038.** Reads go through the process-wide `RunEventStreamHub` (one multiplexed `XREAD`,
 * R-1) instead of a per-service connection every stream queued on. An idle stream re-reads the
 * run's status every `workflowRuns.streamTerminalCheckSeconds` and closes with a terminal
 * snapshot when the run already ended but its completion event never arrived (R-2). Every frame
 * honours the socket's backpressure (R-9). Observing the terminal event starts the stream's
 * retention clock (`workflowRuns.eventRetentionHours`, OD-25).
 */
@Injectable()
export class WorkflowStreamService {
  private readonly logger = new Logger(WorkflowStreamService.name);

  constructor(
    @Inject(IWorkflowExposureService) private readonly workflowExposureService: IWorkflowExposureService,
    private readonly clsService: ClsService,
    // TASK-1038 — the ONE multiplexed reader. `@Optional()` so a Nest context without it (or
    // without Redis) degrades to snapshot-only, exactly as an unconfigured Redis always did.
    @Optional() private readonly hub?: RunEventStreamHub,
    @Optional() private readonly settings?: TenantSettingsService,
  ) {}

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

    if (!this.hub?.available()) {
      // No push transport. Ending is the honest answer: the snapshot above is real and the
      // client can reconnect. Hanging on a stream that can never deliver would be worse.
      this.logger.warn({ message: 'Redis unavailable — workflow run stream ends after snapshot', runId });
      res.end();
      return;
    }

    const closed = new AbortController();
    const heartbeatTimer = setInterval(() => {
      if (!res.writableEnded) res.write(':keepalive\n\n');
    }, WORKFLOW_STREAM_HEARTBEAT_INTERVAL_MS);
    const end = (): void => {
      clearInterval(heartbeatTimer);
      if (!closed.signal.aborted) closed.abort();
      if (!res.writableEnded) res.end();
    };
    res.on('close', end);

    try {
      await this.consume(this.hub, slug, runId, res, tenantId, lastEventId, closed.signal);
    } finally {
      end();
    }
  }

  /**
   * Read the run's stream until it terminates, the client disconnects, or the response ends.
   *
   * The cursor starts at the resume token's own position, or at the beginning of the retained
   * stream on a first connect. Starting at the BEGINNING (rather than at `$`) is deliberate:
   * a client that connects a moment after a node completed must still learn that it did, and
   * re-delivering an event the snapshot already reflected is harmless precisely because every
   * envelope's `idempotencyKey` is derived from intent (async-contract) — which is what
   * makes the duplicate collapsible rather than a second, contradictory fact.
   */
  private async consume(
    hub: RunEventStreamHub,
    slug: string,
    runId: string,
    res: Response,
    tenantId: string,
    lastEventId: string | undefined,
    closed: AbortSignal,
  ): Promise<void> {
    const streamKey = runEventStreamKey(runId);
    let cursor = this.resolveCursor(lastEventId);

    if (cursor !== RESUME_FROM_BEGINNING && (await this.hasTrimmedGap(hub, streamKey, cursor))) {
      // The client's position was evicted by the producer's MAXLEN trim. There is no gap-fill
      // available, so tell it the current truth instead of silently skipping the hole.
      const resync = await this.workflowExposureService.getRunStatus(slug, runId);
      this.writeSnapshot(res, tenantId, resync);
      if (isTerminalRunStatus(resync.status)) return;
      cursor = RESUME_FROM_BEGINNING;
    }

    const checkEveryMs = terminalCheckIntervalMs(this.settings);
    let lastStatusCheck = Date.now();

    while (!closed.aborted && !res.writableEnded) {
      let entries;
      try {
        entries = await hub.read(streamKey, cursor, { timeoutMs: Math.min(WORKFLOW_STREAM_BLOCK_MS, checkEveryMs), signal: closed });
      } catch (err) {
        // Never forward the raw error to the client (it may echo transport-internal detail) —
        // just end the stream, mirroring the SSE proxy exemplar's own posture. The client
        // reconnects with its last `id:` and loses nothing.
        this.logger.warn({
          message: 'Workflow run stream read failed — ending stream',
          runId,
          error: err instanceof Error ? err.message : String(err),
        });
        return;
      }

      if (entries.length === 0) {
        if (closed.aborted || res.writableEnded) return;
        if (Date.now() - lastStatusCheck < checkEveryMs) continue;
        lastStatusCheck = Date.now();
        // R-2 — the terminal fallback. Without it a lost `workflow.run.completed` left this
        // stream open forever, heartbeating over a run that had already ended.
        // swallow-ok: the terminal re-check is a fallback; a failed read just waits for the next interval.
        const status = await this.workflowExposureService.getRunStatus(slug, runId).catch(() => null);
        if (!status || !isTerminalRunStatus(status.status)) continue;
        // Deliver whatever IS retained first, so the close never overtakes a real event.
        // swallow-ok: an unreadable tail still closes with the terminal snapshot, which is the truth the client needs.
        const tail = await hub.readNow(streamKey, cursor).catch(() => []);
        for (const entry of tail) {
          cursor = entry.id;
          const envelope = parseRunStreamEntry(entry.fields);
          if (envelope === null) continue;
          if (!(await writeWithBackpressure(res, formatSseFrame(envelope, encodeResumeToken(RUN_EVENT_TRANSPORT, entry.id)), closed))) return;
          if (envelope.type === WORKFLOW_RUN_COMPLETED) {
            void hub.expireAfterTerminal(runId);
            return;
          }
        }
        this.logger.warn({ message: 'Run ended without a completion event reaching its stream — closing with a terminal snapshot', runId });
        this.writeSnapshot(res, tenantId, status);
        void hub.expireAfterTerminal(runId);
        return;
      }

      for (const entry of entries) {
        cursor = entry.id;
        const envelope = parseRunStreamEntry(entry.fields);
        if (envelope === null) continue;
        // The `id:` line is the RESUME TOKEN, not the envelope's own identity: it is what the
        // browser echoes back as `Last-Event-ID`, and only a transport-assigned cursor can
        // actually resume.
        const frame = formatSseFrame(envelope, encodeResumeToken(RUN_EVENT_TRANSPORT, entry.id));
        if (!(await writeWithBackpressure(res, frame, closed))) return;
        if (envelope.type === WORKFLOW_RUN_COMPLETED) {
          void hub.expireAfterTerminal(runId);
          return;
        }
      }
    }
  }

  /**
   * Wait for a run to reach a terminal status, or give up at `ceilingMs`
   * step 7 — the BLOCKING response mode).
   *
   * Returns the terminal status, or `null` when the ceiling arrives first. `null` is not an
   * error and must not be reported as one by the caller's own logic beyond the 504: the run is
   * still going, and the caller can still reach it through `statusUrl` / `streamUrl`.
   *
   * **This is the SAME transport the SSE path reads, not a second one.** Blocking mode is the
   * streaming mode with the frames thrown away — one reader, one producer, one terminal
   * definition (`WORKFLOW_RUN_COMPLETED`, cross-checked against the status snapshot). The only
   * status re-read is the R-2 terminal fallback, at the platform's terminal-check cadence and
   * only while the stream is idle — it exists for a completion event that was lost, not as a
   * second progress mechanism (F-21).
   *
   * **A client disconnect does not reach this method.** It has no `Response` and registers no
   * `close` handler: the run's lifetime is Temporal's, and abandoning the HTTP request abandons
   * only the wait. That is the durable-execution guarantee, and it is a property of what this
   * method does NOT do.
   */
  async awaitTerminal(slug: string, runId: string, ceilingMs: number): Promise<WorkflowRunStatusResponse | null> {
    const deadline = Date.now() + ceilingMs;

    // One authoritative read first: a run that is ALREADY terminal (a fast graph, or a retry
    // that joined a finished run) publishes nothing more, so waiting on the stream would burn
    // the whole ceiling and then 504 on a completed run. This read also performs the
    // tenant-ownership check, exactly as the SSE path's snapshot does.
    const snapshot = await this.workflowExposureService.getRunStatus(slug, runId);
    if (isTerminalRunStatus(snapshot.status)) return snapshot;

    const hub = this.hub;
    // No push transport: the honest answer is "I cannot tell you here". A 504 pointing at the
    // status URL beats silently polling, and beats claiming a completion nothing observed.
    if (!hub?.available()) return null;

    const streamKey = runEventStreamKey(runId);
    const checkEveryMs = terminalCheckIntervalMs(this.settings);
    let lastStatusCheck = Date.now();
    let cursor = RESUME_FROM_BEGINNING;

    while (Date.now() < deadline) {
      const wait = Math.max(1, Math.min(WORKFLOW_STREAM_BLOCK_MS, checkEveryMs, deadline - Date.now()));
      let entries;
      try {
        entries = await hub.read(streamKey, cursor, { timeoutMs: wait });
      } catch (err) {
        this.logger.warn({
          message: 'Workflow run blocking wait read failed — falling back to the status read',
          runId,
          error: err instanceof Error ? err.message : String(err),
        });
        break;
      }

      for (const entry of entries) {
        cursor = entry.id;
        const envelope = parseRunStreamEntry(entry.fields);
        if (envelope?.type !== WORKFLOW_RUN_COMPLETED) continue;
        void hub.expireAfterTerminal(runId);
        // The producer says it is done; re-read the authoritative status so the caller gets the
        // same shape (and the same `resultRef`) the async and streaming paths return.
        return this.workflowExposureService.getRunStatus(slug, runId);
      }

      if (entries.length === 0 && Date.now() - lastStatusCheck >= checkEveryMs) {
        lastStatusCheck = Date.now();
        // swallow-ok: the terminal re-check is a fallback; a failed read just waits for the next interval.
        const status = await this.workflowExposureService.getRunStatus(slug, runId).catch(() => null);
        if (status && isTerminalRunStatus(status.status)) {
          void hub.expireAfterTerminal(runId);
          return status;
        }
      }
    }

    // Deadline reached, or the transport failed. One last authoritative read closes the race
    // where the run finished between the final wait expiring and this line.
    const final = await this.workflowExposureService.getRunStatus(slug, runId);
    return isTerminalRunStatus(final.status) ? final : null;
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
  private async hasTrimmedGap(hub: RunEventStreamHub, streamKey: string, cursor: string): Promise<boolean> {
    try {
      const oldest = await hub.oldestEntryId(streamKey);
      if (oldest === null) return false; // Nothing retained yet: no gap, just no data.
      return compareStreamIds(oldest, cursor) > 0;
    } catch {
      return false;
    }
  }

  private writeSnapshot(res: Response, tenantId: string, status: Parameters<typeof buildWorkflowRunEventEnvelope>[1]): void {
    if (res.writableEnded) return;
    // No `id:` — see the class doc, step 1.
    res.write(formatSseFrame(buildWorkflowRunEventEnvelope(tenantId, status)));
  }
}

/** Moved to `workflow-run-event.ts` (TASK-1038) so the stream hub can share it; re-exported here for existing importers. */
export { compareStreamIds } from './workflow-run-event';
