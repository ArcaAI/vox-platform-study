import { IConfigService, IOriginRegistry, IWorkflowExposureService } from '@arcaai/applications';
import { RESUME_FROM_BEGINNING, decodeResumeToken, encodeResumeToken, parseAsyncEnvelope } from '@arcaai/async-contract';
import { Inject, Logger, Optional, type OnModuleDestroy } from '@nestjs/common';
import { OnGatewayConnection, WebSocketGateway } from '@nestjs/websockets';
import type { IncomingMessage } from 'http';
import Redis from 'ioredis';
import { ClsService } from 'nestjs-cls';
import type WebSocket from 'ws';
import { isOriginEnforcementEnabled } from '../../cors.config';
import { StreamTicketService } from '../auth/stream-ticket.service';
import { RUN_EVENT_TRANSPORT, WORKFLOW_RUN_COMPLETED, buildWorkflowRunEventEnvelope, isTerminalRunStatus, runEventStreamKey } from '../workflows/workflow-run-event';

/** One generic close for every handshake failure — no enumeration signal (the STT gateway's rule). */
export const WORKFLOW_WS_CLOSE_AUTH_FAILED = 4401;
export const WORKFLOW_WS_GENERIC_AUTH_REASON = 'Authentication failed';
/** The stream-ticket scope namespace — the SAME one the SSE route consumes. */
export const WORKFLOW_RUN_TICKET_NAMESPACE = 'workflow_run';
const BLOCK_MS = 15_000;
const HEARTBEAT_MS = 15_000;

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
 */
@WebSocketGateway({ path: '/ws/workflows' })
export class WorkflowWsGateway implements OnGatewayConnection, OnModuleDestroy {
  private readonly logger = new Logger(WorkflowWsGateway.name);
  private redis: Redis | null = null;
  private redisUnavailable = false;

  constructor(
    private readonly streamTicketService: StreamTicketService,
    @Inject(IWorkflowExposureService) private readonly workflowExposureService: IWorkflowExposureService,
    private readonly cls: ClsService,
    @Optional() @Inject(IConfigService) private readonly configService?: IConfigService,
    @Optional() @Inject(IOriginRegistry) private readonly originRegistry?: IOriginRegistry,
  ) {}

  async onModuleDestroy(): Promise<void> {
    if (this.redis) {
      await this.redis.quit().catch(() => {});
      this.redis = null;
    }
  }

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

    // Ownership + snapshot, under the ticket's tenant. `getRunStatus` is the SSE route's own
    // pre-stream check: a foreign or unknown run is a NotFoundException here.
    let snapshot;
    try {
      snapshot = await this.cls.run(async () => {
        this.cls.set('tenantId', stored.tenantId as string);
        this.cls.set('user', { id: stored.userId, tenantId: stored.tenantId, roles: [] });
        return this.workflowExposureService.getRunStatus(slug, runId);
      });
    } catch {
      return reject('run not found for this ticket');
    }

    this.send(client, { event: isTerminalRunStatus(snapshot.status) ? WORKFLOW_RUN_COMPLETED : 'workflow.run.progress', data: buildWorkflowRunEventEnvelope(stored.tenantId, snapshot) });
    if (isTerminalRunStatus(snapshot.status)) {
      client.close(1000, 'run completed');
      return;
    }

    const redis = this.reader();
    if (redis === null) {
      // No push transport: the snapshot above is honest and the client can reconnect.
      client.close(1011, 'stream transport unavailable');
      return;
    }

    let open = true;
    client.on('close', () => {
      open = false;
    });
    const heartbeat = setInterval(() => {
      if (open && client.readyState === client.OPEN) client.ping();
    }, HEARTBEAT_MS);

    try {
      await this.forward(redis, client, runId, lastEventId, () => open);
    } finally {
      clearInterval(heartbeat);
      if (open && client.readyState === client.OPEN) client.close(1000, 'run completed');
    }
  }

  /** The same cursor/resume/terminal contract as `WorkflowStreamService.consume`. */
  private async forward(redis: Redis, client: WebSocket, runId: string, lastEventId: string | undefined, isOpen: () => boolean): Promise<void> {
    const streamKey = runEventStreamKey(runId);
    const decoded = lastEventId ? decodeResumeToken(lastEventId) : null;
    let cursor = decoded && decoded.transport === RUN_EVENT_TRANSPORT ? decoded.cursor : RESUME_FROM_BEGINNING;
    while (isOpen()) {
      let entries: [string, string[]][];
      try {
        const result = await redis.xread('COUNT', 200, 'BLOCK', BLOCK_MS, 'STREAMS', streamKey, cursor);
        if (!result) continue;
        entries = result[0][1] as [string, string[]][];
      } catch (err) {
        this.logger.warn({ message: 'workflow WS read failed — closing', runId, error: err instanceof Error ? err.message : String(err) });
        return;
      }
      for (const [entryId, fields] of entries) {
        cursor = entryId;
        const envelope = this.parse(fields);
        if (envelope === null || !isOpen()) continue;
        this.send(client, { event: envelope.type, id: encodeResumeToken(RUN_EVENT_TRANSPORT, entryId), data: envelope });
        if (envelope.type === WORKFLOW_RUN_COMPLETED) return;
      }
    }
  }

  private send(client: WebSocket, frame: { event: string; id?: string; data: unknown }): void {
    if (client.readyState === client.OPEN) client.send(JSON.stringify(frame));
  }

  private parse(fields: string[]): ReturnType<typeof parseAsyncEnvelope> {
    for (let i = 0; i < fields.length; i += 2) {
      if (fields[i] !== 'data') continue;
      try {
        return parseAsyncEnvelope(JSON.parse(fields[i + 1]));
      } catch {
        return null;
      }
    }
    return null;
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

  private reader(): Redis | null {
    if (this.redis) return this.redis;
    if (this.redisUnavailable) return null;
    if (!this.configService?.isRedisConfigured()) {
      this.redisUnavailable = true;
      return null;
    }
    const config = this.configService.getRedisConfig();
    this.redis = new Redis({ host: config.host, port: config.port, password: config.password, maxRetriesPerRequest: null, lazyConnect: false });
    return this.redis;
  }
}
