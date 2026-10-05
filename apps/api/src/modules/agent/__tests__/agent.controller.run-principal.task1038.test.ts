/**
 * TASK-1038 OD-35 — agent run reads are bound to the STARTING principal.
 *
 * `POST /agents/:slug/runs` records who started the run (`_metadata.startedBy`) and scopes an
 * `Idempotency-Key` to that principal. Every read of the run — `GET …/runs/:runId`, `…/result`,
 * `…/events`, `POST …/stream-ticket`, `POST …/cancel` — answers a run another principal started
 * with the SAME 404 as an unknown run, unless the reader holds `agent:run:read-all` /
 * `svc:agent:run:read-all` (machine) or is a SUPER_ADMIN / TENANT_ADMIN of the working tenant
 * (human). Real `AgentRunService` + `RunPrincipalAccessService`; only the edges are faked.
 */
import 'reflect-metadata';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { RunPrincipalAccessService } from '@arcaai/applications';
import { AgentController } from '../agent.controller';
import { AgentRunService } from '../agent-run.service';
import { FakeAgentRunRedis } from './fake-agent-run-redis';
import { FakeWorkflowRunRepository } from './fake-workflow-run-repository';

const TENANT = '50000000-0000-0000-0000-000000000000';
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

let store: Record<string, unknown>;
let roleRows: Array<{ tenantId: string; Roles: Array<{ name: string }> }>;
let repository: FakeWorkflowRunRepository;
let redis: FakeAgentRunRedis;

const asApiKey = (id: string, scopes: string[] = ['agent:invocation:write']) => {
  store = { tenantId: TENANT, user: { id: 'human-1', tenantId: TENANT }, apiKey: { id, scopes } };
};
const asServiceAccount = (id: string, scopes: string[] = ['svc:agent:invocation:write']) => {
  store = { tenantId: TENANT, serviceAccount: { id, scopes, roles: [], workingTenantId: TENANT } };
};
const asHuman = (id: string, tenantRoles: string[] = []) => {
  store = { tenantId: TENANT, user: { id, tenantId: TENANT } };
  roleRows = [{ tenantId: TENANT, Roles: tenantRoles.map((name) => ({ name })) }];
};

function make() {
  const cls = { get: vi.fn((key: string) => store[key]), set: vi.fn() };
  const invocation = {
    inputProblems: vi.fn(() => [] as string[]),
    // Never settles on its own: the run stays RUNNING for the duration of a test.
    invokeText: vi.fn(() => new Promise(() => undefined)),
    invokeNer: vi.fn(),
  };
  const runs = new AgentRunService(repository as never, redis as never, { resolvePlatform: () => ({ value: 24 }), resolve: () => ({ value: 30 }) } as never);
  const streamTickets = { issueTicket: vi.fn(async (input: { scope: string }) => ({ ticket: 'T', expiresAt: 1, scope: input.scope })) };
  const runAccess = new RunPrincipalAccessService(cls as never, { findAll: vi.fn(async () => roleRows) } as never);
  const controller = new AgentController(
    {} as never,
    { resolve: vi.fn(async () => RESOLVED) } as never,
    invocation as never,
    cls as never,
    {} as never,
    { getConfigValue: () => 'http://text' } as never,
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
    runAccess,
  );
  return { controller, runs, streamTickets };
}

const response = () => {
  const res = { setHeader: vi.fn(), status: vi.fn(), flushHeaders: vi.fn(), write: vi.fn(), end: vi.fn(), on: vi.fn() };
  return res;
};

async function expectUnknownRun(attempt: Promise<unknown>): Promise<void> {
  const err = await attempt.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(NotFoundException);
  expect((err as NotFoundException).getResponse()).toEqual(new NotFoundException('Agent run not found').getResponse());
}

async function startAs(controller: AgentController, key?: string): Promise<string> {
  const started = await controller.startRun('scribe', { message: 'Summarise.' } as never, key);
  return started.runId;
}

beforeEach(() => {
  store = {};
  roleRows = [];
  repository = new FakeWorkflowRunRepository();
  redis = new FakeAgentRunRedis();
  vi.clearAllMocks();
});

