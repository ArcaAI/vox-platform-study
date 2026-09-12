/**
 * TASK-959 T6 — the realtime live-documentation lane passes the RESOLVED device.
 *
 * This lane runs on the platform's own engines by default, and it is the highest-frequency
 * generation path there is: one call per flush, per open consultation. After lane SWAP a
 * SELF_HOSTED call whose builder was handed no `device` records NO compute row, so this lane
 * was billing tokens and nothing else.
 *
 * `recordLlmUsage` is fire-and-forget by contract — the note is already on its way to the
 * clinician — so what is pinned here is that the device resolution joined that same swallowed
 * chain: a resolver outage costs a compute row, never a note.
 */
import { AiCostBasis, AiUsageUnit } from '@arcaai/domains';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { LiveDocumentationService } from '../live-documentation.service';
import { CONSULTATION_REALTIME_GRAPH_EXECUTOR_KEY } from '../../consultation-gates.constants';
import { DEFAULT_LIVE_TOOL_PLAN, type FrozenLiveAgentSnapshot } from '../live-agent.port';
import type { ResolvedWorkflowAssignment } from '../../../workflow-assignment/IWorkflowAssignmentService';
import type { ResolvedTextCandidate, ResolvedTextGenerationSpec } from '../../../agent/text-generation-spec';

const TENANT = '50000000-0000-0000-0000-000000000001';
const CID = 'consultation-959-compute';
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

const spec = (): ResolvedTextGenerationSpec =>
  ({ schemaVersion: 1, agent: {}, primary: candidate(), fallback: { autoSwitch: false, chain: [] } }) as unknown as ResolvedTextGenerationSpec;

