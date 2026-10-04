import {
  IOriginRegistry,
  IWorkflowExposureService,
  TenantSettingsService,
  WORKFLOW_RUNS_DEFAULTS,
  WORKFLOW_RUNS_WS_MAX_BUFFERED_BYTES_KEY,
  WorkflowRunStatusResponse,
} from '@arcaai/applications';
import { RESUME_FROM_BEGINNING, decodeResumeToken, encodeResumeToken } from '@arcaai/async-contract';
import { Inject, Logger, Optional } from '@nestjs/common';
import { OnGatewayConnection, WebSocketGateway } from '@nestjs/websockets';
import type { IncomingMessage } from 'http';
import { ClsService } from 'nestjs-cls';
import type WebSocket from 'ws';
import { isOriginEnforcementEnabled } from '../../cors.config';
import { StreamTicketService } from '../auth/stream-ticket.service';
import { logWsFailure } from './ws-failure-log';
import { RunEventStreamHub } from '../workflows/run-event-stream-hub';
import { parseRunStreamEntry, terminalCheckIntervalMs } from '../workflows/run-stream-delivery';
import {
  RUN_EVENT_TRANSPORT,
  WORKFLOW_RUN_COMPLETED,
  buildWorkflowRunEventEnvelope,
  compareStreamIds,
  isTerminalRunStatus,
  runEventStreamKey,
} from '../workflows/workflow-run-event';

/** One generic close for every handshake failure — no enumeration signal (the STT gateway's rule). */
export const WORKFLOW_WS_CLOSE_AUTH_FAILED = 4401;
export const WORKFLOW_WS_GENERIC_AUTH_REASON = 'Authentication failed';
/** The stream-ticket scope namespace — the SAME one the SSE route consumes. */
export const WORKFLOW_RUN_TICKET_NAMESPACE = 'workflow_run';
const BLOCK_MS = 15_000;
const HEARTBEAT_MS = 15_000;
/** How often a paused (backpressured) socket's `bufferedAmount` is re-read — a local property, not I/O. */
const DRAIN_CHECK_MS = 25;

/**
 * `WorkflowWsGateway` — TASK-864 §3.4, the `socket` publish protocol:
 * `WS /ws/workflows?slug=<slug>&runId=<runId>&ticket=<ticket>[&lastEventId=<token>]`.
 *
 * The SAME frames as `GET /workflows/{slug}/runs/{runId}/stream`, over a WebSocket, for hosts
 * that cannot hold an SSE connection (mobile webviews). Each text message is one JSON object
 * `{ event, id?, data }` — `event` the envelope type, `id` the opaque resume token (echo it back
 * as `lastEventId` on reconnect), `data` the envelope — so a client written against the SSE
 * route needs no second parser. Snapshot-then-delta, exactly like the SSE route: the first
 * message is a snapshot (no `id`), every later one is a producer envelope forwarded verbatim.
 *
 * Authentication is a SINGLE-USE stream ticket scoped `workflow_run:<runId>` (`POST
 * /auth/stream-ticket`), which the auth controller already binds to the caller's tenant at mint
 * time — never a JWT in the URL. The ticket only proves the ticket was minted for this run; the
 * run's OWNERSHIP is then re-checked through `getRunStatus` inside a CLS context carrying the
 * ticket's tenant, so a cross-tenant run id is a 404 there and a generic close here.
 *
 * Query parameters rather than the ticket's `/ws/workflows/{slug}/runs/{runId}` path shape:
 * the `ws` adapter matches a gateway's `path` EXACTLY, so a per-run path cannot be routed to
 * one gateway. Recorded as a deviation from the ticket's URL wording; the contract is the same.
 *
 * TASK-1038 — parity with the SSE route, on the same shared `RunEventStreamHub` (R-1):
 * - G11: a `lastEventId` the producer's MAXLEN trim already evicted is answered with a resync
 *   snapshot (no `id`), then the retained events — the socket used to resume from the surviving
 *   tail silently, handing the client a hole it could not see.
 * - R-9: while the client's unsent buffer is above `workflowRuns.wsMaxBufferedBytes` the gateway
 *   sends nothing and asks the hub for nothing; the events wait in the stream, not in memory.
 * - R-2: an idle socket re-checks the run every `workflowRuns.streamTerminalCheckSeconds` and
 *   closes with a terminal snapshot when the completion event was lost.
 */
@WebSocketGateway({ path: '/ws/workflows' })
export class WorkflowWsGateway implements OnGatewayConnection {
  private readonly logger = new Logger(WorkflowWsGateway.name);

  constructor(
    private readonly streamTicketService: StreamTicketService,
    @Inject(IWorkflowExposureService) private readonly workflowExposureService: IWorkflowExposureService,
    private readonly cls: ClsService,
    // TASK-1038 — the shared multiplexed reader (from the @Global() `WorkflowRunCompletionModule`).
    // Absent or unconfigured ⇒ snapshot then 1011, exactly as an unconfigured Redis always did.
    @Optional() private readonly hub?: RunEventStreamHub,
    @Optional() @Inject(IOriginRegistry) private readonly originRegistry?: IOriginRegistry,
    @Optional() private readonly settings?: TenantSettingsService,
  ) {}

