/**
 * TASK-890 §3.14 (OD-R) — the guardrail opt-out on the REALTIME `core.agent` lane.
 *
 * L14 built the decision (`resolveGuardrailDecision`), the wire field
 * (`TextRequestEnrichmentService.applyGuardrailDecision`) and the ledger disposition
 * (`guardrailDisposition`); the three PRODUCERS were handed to the lanes that own their files.
 * This is the realtime producer, and what it has to get right is the FOLD: this lane is the only
 * one where all three opinions are in scope at once — the node's `config.guardrail`, the
 * workflow default the compiler froze onto `policyBindings.guardrail`, and the agent's own.
 *
 * The precedence asserted here (node > workflow > agent > ON) is the SAME function the durable
 * lane calls (`guardrail_optout.resolve_guardrail_decision`), because the two lanes execute the
 * same node: a divergence would mean one lane screens a call the other does not, which is a
 * safety difference and not a formatting one.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LiveDocumentationService } from '../live-documentation.service';
import { CONSULTATION_REALTIME_GRAPH_EXECUTOR_KEY } from '../../consultation-gates.constants';
import { DEFAULT_LIVE_TOOL_PLAN, type FrozenLiveAgentSnapshot } from '../live-agent.port';
import type { ResolvedWorkflowAssignment } from '../../../workflow-assignment/IWorkflowAssignmentService';
import type { ResolvedTextCandidate, ResolvedTextGenerationSpec } from '../../../agent/text-generation-spec';

const TENANT = '50000000-0000-0000-0000-000000000001';
const CID = 'consultation-890-guardrail';
const SLUG = 'agent-first-live';
const NOTE = 'Subjective: cough\nObjective:\nAssessment:\nPlan:';

const candidate = (): ResolvedTextCandidate => ({
  kind: 'primary',
  agent: { slug: 'clinic-summarizer', versionId: 'a1', versionNumber: 3, tenantId: TENANT, source: 'explicit' },
  modelSlug: 'tenant-medgemma',
  provider: 'vllm',
  model: 'medgemma-27b',
  resolvedPrompt: { source: 'inline', content: 'Write the note.' },
  instruction: { systemPrompt: 'Write the note.' },
  parameters: { generation: { temperature: 0.1, maxTokens: 900 }, responseFormat: 'text' },
  tools: [],
  fundingTier: 'tenant',
});

const spec = (agentGuardrail?: boolean): ResolvedTextGenerationSpec =>
  ({
    schemaVersion: 1,
    agent: agentGuardrail === undefined ? {} : { guardrail: { enabled: agentGuardrail } },
    primary: candidate(),
    fallback: { autoSwitch: false, chain: [] },
  }) as unknown as ResolvedTextGenerationSpec;

const lane = (nodeConfig: Record<string, unknown>, workflowGuardrail?: boolean) => ({
  slug: SLUG,
  versionNumber: 2,
  ...(workflowGuardrail === undefined ? {} : { policyBindings: { guardrail: { enabled: workflowGuardrail } } }),
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

function cacheMock() {
  return {
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
  };
}

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

/** The real merge semantics of `applyGuardrailDecision`, so this test pins the WIRE, not a spy. */
const enrichment = {
  applyTextRuntimeProfile: vi.fn(async () => undefined),
  applyTenantProviderOverrides: vi.fn(async () => undefined),
  applyGuardrailDecision: vi.fn((target: Record<string, unknown>, decision: { enabled: boolean }) => {
    const existing = typeof target.guardrail_policy === 'object' && target.guardrail_policy !== null ? target.guardrail_policy : {};
    target.guardrail_policy = { ...existing, enabled: decision.enabled };
    return target;
  }),
  guardrailDisposition: vi.fn(async (decision: { enabled: boolean }) => (decision.enabled ? 'screened' : 'opted_out')),
};

const usageLedger = { recordUsage: vi.fn().mockResolvedValue(undefined) };