describe('OD-35 — agent runs record the starting principal', () => {
  it('an API-key start is stamped with the KEY', async () => {
    const { controller } = make();
    asApiKey('key-A');
    await startAs(controller);
    const [row] = [...repository.rows.values()];
    expect((row.metaData as Record<string, unknown>).startedBy).toEqual({ type: 'apiKey', id: 'key-A' });
  });

  it('the same Idempotency-Key from two keys starts two runs — B never joins A', async () => {
    const { controller } = make();
    asApiKey('key-A');
    const a = await startAs(controller, 'k-1');
    asApiKey('key-B');
    const b = await startAs(controller, 'k-1');
    expect(a).not.toBe(b);
    expect(repository.rows.size).toBe(2);
    // …and A retrying its own key still joins its own run.
    asApiKey('key-A');
    expect(await startAs(controller, 'k-1')).toBe(a);
  });
});

describe('OD-35 — reads by another principal are the unknown-run 404', () => {
  it('API key A reads its run; API key B gets 404 on status, result, events, ticket and cancel', async () => {
    const { controller, runs, streamTickets } = make();
    asApiKey('key-A');
    const runId = await startAs(controller);
    await expect(controller.getRun('scribe', runId)).resolves.toMatchObject({ runId, status: 'RUNNING' });

    asApiKey('key-B');
    await expectUnknownRun(controller.getRun('scribe', runId));
    await expectUnknownRun(controller.getRunResult('scribe', runId, response() as never));
    const res = response();
    await expectUnknownRun(controller.runEvents('scribe', runId, { headers: {}, query: {} } as never, res as never));
    expect(res.flushHeaders).not.toHaveBeenCalled();
    await expectUnknownRun(controller.issueRunStreamTicket('scribe', runId));
    expect(streamTickets.issueTicket).not.toHaveBeenCalled();
    await expectUnknownRun(controller.cancelRun('scribe', runId));
    expect((await runs.get(TENANT, 'scribe', runId)).status).toBe('RUNNING');
  });

  it('a service account does not read a run an API key started', async () => {
    const { controller } = make();
    asApiKey('key-A');
    const runId = await startAs(controller);
    asServiceAccount('sa-1');
    await expectUnknownRun(controller.getRun('scribe', runId));
  });

  it('agent:run:read-all / svc:agent:run:read-all widen a machine credential; workflow:run:read-all does not', async () => {
    const { controller } = make();
    asApiKey('key-A');
    const runId = await startAs(controller);
    asApiKey('key-B', ['agent:invocation:write', 'workflow:run:read-all']);
    await expectUnknownRun(controller.getRun('scribe', runId));
    asApiKey('key-B', ['agent:invocation:write', 'agent:run:read-all']);
    await expect(controller.getRun('scribe', runId)).resolves.toMatchObject({ runId });
    asServiceAccount('sa-1', ['svc:agent:invocation:write', 'svc:agent:run:read-all']);
    await expect(controller.getRun('scribe', runId)).resolves.toMatchObject({ runId });
  });

  it('a doctor gets 404 on a run it did not start; reads its own; a tenant admin reads any', async () => {
    const { controller } = make();
    asApiKey('key-A');
    const keyRun = await startAs(controller);
    asHuman('doctor-1', ['DOCTOR']);
    const doctorRun = await startAs(controller);
    await expectUnknownRun(controller.getRun('scribe', keyRun));
    await expect(controller.getRun('scribe', doctorRun)).resolves.toMatchObject({ runId: doctorRun });
    asHuman('admin-1', ['TENANT_ADMIN']);
    await expect(controller.getRun('scribe', keyRun)).resolves.toMatchObject({ runId: keyRun });
    await expect(controller.cancelRun('scribe', keyRun)).resolves.toMatchObject({ status: 'CANCELED' });
  });

  it('the stream ticket records the reader its mint proved', async () => {
    const { controller, streamTickets } = make();
    asApiKey('key-A');
    const runId = await startAs(controller);
    await controller.issueRunStreamTicket('scribe', runId);
    expect(streamTickets.issueTicket).toHaveBeenCalledWith(
      expect.objectContaining({ scope: `agent_run:${runId}`, runReader: { principal: { type: 'apiKey', id: 'key-A' }, tenantWide: false } }),
    );
  });
});

describe('OD-35 — wiring (the binding is @Optional() for fixtures, so production must provide it)', () => {
  it('AgentModule provides RunPrincipalAccessService', async () => {
    const { AgentModule } = await import('../agent.module');
    expect(Reflect.getMetadata('providers', AgentModule)).toContain(RunPrincipalAccessService);
  });
});
