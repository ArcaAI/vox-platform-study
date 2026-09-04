/**
 * WorkflowWsGateway — the spec named by `WS_OWNER_BOUND_GATEWAYS` (bootstrap/ws-gateway-owner-audit.ts)
 * as the proof of its `no-owned-session` classification.
 *
 * There is no server-side session for a second principal to take over: every socket is its own
 * read-only view of an existing run, exactly like `GET /workflows/{slug}/runs/{runId}/stream`.
 * The authorisation is (1) the CSWSH origin gate, which runs BEFORE any ticket is burned, (2) the
 * single-use `workflow_run:<runId>` stream ticket, minted bound to the caller's tenant, and (3) the
 * run lookup performed under THAT tenant — a foreign or unknown run is a generic close, never a
 * frame. Nothing the client sends (slug, runId, lastEventId) widens what the ticket authorises.
 */
import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setOriginEnforcementResolver } from '../../../cors.config';
import { WORKFLOW_RUN_COMPLETED } from '../../workflows/workflow-run-event';
import { WORKFLOW_RUN_TICKET_NAMESPACE, WORKFLOW_WS_CLOSE_AUTH_FAILED, WORKFLOW_WS_GENERIC_AUTH_REASON, WorkflowWsGateway } from '../workflow-ws.gateway';

const TENANT = '10000000-0000-0000-0000-000000000001';
const USER = '20000000-0000-0000-0000-000000000002';
const RUN = '018f3a7c-5b84-7d19-9e63-0a2c8d5f7b43';
const REGISTERED_ORIGIN = 'https://console.example.org';

const makeSocket = () => ({
  OPEN: 1,
  readyState: 1,
  send: vi.fn(),
  close: vi.fn(),
  ping: vi.fn(),
  on: vi.fn(),
});

const makeTicketService = (stored: Record<string, unknown> | null) => ({
  consumeTicket: vi.fn(async () => stored),
});

const makeExposure = (snapshot: Record<string, unknown> | Error) => ({
  getRunStatus: vi.fn(async () => {
    if (snapshot instanceof Error) throw snapshot;
    return snapshot;
  }),
});

const makeCls = () => ({
  set: vi.fn(),
  run: vi.fn(async (fn: () => Promise<unknown>) => fn()),
});

/** No Redis: a non-terminal run would close 1011 after the snapshot; every case here stays before that. */
const config = { isRedisConfigured: vi.fn(() => false), getRedisConfig: vi.fn() };

const makeOriginRegistry = (registered: string[]) => ({
  size: vi.fn(() => registered.length),
  has: vi.fn((origin: string) => registered.includes(origin)),
});

const req = (origin: string | undefined, qs = `?slug=discharge&runId=${RUN}&ticket=t-1`) => ({
  url: `/ws/workflows${qs}`,
  headers: origin === undefined ? {} : { origin },
});

const validTicket = (over: Record<string, unknown> = {}) => ({
  scope: `${WORKFLOW_RUN_TICKET_NAMESPACE}:${RUN}`,
  tenantId: TENANT,
  userId: USER,
  ...over,
});

const terminalSnapshot = { runId: RUN, slug: 'discharge', workflowVersionNumber: 3, status: 'COMPLETED', stages: [], startedAt: null, endedAt: null };

function build(opts: { ticket?: Record<string, unknown> | null; run?: Record<string, unknown> | Error; origins?: string[] }) {
  const tickets = makeTicketService(opts.ticket === undefined ? validTicket() : opts.ticket);
  const exposure = makeExposure(opts.run ?? terminalSnapshot);
  const cls = makeCls();
  const registry = makeOriginRegistry(opts.origins ?? [REGISTERED_ORIGIN]);
  const gateway = new WorkflowWsGateway(tickets as never, exposure as never, cls as never, config as never, registry as never);
  return { gateway, tickets, exposure, cls, registry, client: makeSocket() };
}

const expectAuthClose = (client: ReturnType<typeof makeSocket>) => {
  expect(client.close).toHaveBeenCalledTimes(1);
  expect(client.close).toHaveBeenCalledWith(WORKFLOW_WS_CLOSE_AUTH_FAILED, WORKFLOW_WS_GENERIC_AUTH_REASON);
  expect(client.send).not.toHaveBeenCalled();
};