function buildService(opts: { nodeConfig?: Record<string, unknown>; workflowGuardrail?: boolean }) {
  const post = vi.fn().mockImplementation((url: string) =>
    String(url).includes('/generate')
      ? Promise.resolve({
          data: { summary: NOTE, stats: { provider: 'vllm', model: 'medgemma-27b' }, usage_detail: { endpoint_kind: 'openai.chat', task_id: 't-1', provider: 'vllm', model: 'medgemma-27b', prompt_tokens: 10, completion_tokens: 20 } },
        })
      : Promise.resolve({ data: {} }),
  );
  const env: Record<string, unknown> = { LIVE_DOC_MIN_INTERVAL_MS: '0', LIVE_DOC_TEXT_MAX_TOKENS: '1500' };
  const service = new LiveDocumentationService(
    { axiosRef: { post } } as never,
    { get: vi.fn().mockImplementation((k: string) => env[k]) } as never,
    cacheMock() as never,
    { subscribeToChannel: vi.fn(), unsubscribeFromChannel: vi.fn() } as never,
    undefined,
    undefined,
    { resolveTextSelection: vi.fn().mockResolvedValue({ provider: 'vllm', model: 'x' }) } as never,
    { encrypt: vi.fn(), decrypt: vi.fn(), getSecretOptional: vi.fn().mockResolvedValue('svc-token') } as never,
    undefined,
    {
      resolveEffective: vi.fn(async (key: string) =>
        key === CONSULTATION_REALTIME_GRAPH_EXECUTOR_KEY ? { value: true, sourceScope: 'tenant' } : { value: undefined, sourceScope: 'code-default' },
      ),
    } as never,
    undefined,
    { run: vi.fn((cb: () => unknown) => cb()), set: vi.fn(), get: vi.fn() } as never,
    { resolveForSession: vi.fn().mockResolvedValue(snapshot()) } as never,
    enrichment as never,
    undefined,
    { findById: vi.fn(async (id: string) => ({ id, tenantId: TENANT, metadata: null })) } as never,
    { resolve: vi.fn(async (): Promise<ResolvedWorkflowAssignment> => ({ workflowDefinitionSlug: SLUG, source: 'tenant' })) } as never,
    {
      findPublishedBySlug: vi.fn(async (tenantId: string, slug: string) =>
        tenantId === TENANT && slug === SLUG
          ? { slug, paletteKey: 'consultation', compiledConfig: lane(opts.nodeConfig ?? {}, opts.workflowGuardrail) }
          : null,
      ),
    } as never,
    undefined,
    undefined,
    undefined,
    textAgents as never,
    undefined,
    usageLedger as never,
  );
  return { service, post };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i++) await new Promise((resolve) => setImmediate(resolve));
}

async function runOneFlush(opts: { nodeConfig?: Record<string, unknown>; workflowGuardrail?: boolean; agentGuardrail?: boolean }) {
  textAgents.resolve.mockResolvedValue(spec(opts.agentGuardrail));
  const { service, post } = buildService(opts);
  service.start({ consultationId: CID, tenantId: TENANT });
  await settle();
  service.ingestSegment(CID, { text: 'Patient reports cough.', isFinal: true, segmentId: 's1' });
  await service.flush(CID);
  const body = post.mock.calls.filter((c) => String(c[0]).includes('/generate')).map((c) => c[1] as Record<string, unknown>)[0];
  await settle();
  await service.stop(CID, { persistSnapshot: false });
  return body;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('the realtime core.agent lane folds the guardrail decision and puts it on the wire', () => {
  it('screens by default: no node, no workflow and no agent opinion means ON, stated explicitly', async () => {
    const body = await runOneFlush({});

    expect(body.guardrail_policy).toEqual({ enabled: true });
  });

  it('honours the NODE opt-out', async () => {
    const body = await runOneFlush({ nodeConfig: { guardrail: { enabled: false } } });

    expect(body.guardrail_policy).toEqual({ enabled: false });
  });

  it('honours the WORKFLOW default when the node says nothing', async () => {
    const body = await runOneFlush({ workflowGuardrail: false });

    expect(body.guardrail_policy).toEqual({ enabled: false });
  });

  it('lets the NODE override the workflow default in the ON direction', async () => {
    const body = await runOneFlush({ nodeConfig: { guardrail: { enabled: true } }, workflowGuardrail: false });

    expect(body.guardrail_policy).toEqual({ enabled: true });
  });

  it('falls through to the AGENT opinion when neither the node nor the workflow has one', async () => {
    const body = await runOneFlush({ agentGuardrail: false });

    expect(body.guardrail_policy).toEqual({ enabled: false });
  });

  it('reads a MISSING agent opinion as inherit, never as an opt-out', async () => {
    const body = await runOneFlush({ agentGuardrail: undefined });

    expect(body.guardrail_policy).toEqual({ enabled: true });
  });
});

describe('the ledger row carries the disposition', () => {
  it('stamps `opted_out` on a node that turned screening off', async () => {
    await runOneFlush({ nodeConfig: { guardrail: { enabled: false } } });
    await settle();

    expect(enrichment.guardrailDisposition).toHaveBeenCalledWith({ enabled: false });
    const batch = usageLedger.recordUsage.mock.calls.at(-1)?.[0] as { common: { attributesJson: Record<string, unknown> } };
    expect(batch.common.attributesJson).toMatchObject({ trigger: 'CONSULTATION', guardrail: 'opted_out' });
  });

  it('stamps `screened` on a node that did not', async () => {
    await runOneFlush({});
    await settle();

    const batch = usageLedger.recordUsage.mock.calls.at(-1)?.[0] as { common: { attributesJson: Record<string, unknown> } };
    expect(batch.common.attributesJson).toMatchObject({ trigger: 'CONSULTATION', guardrail: 'screened' });
  });
});
