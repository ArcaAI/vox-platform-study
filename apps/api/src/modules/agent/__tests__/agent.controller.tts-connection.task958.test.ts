/**
 * TASK-958 G3 (W1d) — the agent speech route classifies the connection that SERVED.
 *
 * `classifyTtsProvider` gained a third argument in G2a and the three speech-module call sites
 * pass it (`speech-proxy.controller.ts`, `harness-tts-internal.controller.ts`,
 * `tts-ws.gateway.ts`). This route — the fourth — still called it with two, so it fell back to
 * `servingEntry`'s key heuristics: the exact `provider` key, else EXACTLY ONE `provider:`-
 * prefixed entry. That covers a tenant with one named sibling and nothing more.
 *
 * With TWO accounts of one vendor in the chain the heuristic is ambiguous by construction and
 * returns nothing, so the tenant's own BYOK synthesis was labelled platform `CLOUD` — its spend
 * charged to platform COGS, and `BYOK_NOTIONAL` never written. The id `apps/tts` echoes on
 * `X-Tts-Connection-Id` is the answer, and it is the same one the ledger row already carried:
 * the route read the header and then did not use it for the classification.
 */
import 'reflect-metadata';
import { PassThrough } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AiCostBasis, AiDeploymentKind } from '@arcaai/domains';
import { AgentController } from '../agent.controller';

const TENANT = '50000000-0000-0000-0000-000000000000';

const TTS_AGENT = {
  agentId: 'a1',
  agentVersionId: 'a1',
  slug: 'clinic-voice',
  versionNumber: 1,
  task: 'TEXT_TO_SPEECH',
  tenantId: TENANT,
  source: 'explicit',
  compiledConfig: {
    task: 'TEXT_TO_SPEECH',
    service: 'tts',
    model: { id: 'm', slug: 'azure-neural', provider: 'azure', taskType: 'TEXT_TO_SPEECH' },
    fallbacks: [],
    instruction: null,
    resolvedPrompt: null,
    parameters: {},
    inputSchema: { type: 'object' },
    outputSchema: { type: 'object' },
    tools: [],
    protocols: ['http'],
  },
  models: [],
  guardrail: { enabled: true },
};

/** Two accounts of ONE vendor — the shape the single-prefix heuristic cannot resolve. */
const TWO_SIBLINGS = {
  'azure:azure-clinic': { api_key: 'clinic-key', funding: 'tenant', connection_id: 'conn-azure-clinic' },
  'azure:azure-research': { api_key: 'research-key', funding: 'tenant', connection_id: 'conn-azure-research' },
};

function fakeRes() {
  const res = {
    setHeader: vi.fn(),
    flushHeaders: vi.fn(),
    write: vi.fn(),
    end: vi.fn(),
    status: vi.fn(() => res),
    json: vi.fn(),
    on: vi.fn(),
  };
  return res;
}

function spec(connectionId: string | null) {
  return {
    schemaVersion: 1,
    agent: { slug: 'clinic-voice', versionId: 'a1', versionNumber: 1, tenantId: TENANT, source: 'explicit' },
    primary: {
      kind: 'primary',
      runtimeKey: 'azure::azure-neural',
      agent: { slug: 'clinic-voice', versionId: 'a1', versionNumber: 1, tenantId: TENANT, source: 'explicit' },
      model: { role: 'primary', slug: 'azure-neural', taskType: 'TEXT_TO_SPEECH', format: 'CLOUD', sourceUri: 'neural', sourceRevision: null },
      parameters: {},
      voice: null,
      connection: connectionId ? { provider: 'azure', funding: 'tenant', connectionId, connectionSlug: 'azure-clinic' } : null,
      fundingTier: 'tenant',
      connectionKey: connectionId ? 'azure:azure-clinic' : 'azure',
    },
    fallback: { autoSwitch: false, chain: [] },
  };
}