describe('WorkflowWsGateway — owner binding (no-owned-session)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Enforcement ships ON; `cors.config.ts` has no resolver in a unit test, so arm it explicitly.
    setOriginEnforcementResolver(() => true);
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    setOriginEnforcementResolver(null);
  });

  it('refuses an unregistered browser Origin before any ticket is burned or any run is looked up', async () => {
    const t = build({});
    await t.gateway.handleConnection(t.client as never, req('https://evil.example.com') as never);
    expectAuthClose(t.client);
    expect(t.tickets.consumeTicket).not.toHaveBeenCalled();
    expect(t.exposure.getRunStatus).not.toHaveBeenCalled();
  });

  it('runs the origin check BEFORE ticket consumption for a registered origin (ordering, not just outcome)', async () => {
    const t = build({});
    await t.gateway.handleConnection(t.client as never, req(REGISTERED_ORIGIN) as never);
    expect(t.registry.has.mock.invocationCallOrder[0]).toBeLessThan(t.tickets.consumeTicket.mock.invocationCallOrder[0]!);
  });

  it('a non-browser caller (no Origin) reaches the ticket check', async () => {
    const t = build({});
    await t.gateway.handleConnection(t.client as never, req(undefined) as never);
    expect(t.registry.has).not.toHaveBeenCalled();
    expect(t.tickets.consumeTicket).toHaveBeenCalledWith('t-1');
  });

  it('rejects a handshake with no ticket without consulting the ticket store', async () => {
    const t = build({});
    await t.gateway.handleConnection(t.client as never, req(undefined, `?slug=discharge&runId=${RUN}`) as never);
    expectAuthClose(t.client);
    expect(t.tickets.consumeTicket).not.toHaveBeenCalled();
  });

  it('rejects an unknown or already-burned ticket and never looks the run up', async () => {
    const t = build({ ticket: null });
    await t.gateway.handleConnection(t.client as never, req(undefined) as never);
    expectAuthClose(t.client);
    expect(t.exposure.getRunStatus).not.toHaveBeenCalled();
  });

  it('rejects a ticket minted for ANOTHER run — the client-supplied runId cannot widen the scope', async () => {
    const t = build({ ticket: validTicket({ scope: `${WORKFLOW_RUN_TICKET_NAMESPACE}:some-other-run` }) });
    await t.gateway.handleConnection(t.client as never, req(undefined) as never);
    expectAuthClose(t.client);
    expect(t.exposure.getRunStatus).not.toHaveBeenCalled();
  });

  it('rejects a ticket that carries no tenant', async () => {
    const t = build({ ticket: validTicket({ tenantId: undefined }) });
    await t.gateway.handleConnection(t.client as never, req(undefined) as never);
    expectAuthClose(t.client);
    expect(t.exposure.getRunStatus).not.toHaveBeenCalled();
  });

  it("looks the run up under the TICKET's tenant and closes generically when it is foreign or unknown (404-over-403)", async () => {
    const t = build({ run: new Error('NotFound') });
    await t.gateway.handleConnection(t.client as never, req(undefined) as never);
    expectAuthClose(t.client);
    expect(t.cls.set).toHaveBeenCalledWith('tenantId', TENANT);
    expect(t.exposure.getRunStatus).toHaveBeenCalledWith('discharge', RUN);
  });

  it('serves a run the ticket authorises: one snapshot frame under the ticket tenant, then a clean close for a terminal run', async () => {
    const t = build({});
    await t.gateway.handleConnection(t.client as never, req(REGISTERED_ORIGIN) as never);
    expect(t.tickets.consumeTicket).toHaveBeenCalledTimes(1);
    expect(t.client.send).toHaveBeenCalledTimes(1);
    const frame = JSON.parse(t.client.send.mock.calls[0]![0] as string) as { event: string; data: { tenantId: string; payload: { runId: string } } };
    expect(frame.event).toBe(WORKFLOW_RUN_COMPLETED);
    expect(frame.data.tenantId).toBe(TENANT);
    expect(frame.data.payload.runId).toBe(RUN);
    expect(t.client.close).toHaveBeenCalledWith(1000, 'run completed');
  });
});
