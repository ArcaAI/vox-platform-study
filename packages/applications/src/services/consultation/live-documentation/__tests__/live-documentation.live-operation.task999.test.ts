/**
 * TASK-999 (D-2(c)) — a LIVE flush is IDENTIFIABLE in the usage ledger.
 *
 * ============================================================================
 * WHAT WAS BROKEN
 * ============================================================================
 * The live lane wrote `operation: 'generate'` — the SAME string the FINAL summary writes — and
 * stamped no `sessionId`. So the ledger could not tell a partial summary from a final one, and
 * the consultation telemetry pane could only read live-flush stats from `AgentTrajectoryStep`,
 * which is pruned nightly. Both halves are fixed here: a distinct operation, and the session
 * the flush belonged to.
 *
 * `sessionId` is the session's `trajectorySessionId` on purpose — the SAME id every
 * `AgentTrajectoryStep` of this session carries — so a ledger row and a trajectory step for one
 * flush join on it while the steps still exist, and the ledger keeps the figure after they are
 * pruned.
 *
 * THE FINAL SUMMARY IS NOT TOUCHED. `summary.service.ts` still passes `'generate'`, and that is
 * already pinned by `summary/__tests__/summary.service.compute-device.task959.test.ts` and
 * `summary.service.metering-parity.task890.test.ts`; duplicating it here would be a second copy
 * of one contract.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { LiveDocumentationService } from '../live-documentation.service';
import { CONSULTATION_REALTIME_GRAPH_EXECUTOR_KEY } from '../../consultation-gates.constants';
import { DEFAULT_LIVE_TOOL_PLAN, type FrozenLiveAgentSnapshot } from '../live-agent.port';
import type { ResolvedWorkflowAssignment } from '../../../workflow-assignment/IWorkflowAssignmentService';
import type { ResolvedTextCandidate, ResolvedTextGenerationSpec } from '../../../agent/text-generation-spec';

const TENANT = '50000000-0000-0000-0000-000000000001';
const CID = 'consultation-999-live-op';
const STT_SESSION = 'stt-session-999';
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

const usageDetail = () => ({
  endpoint_kind: 'openai.chat',
  task_id: 'live-task-999',
  provider: 'vllm',
  model: 'medgemma-27b',
  prompt_tokens: 10,
  completion_tokens: 20,
  total_ms: 900,
});

function buildService() {
  const post = vi.fn().mockImplementation((url: string) =>
    String(url).includes('/generate')
      ? Promise.resolve({ data: { summary: NOTE, stats: { provider: 'vllm', model: 'medgemma-27b' }, usage_detail: usageDetail() } })
      : Promise.resolve({ data: {} }),
  );
  const env: Record<string, unknown> = { LIVE_DOC_MIN_INTERVAL_MS: '0', LIVE_DOC_TEXT_MAX_TOKENS: '1500' };
  return new LiveDocumentationService(
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
    { resolve: vi.fn().mockResolvedValue('cuda') } as never, // computeDevice
    undefined, // namedEntityRepository — entity persistence has its own suite
  );
}

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i++) await new Promise((resolve) => setImmediate(resolve));
}

type Recorded = { common: { operation?: string; sessionId?: string | null; consultationId?: string | null } };

const recordedBatches = (): Recorded[] => usageLedger.recordUsage.mock.calls.map((call) => call[0] as Recorded);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('LiveDocumentationService — live generations are their own ledger operation (TASK-999)', () => {
  it('records `generate.live`, not `generate`, and stamps the session it belonged to', async () => {
    // RED before the change: the operation was `generate` and `sessionId` was absent, so a
    // partial summary was indistinguishable from a final one in the ledger.
    textAgents.resolve.mockResolvedValue(spec());
    const service = buildService();
    service.start({ consultationId: CID, tenantId: TENANT, sessionId: STT_SESSION });
    await settle();
    service.ingestSegment(CID, { text: 'Patient reports cough.', isFinal: true, segmentId: 's1' });
    await service.flush(CID);
    await settle();

    const [batch] = recordedBatches();
    expect(batch.common.operation).toBe('generate.live');
    // The STT stream id IS the session's trajectory session id when one was supplied at start,
    // which is what makes a ledger row and a trajectory step for the same flush joinable.
    expect(batch.common.sessionId).toBe(STT_SESSION);
    // Attribution the lane already carried is unchanged by the split.
    expect(batch.common.consultationId).toBe(CID);

    await service.stop(CID, { persistSnapshot: false });
    await settle();
  });

  it('stamps every half of the batch pair, so a split-cost-basis call is attributable too', async () => {
    textAgents.resolve.mockResolvedValue(spec());
    const service = buildService();
    service.start({ consultationId: CID, tenantId: TENANT, sessionId: STT_SESSION });
    await settle();
    service.ingestSegment(CID, { text: 'Patient reports cough.', isFinal: true, segmentId: 's1' });
    await service.flush(CID);
    await settle();

    // Whatever the pair shape, no recorded batch may be missing either dimension: a row with
    // the new operation and no session is exactly as unreadable as the old `generate` rows.
    for (const batch of recordedBatches()) {
      expect(batch.common.operation).toBe('generate.live');
      expect(batch.common.sessionId).toBe(STT_SESSION);
    }

    await service.stop(CID, { persistSnapshot: false });
    await settle();
  });
});
