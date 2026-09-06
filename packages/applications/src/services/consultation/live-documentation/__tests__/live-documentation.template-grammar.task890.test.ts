/**
 * TASK-890 §3.2/§3.3 + §3.13 — the REALTIME `core.agent` lane renders through the ONE grammar
 * and meters what it generates.
 *
 * Two defects met here, both found by the round-2 assessment:
 *
 *  - **§2.4 flavours 5 vs 6.** The realtime lane rendered the SAME `core.agent` node with a flat
 *    `variables[key]` lookup while the durable lane resolved DOTTED paths, so a prompt that
 *    worked in a Temporal run emitted a literal `{{…}}` on the live lane. Both now render
 *    through `renderTemplate` over the scope `buildAgentPromptScope` builds.
 *  - **§2.7 #6 / BLOCKER #7.** This lane posts straight to `apps/text` and recorded NOTHING: a
 *    production LLM path that billed nothing and could not be quota-limited. Every call is now
 *    preceded by `assertMeterQuota('monthlyLlmTokens')` and followed by one `generate` row
 *    carrying `trigger: 'CONSULTATION'`.
 *
 * Built on the TASK-876 harness (`live-documentation.core-agent.task876.test.ts`) so the two
 * files exercise the same realtime `core.agent` flush.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LiveDocumentationService } from '../live-documentation.service';
import { CONSULTATION_REALTIME_GRAPH_EXECUTOR_KEY } from '../../consultation-gates.constants';
import { DEFAULT_LIVE_TOOL_PLAN, type FrozenLiveAgentSnapshot } from '../live-agent.port';
import type { ResolvedWorkflowAssignment } from '../../../workflow-assignment/IWorkflowAssignmentService';
import type { ResolvedTextCandidate, ResolvedTextGenerationSpec } from '../../../agent/text-generation-spec';

const TENANT = '50000000-0000-0000-0000-000000000001';
const CID = 'consultation-890';
const SLUG = 'agent-first-live';
const NOTE = 'Subjective: cough for three days\nObjective:\nAssessment:\nPlan:';

const USAGE_DETAIL = {
  task_id: 'text-task-1',
  request_id: 'req-1',
  provider: 'vllm',
  model: 'medgemma-27b',
  endpoint_kind: 'openai.chat',
  occurred_at: '2026-09-06T00:00:00.000Z',
  prompt_tokens: 120,
  completion_tokens: 40,
};

const candidate = (over: Partial<ResolvedTextCandidate> = {}): ResolvedTextCandidate =>
  ({
    kind: 'primary',
    agent: { slug: 'clinic-summarizer', versionId: 'a1', versionNumber: 3, tenantId: TENANT, source: 'explicit' },
    modelSlug: 'tenant-medgemma',
    provider: 'vllm',
    model: 'medgemma-27b',
    resolvedPrompt: { source: 'inline', content: 'PROMPT' },
    instruction: { systemPrompt: 'PROMPT', variables: {} },
    parameters: { generation: { temperature: 0.1, maxTokens: 900 }, responseFormat: 'text' },
    tools: [],
    fundingTier: 'tenant',
    ...over,
  }) as ResolvedTextCandidate;

const withPrompt = (content: string, variables: Record<string, unknown> = {}): ResolvedTextGenerationSpec =>
  ({
    schemaVersion: 1,
    agent: {} as never,
    primary: candidate({
      resolvedPrompt: { source: 'inline', content },
      instruction: { systemPrompt: content, variables },
    }),
    fallback: { autoSwitch: true, chain: [] },
  }) as ResolvedTextGenerationSpec;

const coreAgentLane = (nodeConfig: Record<string, unknown> = {}) => ({
  slug: SLUG,
  versionNumber: 2,
  stages: [
    { stageIndex: 0, nodes: [{ nodeId: 'capture', type: 'consultation.captureBinding', config: {}, inputs: [], onError: 'fail' }] },
    {
      stageIndex: 1,
      nodes: [
        {
          nodeId: 'live',
          type: 'core.agent',
          config: { agentRef: { slug: 'clinic-summarizer', versionNumber: 3 }, execution: { lane: 'realtime', cadence: 'perTurn' }, ...nodeConfig },
          inputs: [{ fromNodeId: 'capture', fromPort: 'out', toPort: 'in' }],
          onError: 'degrade',
        },
      ],
    },
  ],
});

function httpMock() {
  const post = vi.fn().mockImplementation((url: string) => {
    if (url.includes('/generate')) {
      return Promise.resolve({ data: { summary: NOTE, stats: { provider: 'vllm', model: 'medgemma-27b' }, usage_detail: USAGE_DETAIL } });
    }
    return Promise.resolve({ data: {} });
  });
  return { post, http: { axiosRef: { post } } };
}

const generateCalls = (post: ReturnType<typeof vi.fn>) => post.mock.calls.filter((c) => String(c[0]).includes('/generate'));

const cacheMock = () => ({
  get: vi.fn().mockResolvedValue(null),
  set: vi.fn().mockResolvedValue(undefined),
  setex: vi.fn().mockResolvedValue(undefined),
  publish: vi.fn().mockResolvedValue(undefined),
  del: vi.fn().mockResolvedValue(undefined),
  eval: vi.fn().mockResolvedValue(1),
  sadd: vi.fn().mockResolvedValue(1),
  srem: vi.fn().mockResolvedValue(1),
  smembers: vi.fn().mockResolvedValue([]),
  expire: vi.fn().mockResolvedValue(true),
});

const snapshot = (): FrozenLiveAgentSnapshot => ({
  resolvedFrom: 'agent',
  agentId: 'agent-1',
  agentName: 'Agent',
  promptTemplateId: 'tmpl-1',
  promptVersionNumber: 1,
  stableUserPrefix: 'PREFIX.',
  systemPrompt: 'SESSION SYSTEM PROMPT.',
  toolPlan: DEFAULT_LIVE_TOOL_PLAN,
  frozenAt: '2026-09-05T00:00:00.000Z',
});

const textAgents = { resolve: vi.fn() };
const entitlements = { assertMeterQuota: vi.fn().mockResolvedValue(undefined) };
const usageLedger = { recordUsage: vi.fn().mockResolvedValue({ recorded: 1 }) };

function buildService(spec: ResolvedTextGenerationSpec, nodeConfig: Record<string, unknown> = {}) {
  const { post, http } = httpMock();
  textAgents.resolve.mockResolvedValue(spec);
  const env: Record<string, unknown> = { LIVE_DOC_MIN_INTERVAL_MS: '0', LIVE_DOC_TEXT_MAX_TOKENS: '1500' };
  const configService = { get: vi.fn().mockImplementation((k: string) => env[k]) };
  const effectiveSettings = {
    resolveEffective: vi.fn(async (key: string) =>
      key === CONSULTATION_REALTIME_GRAPH_EXECUTOR_KEY ? { value: true, sourceScope: 'tenant' } : { value: undefined, sourceScope: 'code-default' },
    ),
  };
  const assignments = { resolve: vi.fn(async (): Promise<ResolvedWorkflowAssignment> => ({ workflowDefinitionSlug: SLUG, source: 'tenant' })) };
  const definitions = {
    findPublishedBySlug: vi.fn(async (tenantId: string, slug: string) =>
      tenantId === TENANT && slug === SLUG ? { slug, paletteKey: 'consultation', compiledConfig: coreAgentLane(nodeConfig) } : null,
    ),
  };
  const service = new LiveDocumentationService(
    http as never,
    configService as never,
    cacheMock() as never,
    { subscribeToChannel: vi.fn(), unsubscribeFromChannel: vi.fn() } as never,
    undefined,
    undefined,
    { resolveTextSelection: vi.fn().mockResolvedValue({ provider: 'vllm', model: 'tenant-default' }) } as never,
    { encrypt: vi.fn(), decrypt: vi.fn(), getSecretOptional: vi.fn().mockResolvedValue('svc-token') } as never,
    undefined,
    effectiveSettings as never,
    undefined,
    { run: vi.fn((cb: () => unknown) => cb()), set: vi.fn(), get: vi.fn() } as never,
    { resolveForSession: vi.fn().mockResolvedValue(snapshot()) } as never,
    undefined,
    undefined,
    { findById: vi.fn(async (id: string) => ({ id, tenantId: TENANT, metadata: null })) } as never,
    assignments as never,
    definitions as never,
    undefined,
    undefined,
    undefined,
    textAgents as never,
    entitlements as never,
    usageLedger as never,
  );
  return { service, post };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) await new Promise((resolve) => setImmediate(resolve));
}

async function runOneFlush(service: LiveDocumentationService, post: ReturnType<typeof vi.fn>) {
  service.start({ consultationId: CID, tenantId: TENANT });
  await settle();
  service.ingestSegment(CID, { text: 'Patient reports cough for three days.', isFinal: true, segmentId: 's1' });
  const payload = await service.flush(CID);
  // Snapshotted BEFORE `stop()`, whose forced drain re-walks the lane (the TASK-876 harness
  // does the same for the TEXT calls).
  const calls = generateCalls(post).map((c) => c[1] as Record<string, unknown>);
  const usageBatches = usageLedger.recordUsage.mock.calls.map((c) => c[0] as { common: Record<string, unknown>; units: unknown[] });
  const quotaChecks = entitlements.assertMeterQuota.mock.calls.map((c) => [...c]);
  await service.stop(CID, { persistSnapshot: false });
  return { payload, calls, usageBatches, quotaChecks };
}

beforeEach(() => {
  vi.clearAllMocks();
  entitlements.assertMeterQuota.mockResolvedValue(undefined);
  usageLedger.recordUsage.mockResolvedValue({ recorded: 1 });
});

describe('the realtime core.agent lane renders the agent instruction through the ONE grammar', () => {
  it('resolves a DOTTED path into a bound variable — the divergence from the durable lane', async () => {
    const { service, post } = buildService(withPrompt('Patient {{patient.name}}, ward {{patient.ward}}.', { patient: { name: 'Ada', ward: '3' } }));
    const { calls } = await runOneFlush(service, post);

    expect(calls[0]?.system_prompt).toBe('Patient Ada, ward 3.');
  });

  it('exposes the bound map under `variables.*`, as the durable scope does', async () => {
    const { service, post } = buildService(withPrompt('Tone: {{variables.tone}}', { tone: 'formal' }));
    const { calls } = await runOneFlush(service, post);

    expect(calls[0]?.system_prompt).toBe('Tone: formal');
  });

  it('lets the node’s `overrides.promptVariables` win over the agent’s own', async () => {
    const { service, post } = buildService(withPrompt('Ward {{ward}}', { ward: '3' }), { overrides: { promptVariables: { ward: '7' } } });
    const { calls } = await runOneFlush(service, post);

    expect(calls[0]?.system_prompt).toBe('Ward 7');
  });

  it('honours `default("…")`', async () => {
    const { service, post } = buildService(withPrompt('{{absent | default("n/a")}}'));
    const { calls } = await runOneFlush(service, post);

    expect(calls[0]?.system_prompt).toBe('n/a');
  });

  it('leaves a single brace VERBATIM — no fallback pass over the deleted grammar', async () => {
    const { service, post } = buildService(withPrompt('Language: {language_name}'));
    const { calls } = await runOneFlush(service, post);

    expect(calls[0]?.system_prompt).toBe('Language: {language_name}');
  });

  it('degrades the node on an unresolved variable WITHOUT calling TEXT or walking the fallback chain', async () => {
    const spec = withPrompt('{{absent}}');
    (spec.fallback as { chain: ResolvedTextCandidate[] }).chain = [candidate({ kind: 'platform-default' })];
    const { service, post } = buildService(spec);
    const { calls } = await runOneFlush(service, post);

    expect(calls).toHaveLength(0);
  });
});

describe('the realtime lane meters every generation (§3.13)', () => {
  it('prechecks the LLM meter before the call and records one `generate` row with trigger CONSULTATION', async () => {
    const { service, post } = buildService(withPrompt('PROMPT'));
    const { usageBatches, quotaChecks } = await runOneFlush(service, post);

    expect(quotaChecks).toEqual([[TENANT, 'monthlyLlmTokens']]);
    expect(usageBatches).toHaveLength(1);
    const batch = usageBatches[0]!;
    expect(batch.common.operation).toBe('generate');
    expect(batch.common.tenantId).toBe(TENANT);
    expect(batch.common.consultationId).toBe(CID);
    expect((batch.common.attributesJson as Record<string, unknown>).trigger).toBe('CONSULTATION');
    expect(batch.units.length).toBeGreaterThan(0);
  });

  it('does not record when TEXT reports no usage block — a call that consumed nothing gets no row', async () => {
    const { service, post } = buildService(withPrompt('PROMPT'));
    post.mockImplementation((url: string) =>
      url.includes('/generate') ? Promise.resolve({ data: { summary: NOTE, stats: null } }) : Promise.resolve({ data: {} }),
    );
    const { usageBatches, quotaChecks } = await runOneFlush(service, post);

    expect(quotaChecks).toEqual([[TENANT, 'monthlyLlmTokens']]);
    expect(usageBatches).toHaveLength(0);
  });
});
