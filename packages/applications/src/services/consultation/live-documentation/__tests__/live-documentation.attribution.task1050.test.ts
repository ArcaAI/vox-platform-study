/**
 * TASK-1050 finding D — every live-lane TEXT call names the AGENT that serves it (and the
 * consultation) on its egress hints, so its guardrail evaluation carries `agent_slug` and the
 * consultation. Live, the lane's evaluations had an empty `agentSlug`: the core.agent path put
 * `agent_slug` on the body, which the egress enrichment discards (attribution is stated from the
 * hints only), and the assigned-agent path and the three side calls never named one at all.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LiveDocumentationService } from '../live-documentation.service';
import { CONSULTATION_REALTIME_GRAPH_EXECUTOR_KEY } from '../../consultation-gates.constants';
import { DEFAULT_LIVE_TOOL_PLAN, type FrozenLiveAgentSnapshot } from '../live-agent.port';
import type { ResolvedTextCandidate, ResolvedTextGenerationSpec } from '../../../agent/text-generation-spec';

const TENANT = '50000000-0000-0000-0000-000000000001';
const CID = 'consultation-1050-attr';
const SLUG = 'agent-first-live';
const NOTE = 'Subjective: patient reports cough for three days\nObjective:\nAssessment:\nPlan:';

const candidate = (over: Partial<ResolvedTextCandidate> = {}): ResolvedTextCandidate => ({
  kind: 'primary',
  agent: { slug: 'clinic-summarizer', versionId: 'a1', versionNumber: 3, tenantId: TENANT, source: 'explicit' },
  modelSlug: 'tenant-medgemma',
  provider: 'vllm',
  model: 'medgemma-27b',
  resolvedPrompt: { source: 'inline', content: 'Write the note.' },
  instruction: { systemPrompt: 'Write the note.' },
  parameters: { generation: { temperature: 0.1 } },
  tools: [],
  fundingTier: 'tenant',
  ...over,
});

const spec = (): ResolvedTextGenerationSpec => ({
  schemaVersion: 1,
  agent: {} as never,
  primary: candidate(),
  fallback: {
    autoSwitch: true,
    chain: [
      candidate({
        kind: 'platform-default',
        agent: { slug: 'platform-summarization', versionId: 'p1', versionNumber: 1, tenantId: '00000000-0000-0000-0000-000000000000', source: 'platform-default' },
        provider: 'lm-studio',
        model: 'gemma',
        fundingTier: 'platform',
      }),
    ],
  },
});

const coreAgentLane = {
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
};

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
const harnessPolicyService = { resolveTextSelection: vi.fn() };
const enrichment = { applyTextRuntimeProfile: vi.fn().mockResolvedValue(undefined), applyTenantProviderOverrides: vi.fn().mockResolvedValue(undefined) };

function buildService(opts: { graph: boolean; generate?: (call: number) => unknown }) {
  let n = 0;
  const post = vi.fn().mockImplementation((url: string) => {
    if (!url.includes('/generate')) return Promise.resolve({ data: {} });
    const answer = opts.generate ? opts.generate(n++) : NOTE;
    return answer instanceof Error ? Promise.reject(answer) : Promise.resolve({ data: { summary: answer, stats: { provider: 'echo', model: 'echo' } } });
  });
  const env: Record<string, unknown> = { LIVE_DOC_MIN_INTERVAL_MS: '0', LIVE_DOC_TEXT_MAX_TOKENS: '1500' };
  const cache = {
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
  const service = new LiveDocumentationService(
    { axiosRef: { post } } as never,
    { get: vi.fn().mockImplementation((k: string) => env[k]) } as never,
    cache as never,
    { subscribeToChannel: vi.fn(), unsubscribeFromChannel: vi.fn() } as never,
    undefined,
    undefined,
    harnessPolicyService as never,
    { encrypt: vi.fn(), decrypt: vi.fn(), getSecretOptional: vi.fn().mockResolvedValue('svc-token') } as never,
    undefined,
    {
      resolveEffective: vi.fn(async (key: string) =>
        key === CONSULTATION_REALTIME_GRAPH_EXECUTOR_KEY ? { value: opts.graph, sourceScope: 'tenant' } : { value: undefined, sourceScope: 'code-default' },
      ),
    } as never,
    undefined,
    { run: vi.fn((cb: () => unknown) => cb()), set: vi.fn(), get: vi.fn() } as never,
    { resolveForSession: vi.fn().mockResolvedValue(snapshot()) } as never,
    enrichment as never,
    undefined,
    { findById: vi.fn(async (id: string) => ({ id, tenantId: TENANT, metadata: null })) } as never,
    { resolve: vi.fn(async () => ({ workflowDefinitionSlug: SLUG, source: 'tenant' })) } as never,
    {
      findPublishedBySlug: vi.fn(async (tenantId: string, slug: string) =>
        opts.graph && tenantId === TENANT && slug === SLUG ? { slug, paletteKey: 'consultation', compiledConfig: coreAgentLane } : null,
      ),
    } as never,
    undefined,
    { findById: vi.fn().mockResolvedValue({ status: 'APPROVED', content: 'Do the node task.' }) } as never,
    undefined,
    textAgents as never,
  );
  return { service, post };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) await new Promise((resolve) => setImmediate(resolve));
}

async function runOneFlush(service: LiveDocumentationService): Promise<void> {
  service.start({ consultationId: CID, tenantId: TENANT });
  await settle();
  service.ingestSegment(CID, { text: 'Patient reports cough for three days.', isFinal: true, segmentId: 's1' });
  await service.flush(CID);
  await service.stop(CID, { persistSnapshot: false });
}

type Hints = { agentSlug?: string | null; consultationId?: string | null; phase?: string };
const hintsOf = (call: number): Hints => enrichment.applyTenantProviderOverrides.mock.calls.at(call)?.[1] as Hints;

beforeEach(() => {
  vi.clearAllMocks();
  textAgents.resolve.mockResolvedValue(spec());
  harnessPolicyService.resolveTextSelection.mockResolvedValue({ provider: 'vllm', model: 'tenant-default', agentSlug: 'platform-summarization-live' });
});

describe('live flush — the serving agent rides the egress hints', () => {
  it('assigned-agent path: the selection`s agent and the consultation', async () => {
    const { service } = buildService({ graph: false });
    await runOneFlush(service);
    expect(hintsOf(0)).toMatchObject({ agentSlug: 'platform-summarization-live', consultationId: CID, phase: 'live' });
  });

  it('core.agent path: the candidate`s agent, and the fallback candidate`s on a switch', async () => {
    const { service } = buildService({ graph: true, generate: (n) => (n === 0 ? new Error('primary down') : NOTE) });
    await runOneFlush(service);
    expect(hintsOf(0)).toMatchObject({ agentSlug: 'clinic-summarizer', consultationId: CID });
    expect(hintsOf(1)).toMatchObject({ agentSlug: 'platform-summarization', consultationId: CID });
  });
});

describe('live side calls — agent and consultation on the egress hints', () => {
  type Private = {
    proposeCorrections: (input: unknown, consultationId: string) => Promise<unknown>;
    extractImportantFindings: (input: unknown, signal: AbortSignal | undefined, consultationId?: string) => Promise<unknown>;
    translateSectionText: (text: string, language: string, session: unknown) => Promise<string>;
  };

  it('grammar corrections', async () => {
    const { service } = buildService({ graph: false, generate: () => '[]' });
    await (service as unknown as Private).proposeCorrections(
      { sourceText: 'patient has a coff', entities: [], tenantId: TENANT, config: { promptTemplateId: 't-1' } },
      CID,
    );
    expect(hintsOf(-1)).toMatchObject({ agentSlug: 'platform-summarization-live', consultationId: CID });
  });

  it('important findings', async () => {
    const { service } = buildService({ graph: false, generate: () => '[]' });
    await (service as unknown as Private).extractImportantFindings(
      { sourceText: 'chest pain', context: [], entities: [], tenantId: TENANT, config: { promptTemplateId: 't-2' } },
      undefined,
      CID,
    );
    expect(hintsOf(-1)).toMatchObject({ agentSlug: 'platform-summarization-live', consultationId: CID });
  });

  it('translate-only', async () => {
    const { service } = buildService({ graph: false, generate: () => 'translated' });
    await (service as unknown as Private).translateSectionText('text', 'English', { tenantId: TENANT, consultationId: CID });
    expect(hintsOf(-1)).toMatchObject({ agentSlug: 'platform-summarization-live', consultationId: CID });
  });
});
