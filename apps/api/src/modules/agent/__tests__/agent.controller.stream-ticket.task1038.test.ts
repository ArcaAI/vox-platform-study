/**
 * TASK-1038 (F1) — the agent RUN stream ticket.
 *
 *   POST /agents/:slug/runs/:runId/stream-ticket → 201 { ticket, expiresAt, scope, sseUrl }
 *   GET  /agents/:slug/runs/:runId/events?ticket=… → accepted (`@StreamScope('agent_run', runId)`)
 *
 * The mirror of `POST /workflows/:slug/runs/:runId/stream-ticket`: a browser `EventSource` cannot
 * send `X-API-Key`, and `POST /auth/stream-ticket` is JWT-only. The scope is DERIVED from the path,
 * ownership is proved BEFORE the mint (cross-tenant / foreign slug → 404, no ticket), and the
 * route carries the SAME authorisation as the other agent run routes.
 */
import 'reflect-metadata';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NotFoundException, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { API_KEY_REQUIRED_SCOPES, REQUIRED_PERMISSIONS_KEY, SERVICE_ACCOUNT_REQUIRED_SCOPES } from '@arcaai/applications';
import { JwtAuthGuard } from '../../../guards/jwtauth.guard';
import { STREAM_SCOPE_METADATA } from '../../auth/decorators/stream-scope.decorator';
import { AgentController } from '../agent.controller';
import { AgentRunService } from '../agent-run.service';
import { FakeAgentRunRedis } from './fake-agent-run-redis';
import { FakeWorkflowRunRepository } from './fake-workflow-run-repository';

const TENANT = '50000000-0000-0000-0000-000000000000';
const OTHER_TENANT = '51000000-0000-0000-0000-000000000000';
const RESOLVED = {
  agentId: 'a1',
  agentVersionId: 'a1',
  slug: 'scribe',
  versionNumber: 2,
  task: 'TEXT_GENERATION',
  tenantId: TENANT,
  source: 'explicit',
  compiledConfig: {
    task: 'TEXT_GENERATION',
    service: 'llm',
    model: { id: 'm', slug: 'gpt-x', provider: 'lm-studio', taskType: 'TEXT_GENERATION' },
    fallbacks: [],
    instruction: null,
    resolvedPrompt: null,
    parameters: {},
    inputSchema: { type: 'object' },
    outputSchema: { type: 'object' },
    tools: [],
  },
  models: [],
};

let redis: FakeAgentRunRedis;
let repository: FakeWorkflowRunRepository;
let issued: Map<string, { scope: string; userId: string; tenantId: string | null; impersonatedBy?: string | null }>;

function ticketService() {
  return {
    issueTicket: vi.fn(async (input: { scope: string; userId: string; tenantId: string | null; impersonatedBy?: string | null }) => {
      const ticket = `TICKET-${issued.size + 1}`;
      issued.set(ticket, input);
      return { ticket, expiresAt: 1_700_000_030_000, scope: input.scope };
    }),
    consumeTicket: vi.fn(async (ticket: string) => {
      const stored = issued.get(ticket) ?? null;
      issued.delete(ticket);
      return stored;
    }),
  };
}

function make(tenantId: string = TENANT, user: Record<string, unknown> | null = { id: 'bound-human' }) {
  const resolver = { resolve: vi.fn(async () => RESOLVED) };
  const invocation = {
    inputProblems: vi.fn(() => [] as string[]),
    invokeText: vi.fn(async () => ({ text: 'The note.', provider: 'lm-studio', model: 'gpt-x', usage: null })),
    invokeNer: vi.fn(),
  };
  const cls = { get: vi.fn((key: string) => (key === 'tenantId' ? tenantId : key === 'user' ? user : undefined)), set: vi.fn() };
  const runs = new AgentRunService(repository as never, redis as never, { resolvePlatform: () => ({ value: 24 }), resolve: () => ({ value: 30 }) } as never);
  const streamTickets = ticketService();
  const controller = new AgentController(
    {} as never,
    resolver as never,
    invocation as never,
    cls as never,
    {} as never,
    { getConfigValue: () => 'http://tts' } as never,
    undefined,
    undefined,
    { assertMeterQuota: vi.fn(async () => undefined) } as never,
    { recordUsage: vi.fn(async () => ({ written: 1 })) } as never,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    runs,
    undefined,
    undefined,
    undefined,
    undefined,
    streamTickets as never,
  );
  return { controller, streamTickets, cls };
}

function sseContext(params: Record<string, string>, ticket: string) {
  const request = { query: { ticket }, params, headers: {} } as Record<string, unknown>;
  return {
    request,
    context: {
      getType: () => 'http',
      getHandler: () => AgentController.prototype.runEvents,
      getClass: () => AgentController,
      switchToHttp: () => ({ getRequest: () => request }),
    },
  };
}

beforeEach(() => {
  redis = new FakeAgentRunRedis();
  repository = new FakeWorkflowRunRepository();
  issued = new Map();
});

