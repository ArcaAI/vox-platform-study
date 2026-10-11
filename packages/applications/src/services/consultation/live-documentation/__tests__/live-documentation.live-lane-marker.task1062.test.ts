/**
 * TASK-1062 D-2 A — every gateway -> TEXT `/generate` call the live lane makes carries
 * `X-Hope-Lane: live`, so TEXT admits it into the live lane's own LM Studio budget
 * (`lmStudio.serving.liveLaneSlots`) instead of queueing it behind finalize / pre-summary work.
 * The harness is the TASK-1050 attribution suite's.
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
        agent: {
          slug: 'platform-summarization',
          versionId: 'p1',
          versionNumber: 1,
          tenantId: '00000000-0000-0000-0000-000000000000',
          source: 'platform-default',
        },
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
const enrichment = {
  applyTextRuntimeProfile: vi.fn().mockResolvedValue(undefined),
  applyTenantProviderOverrides: vi.fn().mockResolvedValue(undefined),
};

function buildService(opts: { graph: boolean; generate?: (call: number) => unknown; contextItems?: unknown }) {
  let n = 0;
  const post = vi.fn().mockImplementation((url: string) => {
    if (!url.includes('/generate')) return Promise.resolve({ data: {} });
    const answer = opts.generate ? opts.generate(n++) : NOTE;
    return answer instanceof Error
      ? Promise.reject(answer)
      : Promise.resolve({ data: { summary: answer, stats: { provider: 'echo', model: 'echo' } } });
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
    (opts.contextItems ?? undefined) as never,
    harnessPolicyService as never,
    { encrypt: vi.fn(), decrypt: vi.fn(), getSecretOptional: vi.fn().mockResolvedValue('svc-token') } as never,
    undefined,
    {
      resolveEffective: vi.fn(async (key: string) =>
        key === CONSULTATION_REALTIME_GRAPH_EXECUTOR_KEY
          ? { value: opts.graph, sourceScope: 'tenant' }
          : { value: undefined, sourceScope: 'code-default' },
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

beforeEach(() => {
  vi.clearAllMocks();
  textAgents.resolve.mockResolvedValue(spec());
  harnessPolicyService.resolveTextSelection.mockResolvedValue({
    provider: 'lm-studio',
    model: 'tenant-default',
    agentSlug: 'platform-summarization-live',
  });
});

type PostCall = [string, unknown, { headers?: Record<string, string> }];
const generateCalls = (post: ReturnType<typeof vi.fn>) => (post.mock.calls as PostCall[]).filter(([url]) => url.endsWith('/api/v1/generate'));

describe('TASK-1062 — the live lane marks its TEXT calls', () => {
  it('a flush on the assigned-agent path sends X-Hope-Lane: live', async () => {
    const { service, post } = buildService({ graph: false });
    await runOneFlush(service);
    const calls = generateCalls(post);
    expect(calls.length).toBeGreaterThan(0);
    for (const [, , config] of calls) expect(config.headers).toMatchObject({ 'X-Hope-Lane': 'live' });
  });

  it('a flush on the core.agent path (with a fallback switch) marks every attempt', async () => {
    const { service, post } = buildService({ graph: true, generate: (n) => (n === 0 ? new Error('primary down') : NOTE) });
    await runOneFlush(service);
    const calls = generateCalls(post);
    expect(calls.length).toBeGreaterThanOrEqual(2);
    for (const [, , config] of calls) expect(config.headers).toMatchObject({ 'X-Hope-Lane': 'live' });
  });

  it('keeps the existing internal headers beside the marker', async () => {
    const { service, post } = buildService({ graph: false });
    await runOneFlush(service);
    const [, , config] = generateCalls(post)[0];
    expect(config.headers).toMatchObject({ 'X-Tenant-Id': TENANT, 'X-Service-Token': 'svc-token' });
  });
});