  async handleConnection(client: WebSocket, req: IncomingMessage): Promise<void> {
    const reject = (message: string): void => {
      this.logger.warn({ message: `workflow WS handshake rejected — ${message}` });
      client.close(WORKFLOW_WS_CLOSE_AUTH_FAILED, WORKFLOW_WS_GENERIC_AUTH_REASON);
    };

    // CSWSH guard — the STT gateway's posture: no Origin = non-browser = allowed; a browser
    // origin must be registered when enforcement is on.
    const origin = req.headers?.origin;
    if (typeof origin === 'string' && origin.length > 0 && !(await this.isOriginAllowed(origin))) return reject('unregistered origin');

    const url = new URL(req.url || '', 'http://localhost');
    const slug = url.searchParams.get('slug');
    const runId = url.searchParams.get('runId');
    const ticket = url.searchParams.get('ticket');
    const lastEventId = url.searchParams.get('lastEventId') ?? undefined;
    if (!slug || !runId || !ticket) return reject('missing slug, runId or ticket');

    const stored = await this.streamTicketService.consumeTicket(ticket);
    if (!stored) return reject('invalid stream ticket');
    if (stored.scope !== `${WORKFLOW_RUN_TICKET_NAMESPACE}:${runId}`) return reject('ticket scope mismatch');
    if (!stored.tenantId) return reject('ticket carries no tenant');
    const tenantId = stored.tenantId;

    // Ownership + snapshot, under the ticket's tenant. `getRunStatus` is the SSE route's own
    // pre-stream check: a foreign or unknown run is a NotFoundException here.
    const readStatus = (): Promise<WorkflowRunStatusResponse> =>
      this.cls.run(async () => {
        this.cls.set('tenantId', tenantId);
        this.cls.set('user', { id: stored.userId, tenantId, roles: [] });
        return this.workflowExposureService.getRunStatus(slug, runId);
      });
    let snapshot: WorkflowRunStatusResponse;
    try {
      snapshot = await readStatus();
    } catch (err) {
      // The close stays generic (no enumeration signal); the reason does not
      // vanish — a 404 is the expected case, anything else is worth seeing.
      this.logger.warn({
        message: 'workflow WS run lookup failed',
        runId,
        tenantId,
        errorName: err instanceof Error ? err.name : typeof err,
      });
      return reject('run not found for this ticket');
    }

    this.sendSnapshot(client, tenantId, snapshot);
    if (isTerminalRunStatus(snapshot.status)) {
      client.close(1000, 'run completed');
      return;
    }

    const hub = this.hub;
    if (!hub?.available()) {
      // No push transport: the snapshot above is honest and the client can reconnect.
      client.close(1011, 'stream transport unavailable');
      return;
    }

    const closed = new AbortController();
    client.on('close', () => closed.abort());
    const heartbeat = setInterval(() => {
      if (!closed.signal.aborted && client.readyState === client.OPEN) client.ping();
    }, HEARTBEAT_MS);

    try {
      await this.forward(hub, client, runId, tenantId, lastEventId, readStatus, closed.signal);
    } finally {
      clearInterval(heartbeat);
      if (!closed.signal.aborted && client.readyState === client.OPEN) client.close(1000, 'run completed');
    }
  }