describe('route metadata', () => {
  const reflector = new Reflector();
  it('issueRunStreamTicket carries the agent run routes’ authorisation (both machine classes)', () => {
    const handler = AgentController.prototype.issueRunStreamTicket;
    expect(handler).toBeTypeOf('function');
    expect(reflector.getAllAndOverride(REQUIRED_PERMISSIONS_KEY, [handler, AgentController])).toEqual([]);
    expect(reflector.get(API_KEY_REQUIRED_SCOPES, handler)).toEqual(['agent:invocation:write']);
    expect(reflector.get(SERVICE_ACCOUNT_REQUIRED_SCOPES, handler)).toEqual(['svc:agent:invocation:write']);
  });

  it('runEvents declares @StreamScope agent_run:<runId>', () => {
    expect(reflector.get(STREAM_SCOPE_METADATA, AgentController.prototype.runEvents)).toEqual({ namespace: 'agent_run', param: 'runId' });
  });
});

describe('POST /agents/:slug/runs/:runId/stream-ticket', () => {
  it('mints a run-scoped ticket bound to the caller and the ACTIVE tenant, and answers the SSE url (protocol 2)', async () => {
    const { controller, streamTickets } = make();
    const { runId } = await controller.startRun('scribe', { message: 'x' }, undefined);
    const answer = await controller.issueRunStreamTicket('scribe', runId);

    expect(answer).toEqual({
      ticket: 'TICKET-1',
      expiresAt: 1_700_000_030_000,
      scope: `agent_run:${runId}`,
      sseUrl: `/api/v1/agents/scribe/runs/${runId}/events?protocol=2&ticket=TICKET-1`,
    });
    expect(streamTickets.issueTicket).toHaveBeenCalledWith({ userId: 'bound-human', tenantId: TENANT, scope: `agent_run:${runId}`, impersonatedBy: null });
  });

  it('carries an impersonation claim onto the ticket', async () => {
    const { controller, streamTickets } = make(TENANT, { id: 'bound-human', impersonatedBy: 'admin-1' });
    const { runId } = await controller.startRun('scribe', { message: 'x' }, undefined);
    await controller.issueRunStreamTicket('scribe', runId);
    expect(streamTickets.issueTicket).toHaveBeenCalledWith(expect.objectContaining({ impersonatedBy: 'admin-1' }));
  });

  it('another tenant’s run, an unknown run, or a foreign slug → 404 and NO ticket is minted', async () => {
    const owner = make(TENANT);
    const { runId } = await owner.controller.startRun('scribe', { message: 'x' }, undefined);
    const intruder = make(OTHER_TENANT);
    await expect(intruder.controller.issueRunStreamTicket('scribe', runId)).rejects.toBeInstanceOf(NotFoundException);
    await expect(owner.controller.issueRunStreamTicket('scribe', 'no-such-run')).rejects.toBeInstanceOf(NotFoundException);
    await expect(owner.controller.issueRunStreamTicket('another', runId)).rejects.toBeInstanceOf(NotFoundException);
    expect(intruder.streamTickets.issueTicket).not.toHaveBeenCalled();
    expect(owner.streamTickets.issueTicket).not.toHaveBeenCalled();
  });

  it('refuses (401) with no caller identity to bind the ticket to', async () => {
    const { controller } = make(TENANT, null);
    const { runId } = await controller.startRun('scribe', { message: 'x' }, undefined);
    await expect(controller.issueRunStreamTicket('scribe', runId)).rejects.toBeInstanceOf(UnauthorizedException);
  });
});

describe('GET /agents/:slug/runs/:runId/events?ticket=', () => {
  it('JwtAuthGuard accepts the minted ticket on this run’s events route', async () => {
    const { controller, streamTickets, cls } = make();
    const { runId } = await controller.startRun('scribe', { message: 'x' }, undefined);
    const { ticket } = await controller.issueRunStreamTicket('scribe', runId);
    const guard = new JwtAuthGuard(new Reflector(), streamTickets as never, cls as never);
    const { context, request } = sseContext({ slug: 'scribe', runId }, ticket);

    await expect(guard.canActivate(context as never)).resolves.toBe(true);
    expect(request.user).toMatchObject({ id: 'bound-human', tenantId: TENANT });
  });

  it('refuses it on another run, and refuses a workflow_run ticket for the same id', async () => {
    const { controller, streamTickets, cls } = make();
    const { runId } = await controller.startRun('scribe', { message: 'x' }, undefined);
    const { ticket } = await controller.issueRunStreamTicket('scribe', runId);
    const guard = new JwtAuthGuard(new Reflector(), streamTickets as never, cls as never);
    await expect(guard.canActivate(sseContext({ slug: 'scribe', runId: 'run-OTHER' }, ticket).context as never)).rejects.toThrow();

    issued.set('WF-TICKET', { scope: `workflow_run:${runId}`, userId: 'bound-human', tenantId: TENANT });
    await expect(guard.canActivate(sseContext({ slug: 'scribe', runId }, 'WF-TICKET').context as never)).rejects.toThrow();
  });
});
