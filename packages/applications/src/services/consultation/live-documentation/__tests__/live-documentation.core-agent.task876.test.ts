/**
 * TASK-876 — the REALTIME lane generates through the BOUND AGENT, with platform-default fallback.
 *
 * A tenant graph with a `core.agent` (`execution.lane: realtime`) used to generate on the tenant
 * `text.live` default with the session's frozen prompt: `agentRef` was never resolved on this
 * lane. Now the host resolves it (explicit slug + version pin, FAIL CLOSED on drift, exactly as
 * the Temporal lane refuses it) through `TextAgentResolverService`, and the TEXT call carries
 * the agent's model, its resolved instruction (node `promptVariables` interpolated) and its
 * generation hyper-parameters (node `overrides.generation` layered on top). On primary failure
 * the call switches to the resolved chain when the tenant's per-agent `autoSwitch` is on.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConflictException } from '@nestjs/common';
import { LiveDocumentationService } from '../live-documentation.service';
import { CONSULTATION_REALTIME_GRAPH_EXECUTOR_KEY } from '../../consultation-gates.constants';
import { DEFAULT_LIVE_TOOL_PLAN, type FrozenLiveAgentSnapshot } from '../live-agent.port';
import type { ResolvedWorkflowAssignment } from '../../../workflow-assignment/IWorkflowAssignmentService';
import type { ResolvedTextCandidate, ResolvedTextGenerationSpec } from '../../../agent/text-generation-spec';

const TENANT = '50000000-0000-0000-0000-000000000001';
const CID = 'consultation-876';
const SLUG = 'agent-first-live';
const NOTE = 'Subjective: patient reports cough for three days\nObjective:\nAssessment:\nPlan:';

const candidate = (over: Partial<ResolvedTextCandidate> = {}): ResolvedTextCandidate => ({
  kind: 'primary',
  agent: { slug: 'clinic-summarizer', versionId: 'a1', versionNumber: 3, tenantId: TENANT, source: 'explicit' },
  modelSlug: 'tenant-medgemma',
  provider: 'vllm',
  model: 'medgemma-27b',
  resolvedPrompt: { source: 'inline', content: 'Write the note for {{clinic}} in a {{tone}} tone.' },
  instruction: { systemPrompt: 'Write the note for {{clinic}} in a {{tone}} tone.', variables: { clinic: 'Ward 3', tone: 'formal' } },
  parameters: { generation: { temperature: 0.1, maxTokens: 900, topP: 0.8 }, responseFormat: 'text' },
  tools: [],
  fundingTier: 'tenant',
  ...over,
});

const platformCandidate = (): ResolvedTextCandidate =>
  candidate({
    kind: 'platform-default',
    agent: { slug: 'platform-summarization', versionId: 'p1', versionNumber: 1, tenantId: '00000000-0000-0000-0000-000000000000', source: 'platform-default' },
    modelSlug: 'lms-gemma-4-e2b-it-qat',
    provider: 'lm-studio',
    model: 'gemma-4-e2b-it-qat',
    resolvedPrompt: { source: 'inline', content: 'PLATFORM PROMPT.' },
    instruction: { systemPrompt: 'PLATFORM PROMPT.' },
    parameters: { generation: { temperature: 0.2, maxTokens: 2048 } },
    fundingTier: 'platform',
  });

const spec = (over: { autoSwitch?: boolean; chain?: ResolvedTextCandidate[] } = {}): ResolvedTextGenerationSpec => ({
  schemaVersion: 1,
  agent: {} as never,
  primary: candidate(),
  fallback: { autoSwitch: over.autoSwitch ?? true, switchAfterConsecutiveFailures: 2, chain: over.chain ?? [platformCandidate()] },
});

/** A tenant graph: capture → one realtime core.agent bound to an explicit, pinned agent. */
const coreAgentLane = (nodeConfig: Record<string, unknown>) => ({
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

function httpMock(generate: (call: number) => unknown) {
  let n = 0;
  const post = vi.fn().mockImplementation((url: string) => {
    if (url.includes('/generate')) {
      const answer = generate(n++);
      return answer instanceof Error ? Promise.reject(answer) : Promise.resolve({ data: { summary: answer, stats: { provider: 'echo', model: 'echo' } } });
    }
    return Promise.resolve({ data: {} });
  });
  return { post, http: { axiosRef: { post } } };
}

const generateCalls = (post: ReturnType<typeof vi.fn>) => post.mock.calls.filter((c) => String(c[0]).includes('/generate'));

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
const harnessPolicyService = { resolveTextSelection: vi.fn().mockResolvedValue({ provider: 'vllm', model: 'tenant-default' }) };

function buildService(opts: { generate: (call: number) => unknown; nodeConfig?: Record<string, unknown>; lane?: unknown }) {
  const { post, http } = httpMock(opts.generate);
  const env: Record<string, unknown> = { LIVE_DOC_MIN_INTERVAL_MS: '0', LIVE_DOC_TEXT_MAX_TOKENS: '1500' };
  const configService = { get: vi.fn().mockImplementation((k: string) => env[k]) };
  const redisSubscriber = { subscribeToChannel: vi.fn(), unsubscribeFromChannel: vi.fn() };
  const effectiveSettings = {
    resolveEffective: vi.fn(async (key: string) =>
      key === CONSULTATION_REALTIME_GRAPH_EXECUTOR_KEY ? { value: true, sourceScope: 'tenant' } : { value: undefined, sourceScope: 'code-default' },
    ),
  };
  const assignments = {
    resolve: vi.fn(async (): Promise<ResolvedWorkflowAssignment> => ({ workflowDefinitionSlug: SLUG, source: 'tenant' })),
  };
  const definitions = {
    findPublishedBySlug: vi.fn(async (tenantId: string, slug: string) =>
      tenantId === TENANT && slug === SLUG ? { slug, paletteKey: 'consultation', compiledConfig: opts.lane ?? coreAgentLane(opts.nodeConfig ?? {}) } : null,
    ),
  };
  const service = new LiveDocumentationService(
    http as never,
    configService as never,
    cacheMock() as never,
    redisSubscriber as never,
    undefined, // audioBridge
    undefined, // contextItemRepository
    harnessPolicyService as never,
    { encrypt: vi.fn(), decrypt: vi.fn(), getSecretOptional: vi.fn().mockResolvedValue('svc-token') } as never,
    undefined, // trajectoryService
    effectiveSettings as never,
    undefined, // aiTaskDefaultService
    { run: vi.fn((cb: () => unknown) => cb()), set: vi.fn(), get: vi.fn() } as never,
    { resolveForSession: vi.fn().mockResolvedValue(snapshot()) } as never,
    undefined, // textRequestEnrichment
    undefined, // documentTemplateService
    { findById: vi.fn(async (id: string) => ({ id, tenantId: TENANT, metadata: null })) } as never,
    assignments as never,
    definitions as never,
    undefined, // documentSectionRepository
    undefined, // promptTemplateRepository
    undefined, // liveAssist
    textAgents as never,
  );
  return { service, post };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) await new Promise((resolve) => setImmediate(resolve));
}

/** One flush; the TEXT calls are snapshotted BEFORE `stop()`, whose forced drain re-walks a failed node. */
async function runOneFlush(service: LiveDocumentationService, post: ReturnType<typeof vi.fn>) {
  service.start({ consultationId: CID, tenantId: TENANT });
  await settle();
  service.ingestSegment(CID, { text: 'Patient reports cough for three days.', isFinal: true, segmentId: 's1' });
  const payload = await service.flush(CID);
  const calls = generateCalls(post).map((c) => c[1] as Record<string, unknown>);
  await service.stop(CID, { persistSnapshot: false });
  return { payload, calls };
}

beforeEach(() => {
  vi.clearAllMocks();
  textAgents.resolve.mockResolvedValue(spec());
  harnessPolicyService.resolveTextSelection.mockResolvedValue({ provider: 'vllm', model: 'tenant-default' });
});

describe('core.agent on the realtime lane resolves its agentRef and generates through it', () => {
  it('resolves the explicit slug + pin through the text-agent resolver and calls TEXT with the agent’s model, prompt and parameters', async () => {
    const { service, post } = buildService({ generate: () => NOTE, nodeConfig: { overrides: { promptVariables: { tone: 'terse' }, generation: { temperature: 0.4 } } } });
    const { payload, calls } = await runOneFlush(service, post);

    expect(textAgents.resolve).toHaveBeenCalledWith({ tenantId: TENANT, agentSlug: 'clinic-summarizer', versionNumber: 3 });
    expect(calls).toHaveLength(1);
    const body = calls[0];
    expect(body.provider).toBe('vllm');
    expect(body.model).toBe('medgemma-27b');
    // The agent's resolved instruction, interpolated: the agent's own variable + the node's override (node wins).
    expect(body.system_prompt).toBe('Write the note for Ward 3 in a terse tone.');
    // Hyper-parameters: the agent's, with the node's `overrides.generation` layered on top.
    expect(body.temperature).toBe(0.4);
    expect(body.max_tokens).toBe(900);
    expect(body.top_p).toBe(0.8);
    // The legacy per-flush tenant resolve did NOT run — the agent selected.
    expect(harnessPolicyService.resolveTextSelection).not.toHaveBeenCalled();
    expect(payload?.textFailed).toBeFalsy();
    expect(payload?.metadata?.stats).toMatchObject({ task_key: 'text.live', selection_source: 'agent', agent_slug: 'clinic-summarizer', funding_tier: 'tenant' });
  });

  it('switches to the resolved fallback on primary failure when autoSwitch is ON, and says so on the stats', async () => {
    const { service, post } = buildService({ generate: (n) => (n === 0 ? new Error('primary provider down') : NOTE) });
    const { payload, calls } = await runOneFlush(service, post);

    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ provider: 'vllm', model: 'medgemma-27b' });
    expect(calls[1]).toMatchObject({ provider: 'lm-studio', model: 'gemma-4-e2b-it-qat', system_prompt: 'PLATFORM PROMPT.' });
    expect(payload?.textFailed).toBeFalsy();
    expect(payload?.metadata?.stats).toMatchObject({ selection_source: 'agent-fallback', agent_slug: 'platform-summarization', funding_tier: 'platform' });
  });

  it('honours autoSwitch:false — the tenant turned HA fallback off for this agent, so the node degrades instead of switching', async () => {
    textAgents.resolve.mockResolvedValue(spec({ autoSwitch: false }));
    const { service, post } = buildService({ generate: () => new Error('primary provider down') });
    const { payload, calls } = await runOneFlush(service, post);

    expect(calls).toHaveLength(1);
    expect(payload?.textFailed).toBe(true);
  });

  it('a version pin the resolver refuses (drift) FAILS CLOSED: no TEXT call, the node is degraded, nothing substituted', async () => {
    textAgents.resolve.mockRejectedValue(new ConflictException({ code: 'AGENT_VERSION_DRIFT', message: 'pinned to v3, active is v4' }));
    const { service, post } = buildService({ generate: () => NOTE });
    const { payload, calls } = await runOneFlush(service, post);

    expect(calls).toHaveLength(0);
    expect(harnessPolicyService.resolveTextSelection).not.toHaveBeenCalled();
    expect(payload?.textFailed).toBe(true);
  });

  it('a legacy consultation.realtimeSummary node still generates on the ASSIGNED agent through resolveTextSelection (2 args, no binding)', async () => {
    const lane = {
      slug: SLUG,
      versionNumber: 2,
      stages: [
        { stageIndex: 0, nodes: [{ nodeId: 'capture', type: 'consultation.captureBinding', config: {}, inputs: [], onError: 'fail' }] },
        {
          stageIndex: 1,
          nodes: [{ nodeId: 'summarize', type: 'consultation.realtimeSummary', config: {}, inputs: [{ fromNodeId: 'capture', fromPort: 'out', toPort: 'in' }], onError: 'degrade' }],
        },
      ],
    };
    const { service, post } = buildService({ generate: () => NOTE, lane });
    const { calls } = await runOneFlush(service, post);

    expect(textAgents.resolve).not.toHaveBeenCalled();
    expect(harnessPolicyService.resolveTextSelection).toHaveBeenCalledWith(TENANT, 'live');
    expect(calls[0]).toMatchObject({ provider: 'vllm', model: 'tenant-default', system_prompt: 'SESSION SYSTEM PROMPT.' });
  });
});