  /** The same cursor/resume/gap/terminal contract as `WorkflowStreamService.consume`. */
  private async forward(
    hub: RunEventStreamHub,
    client: WebSocket,
    runId: string,
    tenantId: string,
    lastEventId: string | undefined,
    readStatus: () => Promise<WorkflowRunStatusResponse>,
    closed: AbortSignal,
  ): Promise<void> {
    const streamKey = runEventStreamKey(runId);
    const decoded = lastEventId ? decodeResumeToken(lastEventId) : null;
    let cursor = decoded && decoded.transport === RUN_EVENT_TRANSPORT ? decoded.cursor : RESUME_FROM_BEGINNING;

    // G11 — the client's position was evicted by the producer's MAXLEN trim. Same conservative
    // test as SSE (oldest retained id newer than the cursor), same honest answer: a resync
    // snapshot, then everything still retained.
    if (cursor !== RESUME_FROM_BEGINNING && (await this.hasTrimmedGap(hub, streamKey, cursor))) {
      const resync = await readStatus().catch(() => null);
      if (resync) {
        this.sendSnapshot(client, tenantId, resync);
        if (isTerminalRunStatus(resync.status)) return;
      }
      cursor = RESUME_FROM_BEGINNING;
    }

    const maxBuffered = this.maxBufferedBytes();
    const checkEveryMs = terminalCheckIntervalMs(this.settings);
    let lastStatusCheck = Date.now();

    while (!closed.aborted) {
      // R-9 — a client that is behind gets no new read until it catches up.
      if (!(await this.awaitBufferBelow(client, maxBuffered, closed))) return;
      let entries;
      try {
        entries = await hub.read(streamKey, cursor, { timeoutMs: Math.min(BLOCK_MS, checkEveryMs), signal: closed });
      } catch (err) {
        logWsFailure(this.logger, { message: 'workflow WS read failed — closing', level: 'warn', runId, closeCode: 1000 }, err);
        return;
      }

      if (entries.length === 0) {
        if (closed.aborted || Date.now() - lastStatusCheck < checkEveryMs) continue;
        lastStatusCheck = Date.now();
        // R-2 — the terminal fallback, as on SSE.
        const status = await readStatus().catch(() => null);
        if (!status || !isTerminalRunStatus(status.status)) continue;
        const tail = await hub.readNow(streamKey, cursor).catch(() => []);
        entries = tail;
        if (!(await this.deliver(hub, client, runId, entries, closed, maxBuffered, (id) => (cursor = id)))) {
          this.logger.warn({ message: 'Run ended without a completion event reaching its stream — closing with a terminal snapshot', runId });
          this.sendSnapshot(client, tenantId, status);
          void hub.expireAfterTerminal(runId);
        }
        return;
      }

      if (await this.deliver(hub, client, runId, entries, closed, maxBuffered, (id) => (cursor = id))) return;
    }
  }

  /** Send a batch; `true` once the completion event went out (the stream is done). */
  private async deliver(
    hub: RunEventStreamHub,
    client: WebSocket,
    runId: string,
    entries: { id: string; fields: string[] }[],
    closed: AbortSignal,
    maxBuffered: number,
    advance: (id: string) => void,
  ): Promise<boolean> {
    for (const entry of entries) {
      advance(entry.id);
      const envelope = parseRunStreamEntry(entry.fields);
      if (envelope === null) continue;
      if (!(await this.awaitBufferBelow(client, maxBuffered, closed))) return true;
      this.send(client, { event: envelope.type, id: encodeResumeToken(RUN_EVENT_TRANSPORT, entry.id), data: envelope });
      if (envelope.type === WORKFLOW_RUN_COMPLETED) {
        void hub.expireAfterTerminal(runId);
        return true;
      }
    }
    return false;
  }

  /**
   * R-9 — wait until the socket's unsent buffer is at or below `max`. `ws` exposes no `drain`
   * event on the socket object, so this re-reads the local `bufferedAmount` property on a short
   * timer — no I/O, and only while the client is actually behind. `false` when the client left.
   */
  private async awaitBufferBelow(client: WebSocket, max: number, closed: AbortSignal): Promise<boolean> {
    while ((client.bufferedAmount ?? 0) > max) {
      if (closed.aborted || client.readyState !== client.OPEN) return false;
      await new Promise((resolve) => setTimeout(resolve, DRAIN_CHECK_MS));
    }
    return !closed.aborted;
  }

  private async hasTrimmedGap(hub: RunEventStreamHub, streamKey: string, cursor: string): Promise<boolean> {
    try {
      const oldest = await hub.oldestEntryId(streamKey);
      return oldest !== null && compareStreamIds(oldest, cursor) > 0;
    } catch {
      return false;
    }
  }

  private maxBufferedBytes(): number {
    try {
      const value = this.settings?.resolvePlatform<number>(WORKFLOW_RUNS_WS_MAX_BUFFERED_BYTES_KEY).value;
      return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : WORKFLOW_RUNS_DEFAULTS.wsMaxBufferedBytes;
    } catch {
      return WORKFLOW_RUNS_DEFAULTS.wsMaxBufferedBytes;
    }
  }

  /** A snapshot frame — no `id`: a snapshot is not a stream position (the SSE rule). */
  private sendSnapshot(client: WebSocket, tenantId: string, status: WorkflowRunStatusResponse): void {
    this.send(client, {
      event: isTerminalRunStatus(status.status) ? WORKFLOW_RUN_COMPLETED : 'workflow.run.progress',
      data: buildWorkflowRunEventEnvelope(tenantId, status),
    });
  }

  private send(client: WebSocket, frame: { event: string; id?: string; data: unknown }): void {
    if (client.readyState === client.OPEN) client.send(JSON.stringify(frame));
  }

  /** Mirrors `SttWsGateway.isOriginAllowed`: enforcement off → allow; no registry → fail CLOSED;
   *  an empty registry → allow (nothing registered yet); otherwise exact membership. */
  private async isOriginAllowed(origin: string): Promise<boolean> {
    if (!isOriginEnforcementEnabled()) return true;
    if (!this.originRegistry) return false;
    try {
      if (this.originRegistry.size() === 0) return true;
      return this.originRegistry.has(origin);
    } catch {
      return false;
    }
  }
}
