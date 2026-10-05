import {
  IOriginRegistry,
  IWorkflowExposureService,
  TenantSettingsService,
  WORKFLOW_RUNS_DEFAULTS,
  WORKFLOW_RUNS_WS_MAX_BUFFERED_BYTES_KEY,
  WorkflowEntryGateService,
  WorkflowRunStatusResponse,
} from '@arcaai/applications';
import { RUN_PROTOCOL_HEADER, RUN_PROTOCOL_QUERY_PARAM } from '@arcaai/async-contract';
import { BadRequestException, Inject, Logger, Optional } from '@nestjs/common';
import { OnGatewayConnection, WebSocketGateway } from '@nestjs/websockets';
import type { IncomingMessage } from 'http';
import { ClsService } from 'nestjs-cls';
import type WebSocket from 'ws';
import { isOriginEnforcementEnabled } from '../../cors.config';
import { StreamTicketService } from '../auth/stream-ticket.service';
import { RunEventStreamHub } from '../workflows/run-event-stream-hub';
import { terminalCheckIntervalMs } from '../workflows/run-stream-delivery';
import { deliverRunEvents, parseClientCursor, resolveRunProtocol, toWsFrame } from '../workflows/run-protocol-delivery';
import type { ClientCursor, RunProtocolVersion } from '../workflows/run-protocol-delivery';
import { isTerminalRunStatus } from '../workflows/workflow-run-event';

/** One generic close for every handshake failure — no enumeration signal (the STT gateway's rule). */
export const WORKFLOW_WS_CLOSE_AUTH_FAILED = 4401;
export const WORKFLOW_WS_GENERIC_AUTH_REASON = 'Authentication failed';
/** TASK-1038 B3a — an unsupported `?protocol=` or a malformed v2 `?after=` (the socket's 400). */
export const WORKFLOW_WS_CLOSE_PROTOCOL_UNSUPPORTED = 4400;
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
 *
 * TASK-1038 B3a — run protocol v2 (`?protocol=2`, or the `x-hope-run-protocol` header on a
 * non-browser upgrade): every text frame is the bare v2 envelope (the SSE `data:` line), resumed
 * with `?after=<seq>`, public plane only, `ping` / `run.resync` per protocol-v2.md §6. Without a
 * selection the `{ event, id, data }` legacy frames are DERIVED from the stored v2 events. The
 * whole loop is `deliverRunEvents`, shared with the SSE route and the admin trace. An
 * unsupported protocol closes 4400 before the ticket is consumed.
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
    // TASK-1038 E2 (fix 1) — a run ticket is minted when the workflow admits `sse` OR `socket`, so
    // the socket lane is re-checked HERE, where the socket redeems it. Optional so the positional
    // unit fixtures keep constructing; absent, the settings are not read.
    @Optional() private readonly entryGate?: WorkflowEntryGateService,
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

    // TASK-1038 B3a — protocol and cursor are validated BEFORE the single-use ticket is spent: a
    // malformed request costs the client nothing it cannot retry.
    let protocol: RunProtocolVersion;
    let cursor: ClientCursor;
    try {
      protocol = resolveRunProtocol({
        header: req.headers?.[RUN_PROTOCOL_HEADER] as string | undefined,
        query: url.searchParams.get(RUN_PROTOCOL_QUERY_PARAM),
      });
      cursor = parseClientCursor({ after: url.searchParams.get('after'), legacyQuery: url.searchParams.get('lastEventId') }, protocol);
    } catch (err) {
      this.logger.warn({
        message: 'workflow WS handshake rejected — unsupported run protocol or cursor',
        error: err instanceof Error ? err.message : String(err),
      });
      client.close(WORKFLOW_WS_CLOSE_PROTOCOL_UNSUPPORTED, 'Unsupported run protocol or resume cursor');
      return;
    }
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

    // TASK-1038 E2 (fix 1) — the socket lane, for the run's own workflow version, under the ticket
    // tenant. Ownership is already proved, so the refusal may name itself (no enumeration signal).
    if (this.entryGate) {
      const entryGate = this.entryGate;
      try {
        await this.cls.run(async () => {
          this.cls.set('tenantId', tenantId);
          await entryGate.assertEntryAllowed(slug, snapshot.workflowVersionNumber, 'socket');
        });
      } catch (err) {
        const refused = err instanceof BadRequestException;
        this.logger.warn({
          message: refused ? 'workflow WS refused — the socket connection is not enabled for this workflow' : 'workflow WS lane check failed',
          runId,
          tenantId,
          errorName: err instanceof Error ? err.name : typeof err,
        });
        // A settings READ failure is not a refusal: 1011 lets the client retry.
        if (refused) client.close(WORKFLOW_WS_CLOSE_PROTOCOL_UNSUPPORTED, 'MODE_UNSUPPORTED');
        else client.close(1011, 'stream setup failed');
        return;
      }
    }

    const hub = this.hub;
    const closed = new AbortController();
    client.on('close', () => closed.abort());
    const heartbeat = setInterval(() => {
      if (!closed.signal.aborted && client.readyState === client.OPEN) client.ping();
    }, HEARTBEAT_MS);
    const maxBuffered = this.maxBufferedBytes();

    try {
      await deliverRunEvents({
        hub,
        runId,
        tenantId,
        plane: 'public',
        protocol,
        cursor,
        initialStatus: snapshot,
        // swallow-ok: a failed re-read means "ask again next interval", never a terminal status.
        readStatus: () => readStatus().catch(() => null),
        signal: closed.signal,
        terminalCheckMs: terminalCheckIntervalMs(this.settings),
        blockMs: BLOCK_MS,
        heartbeatMs: HEARTBEAT_MS,
        // R-9 — a client that is behind gets no new read until it catches up.
        beforeRead: () => this.awaitBufferBelow(client, maxBuffered, closed.signal),
        logger: this.logger,
        sink: {
          v2: async (event) => {
            if (!(await this.awaitBufferBelow(client, maxBuffered, closed.signal))) return false;
            const frame = toWsFrame(event);
            if (client.readyState !== client.OPEN) return false;
            client.send(frame);
            return true;
          },
          legacy: async (envelope, resumeToken) => {
            if (!(await this.awaitBufferBelow(client, maxBuffered, closed.signal))) return false;
            this.send(client, { event: envelope.type, ...(resumeToken !== undefined ? { id: resumeToken } : {}), data: envelope });
            return client.readyState === client.OPEN;
          },
        },
      });
    } finally {
      clearInterval(heartbeat);
      if (!closed.signal.aborted && client.readyState === client.OPEN) {
        // No push transport: what was sent is honest and the client can reconnect.
        if (!hub?.available() && !isTerminalRunStatus(snapshot.status)) client.close(1011, 'stream transport unavailable');
        else client.close(1000, 'run completed');
      }
    }
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

  private maxBufferedBytes(): number {
    try {
      const value = this.settings?.resolvePlatform<number>(WORKFLOW_RUNS_WS_MAX_BUFFERED_BYTES_KEY).value;
      return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : WORKFLOW_RUNS_DEFAULTS.wsMaxBufferedBytes;
    } catch {
      return WORKFLOW_RUNS_DEFAULTS.wsMaxBufferedBytes;
    }
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