function make(headers: Record<string, string>, options: { specConnectionId?: string | null; overrides?: Record<string, unknown> } = {}) {
  const upstream = new PassThrough();
  const resolver = { resolve: vi.fn(async () => TTS_AGENT) };
  const invocation = {
    buildSpeechRequest: vi.fn(() => ({ input: 'hello there', voice: 'v1', model: 'azure-neural' })),
  };
  const usageLedger = { recordUsage: vi.fn(async () => ({ written: 1 })) };
  const httpService = {
    axiosRef: { post: vi.fn(async () => ({ data: upstream, headers: { 'content-type': 'audio/wav', ...headers } })) },
  };
  const ttsResolver = {
    resolveFromAgent: vi.fn(async () => ({
      spec: spec(options.specConnectionId ?? null),
      providerOverrides: options.overrides ?? TWO_SIBLINGS,
    })),
  };
  const controller = new AgentController(
    { listPublished: vi.fn(), getPublishedBySlug: vi.fn() } as never,
    resolver as never,
    invocation as never,
    { get: vi.fn((key: string) => (key === 'tenantId' ? TENANT : undefined)) } as never,
    httpService as never,
    { getConfigValue: () => 'http://tts' } as never,
    undefined,
    ttsResolver as never,
    { assertMeterQuota: vi.fn(async () => undefined) } as never,
    usageLedger as never,
    { createBatchJob: vi.fn(), failJob: vi.fn() } as never,
    { dispatchDramatiqJob: vi.fn() } as never,
    { fetchById: vi.fn() } as never,
    { resolve: vi.fn() } as never,
    { assertSpendLimit: vi.fn(async () => undefined) } as never,
    { resolve: vi.fn(() => ({ value: {}, source: 'system' })) } as never,
  );
  return { controller, usageLedger, upstream };
}

type Batch = { common: Record<string, unknown> };
const firstCommon = (ledger: { recordUsage: ReturnType<typeof vi.fn> }): Record<string, unknown> =>
  (ledger.recordUsage.mock.calls[0]?.[0] as Batch).common;

const settle = async () => {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe('TASK-958 G3 — agent speech TTS funding follows the served connection', () => {
  it('classifies a sibling-keyed override as BYOK when the service names the connection', async () => {
    const { controller, usageLedger, upstream } = make({
      'x-tts-provider': 'azure',
      'x-tts-connection-id': 'conn-azure-research',
    });

    await controller.speech('clinic-voice', { text: 'hello there' }, fakeRes() as never);
    upstream.end();
    await settle();

    const common = firstCommon(usageLedger);
    expect(common.deployment).toBe(AiDeploymentKind.BYOK);
    expect(common.costBasis).toBe(AiCostBasis.BYOK_NOTIONAL);
    expect(common.connectionId).toBe('conn-azure-research');
  });

  it('falls back to the connection the spec named when the service echoes no header', async () => {
    const { controller, usageLedger, upstream } = make(
      { 'x-tts-provider': 'azure' },
      { specConnectionId: 'conn-azure-clinic' },
    );

    await controller.speech('clinic-voice', { text: 'hello there' }, fakeRes() as never);
    upstream.end();
    await settle();

    const common = firstCommon(usageLedger);
    expect(common.deployment).toBe(AiDeploymentKind.BYOK);
    expect(common.costBasis).toBe(AiCostBasis.BYOK_NOTIONAL);
    // The LEDGER column stays header-only: the echo names the candidate that actually served,
    // while the spec names the one we asked for. Good enough to read a funding label out of a
    // map this request itself sent; not good enough to stamp as the row that was spent.
    expect(common.connectionId).toBeNull();
  });

  it('keeps the legacy classification when neither the header nor the spec names a connection', async () => {
    const { controller, usageLedger, upstream } = make(
      { 'x-tts-provider': 'azure' },
      { overrides: { azure: { api_key: 'platform-key', funding: 'platform', connection_id: 'conn-platform-azure' } } },
    );

    await controller.speech('clinic-voice', { text: 'hello there' }, fakeRes() as never);
    upstream.end();
    await settle();

    const common = firstCommon(usageLedger);
    expect(common.deployment).toBe(AiDeploymentKind.CLOUD);
    expect(common.costBasis).toBeUndefined();
    expect(common.connectionId).toBeNull();
  });
});
