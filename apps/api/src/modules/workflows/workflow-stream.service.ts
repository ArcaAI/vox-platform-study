import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { IWorkflowExposureService, TenantSettingsService, WorkflowRunStatusResponse } from '@arcaai/applications';
import { RESUME_FROM_BEGINNING, toSseFrame } from '@arcaai/async-contract';
import { ClsService } from 'nestjs-cls';
import type { Response } from 'express';
import { RunEventStreamHub } from './run-event-stream-hub';
import { terminalCheckIntervalMs, writeWithBackpressure } from './run-stream-delivery';
import { deliverRunEvents, parseClientCursor, resolveRunProtocol, terminalOutcomeOf } from './run-protocol-delivery';
import type { ClientCursor, RunPlane, RunProtocolVersion } from './run-protocol-delivery';
import { formatSseFrame, isTerminalRunStatus, runEventStreamKey } from './workflow-run-event';

/** TASK-1038 B3a — the stream request's protocol selection and cursor inputs (all optional). */
export interface RunStreamRequestOptions {
  /** `?protocol=` */
  protocol?: string;
  /** `x-hope-run-protocol` */
  protocolHeader?: string;
  /** `?after=<seq>` */
  after?: string;
  /** The legacy `?lastEventId=` query fallback. */
  legacyQuery?: string;
  /** Test/caller seam: abandon the stream. */
  signal?: AbortSignal;
}

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

  /**
   * `GET /workflows/:slug/runs/:runId/stream` — the BUSINESS plane (TASK-1038 B3a: protocol v2
   * when selected, the legacy shapes derived from v2 otherwise; the public event subset only).
   */
  async stream(slug: string, runId: string, res: Response, lastEventId?: string, options: RunStreamRequestOptions = {}): Promise<void> {
    // Pure request validation first: a 400 never costs a status read.
    const protocol = resolveRunProtocol({ header: options.protocolHeader, query: options.protocol });
    const cursor = parseClientCursor({ lastEventId, after: options.after, legacyQuery: options.legacyQuery }, protocol);
    // Pre-stream ownership check BEFORE any header is written — a 404 here is a normal HTTP
    // response, not a leaked 200 stream (the exact race `TenantOwnedResourceSseGuard`'s own doc
    // names for a bare @Sse() handler; this hand-rolled handler avoids it by construction,
    // since nothing is written until this resolves).
    const first = await this.workflowExposureService.getRunStatus(slug, runId);
    await this.deliver({
      runId,
      res,
      plane: 'public',
      protocol,
      cursor,
      initialStatus: first,
      // swallow-ok: a failed re-read means "ask again next interval", never a terminal status.
      readStatus: () => this.workflowExposureService.getRunStatus(slug, runId).catch(() => null),
      signal: options.signal,
    });
  }

  /**
   * Stream ANY run the caller already proved it may read — the admin trace (`plane: 'admin'`,
   * every stored event, §5) and the business plane share this. `readStatus` is both the
   * ownership check (it must throw `NotFoundException` for a foreign run) and the R-2 re-read.
   */
  async streamRun(input: {
    runId: string;
    res: Response;
    plane: RunPlane;
    protocol?: string;
    protocolHeader?: string;
    lastEventId?: string;
    after?: string;
    readStatus: () => Promise<WorkflowRunStatusResponse>;
    signal?: AbortSignal;
  }): Promise<void> {
    const protocol = resolveRunProtocol({ header: input.protocolHeader, query: input.protocol });
    const cursor = parseClientCursor({ lastEventId: input.lastEventId, after: input.after }, protocol);
    const first = await input.readStatus();
    await this.deliver({
      runId: input.runId,
      res: input.res,
      plane: input.plane,
      protocol,
      cursor,
      initialStatus: first,
      // swallow-ok: a failed re-read means "ask again next interval", never a terminal status.
      readStatus: () => input.readStatus().catch(() => null),
      signal: input.signal,
    });
  }

  private async deliver(input: {
    runId: string;
    res: Response;
    plane: RunPlane;
    protocol: RunProtocolVersion;
    cursor: ClientCursor;
    initialStatus: WorkflowRunStatusResponse;
    readStatus: () => Promise<WorkflowRunStatusResponse | null>;
    signal?: AbortSignal;
  }): Promise<void> {
    const { res } = input;
    const tenantId = this.clsService.get('tenantId') as string;

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    const closed = new AbortController();
    const onAbort = (): void => closed.abort();
    input.signal?.addEventListener('abort', onAbort, { once: true });
    // Legacy keeps its SSE comment heartbeat; v2 keeps alive with `ping` events (§6.3).
    const heartbeatTimer =
      input.protocol === 'legacy'
        ? setInterval(() => {
            if (!res.writableEnded) res.write(':keepalive\n\n');
          }, WORKFLOW_STREAM_HEARTBEAT_INTERVAL_MS)
        : null;
    const end = (): void => {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      input.signal?.removeEventListener('abort', onAbort);
      if (!closed.signal.aborted) closed.abort();
      if (!res.writableEnded) res.end();
    };
    res.on('close', end);

    try {
      await deliverRunEvents({
        hub: this.hub,
        runId: input.runId,
        tenantId,
        plane: input.plane,
        protocol: input.protocol,
        cursor: input.cursor,
        initialStatus: input.initialStatus,
        readStatus: input.readStatus,
        signal: closed.signal,
        terminalCheckMs: terminalCheckIntervalMs(this.settings),
        blockMs: WORKFLOW_STREAM_BLOCK_MS,
        heartbeatMs: WORKFLOW_STREAM_HEARTBEAT_INTERVAL_MS,
        // The pre-B3a loop's `!res.writableEnded` guard: an ended response issues no further read.
        beforeRead: () => Promise.resolve(!res.writableEnded),
        logger: this.logger,
        sink: {
          v2: (event) => writeWithBackpressure(res, toSseFrame(event), closed.signal),
          legacy: (envelope, resumeToken) => writeWithBackpressure(res, formatSseFrame(envelope, resumeToken), closed.signal),
        },
      });
    } finally {
      end();
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
        // A v2 terminal event (`run.completed|failed|cancelled`) or a pre-v2 `workflow.run.completed`.
        if (terminalOutcomeOf(runId, entry.fields) === null) continue;
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
}

/** Moved to `workflow-run-event.ts` (TASK-1038) so the stream hub can share it; re-exported here for existing importers. */
export { compareStreamIds } from './workflow-run-event';