const lane = () => ({
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
          config: { agentRef: { slug: 'clinic-summarizer', versionNumber: 3 }, execution: { lane: 'realtime', cadence: 'perTurn' } },
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
const enrichment = {
  applyTextRuntimeProfile: vi.fn(async () => undefined),
  applyTenantProviderOverrides: vi.fn(async () => undefined),
  applyGuardrailDecision: vi.fn(),
  guardrailDisposition: vi.fn(async () => 'screened'),
};
const usageLedger = { recordUsage: vi.fn().mockResolvedValue(undefined) };

function usageDetail(overrides: Record<string, unknown> = {}) {
  return {
    endpoint_kind: 'openai.chat',
    task_id: 'live-task-1',
    provider: 'vllm',
    model: 'medgemma-27b',
    prompt_tokens: 10,
    completion_tokens: 20,
    total_ms: 900,
    request_bytes: 2048,
    response_bytes: 4096,
    ...overrides,
  };
}

function buildService(opts: { computeDevice?: unknown; usageDetail?: Record<string, unknown> }) {
  const post = vi.fn().mockImplementation((url: string) =>
    String(url).includes('/generate')
      ? Promise.resolve({
          data: { summary: NOTE, stats: { provider: 'vllm', model: 'medgemma-27b' }, usage_detail: opts.usageDetail ?? usageDetail() },
        })
      : Promise.resolve({ data: {} }),
  );
  const env: Record<string, unknown> = { LIVE_DOC_MIN_INTERVAL_MS: '0', LIVE_DOC_TEXT_MAX_TOKENS: '1500' };
  const computeDevice = opts.computeDevice === undefined ? { resolve: vi.fn().mockResolvedValue('cuda') } : opts.computeDevice;
  const service = new LiveDocumentationService(
    { axiosRef: { post } } as never,
    { get: vi.fn().mockImplementation((k: string) => env[k]) } as never,
    cacheMock() as never,
    { subscribeToChannel: vi.fn(), unsubscribeFromChannel: vi.fn() } as never,
    undefined, // audioBridge
    undefined, // contextItemRepository
    { resolveTextSelection: vi.fn().mockResolvedValue({ provider: 'vllm', model: 'x' }) } as never,
    { encrypt: vi.fn(), decrypt: vi.fn(), getSecretOptional: vi.fn().mockResolvedValue('svc-token') } as never,
    undefined, // trajectoryService
    {
      resolveEffective: vi.fn(async (key: string) =>
        key === CONSULTATION_REALTIME_GRAPH_EXECUTOR_KEY ? { value: true, sourceScope: 'tenant' } : { value: undefined, sourceScope: 'code-default' },
      ),
    } as never,
    undefined, // routingPolicies
    { run: vi.fn((cb: () => unknown) => cb()), set: vi.fn(), get: vi.fn() } as never,
    { resolveForSession: vi.fn().mockResolvedValue(snapshot()) } as never,
    enrichment as never,
    undefined, // documentTemplateService
    { findById: vi.fn(async (id: string) => ({ id, tenantId: TENANT, metadata: null })) } as never,
    { resolve: vi.fn(async (): Promise<ResolvedWorkflowAssignment> => ({ workflowDefinitionSlug: SLUG, source: 'tenant' })) } as never,
    {
      findPublishedBySlug: vi.fn(async (tenantId: string, slug: string) =>
        tenantId === TENANT && slug === SLUG ? { slug, paletteKey: 'consultation', compiledConfig: lane() } : null,
      ),
    } as never,
    undefined, // documentSectionRepository
    undefined, // promptTemplateRepository
    undefined, // liveAssist
    textAgents as never,
    undefined, // entitlements
    usageLedger as never,
    undefined, // agentResolver
    undefined, // preSummaryRunner
    undefined, // dnaReportRepository
    undefined, // configResolver
    undefined, // departmentRepository
    computeDevice as never,
  );
  return { service, computeDevice: computeDevice as { resolve: ReturnType<typeof vi.fn> } };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i++) await new Promise((resolve) => setImmediate(resolve));
}

async function runOneFlush(opts: { computeDevice?: unknown; usageDetail?: Record<string, unknown> } = {}) {
  textAgents.resolve.mockResolvedValue(spec());
  const harness = buildService(opts);
  harness.service.start({ consultationId: CID, tenantId: TENANT });
  await settle();
  harness.service.ingestSegment(CID, { text: 'Patient reports cough.', isFinal: true, segmentId: 's1' });
  await harness.service.flush(CID);
  await settle();
  await harness.service.stop(CID, { persistSnapshot: false });
  await settle();
  return harness;
}

type Recorded = { common: { costBasis?: string; attributesJson?: Record<string, unknown> }; units: { unit: AiUsageUnit; quantity: unknown; attributesJson?: Record<string, unknown> | null }[] };

const recordedBatches = (costBasis?: string): Recorded[] =>
  usageLedger.recordUsage.mock.calls
    .map((call) => call[0] as Recorded)
    .filter((batch) => costBasis === undefined || batch.common.costBasis === costBasis);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('LiveDocumentationService — the resolved compute device reaches the ledger (TASK-959 T6)', () => {
  it('records a GPU_SECOND row carrying the device resolved for the serving provider', async () => {
    const harness = await runOneFlush();

    expect(harness.computeDevice.resolve).toHaveBeenCalledWith(TENANT, 'vllm');
    const [batch] = recordedBatches();
    expect(batch.units.find((unit) => unit.unit === AiUsageUnit.GPU_SECOND)).toEqual({
      unit: AiUsageUnit.GPU_SECOND,
      quantity: '0.900',
      attributesJson: { device: 'cuda' },
    });
    // The dimension the lane has always stamped survives the move to the pair form.
    expect(batch.common.attributesJson).toMatchObject({ trigger: 'CONSULTATION', guardrail: 'screened' });
  });

  it('keeps the token and byte rows and drops only the compute row when the resolver throws', async () => {
    await runOneFlush({ computeDevice: { resolve: vi.fn().mockRejectedValue(new Error('settings backend down')) } });

    const [batch] = recordedBatches();
    expect(batch.units.map((unit) => unit.unit)).toEqual([
      AiUsageUnit.INPUT_TOKEN,
      AiUsageUnit.OUTPUT_TOKEN,
      AiUsageUnit.EGRESS_BYTE,
      AiUsageUnit.INGRESS_BYTE,
    ]);
  });

  it('records the platform CPU leg of a BYOK live generation as its own INTERNAL batch', async () => {
    await runOneFlush({ usageDetail: usageDetail({ provider: 'openai', byok: true }) });

    // The tokens stay the tenant's; the seconds HOPE burned calling the vendor are the
    // platform's, and `costBasis` lives on `common` — so saying both takes two batches.
    const [tokens] = recordedBatches(AiCostBasis.BYOK_NOTIONAL);
    expect(tokens.units.map((unit) => unit.unit)).toEqual([AiUsageUnit.INPUT_TOKEN, AiUsageUnit.OUTPUT_TOKEN, AiUsageUnit.EGRESS_BYTE, AiUsageUnit.INGRESS_BYTE]);
    const [platform] = recordedBatches(AiCostBasis.INTERNAL);
    expect(platform.units).toEqual([{ unit: AiUsageUnit.CPU_SECOND, quantity: '0.900', attributesJson: { device: 'cpu' } }]);
    expect(platform.common.attributesJson).toMatchObject({ trigger: 'CONSULTATION', guardrail: 'screened' });
  });
});
