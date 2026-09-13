/**
 * A3 — `metadata.agent` names the agent that RAN THE TURN, not the one frozen at recording start.
 *
 * ## The defect
 *
 * `metadata.agent` was built from `FrozenLiveAgentSnapshot` — resolved once at `start()`, before a
 * single word has been spoken. On a department whose realtime lane splits by visit type
 * (`core.condition` → new-visit node | revisit node) the branch is not taken until the flush, so a
 * REVISIT consultation published `metadata.agent.{id, promptTemplateId}` describing the NEW-VISIT
 * agent, sitting in the same envelope as a `metadata.stats.agent_slug` reading
 * `arcaai-bren-summary-revisit`. One payload, two answers to "which prompt wrote this note", and
 * nothing to say which was real.
 *
 * ## What this file pins
 *
 *  1. A bound `core.agent` node's own agent is what the provenance names, and it agrees with
 *     `stats.agent_slug` by construction — both are read off the candidate the call served.
 *  2. That holds after a FALLBACK: when the primary's provider is down and the chain takes over,
 *     the provenance follows the candidate that actually answered, not the one that was asked.
 *  3. A node with no agent binding still reports the session's frozen identity — there the freeze
 *     genuinely is what ran, and inventing a correction would be the new defect.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { LiveDocumentationService } from '../live-documentation.service';
import { CONSULTATION_REALTIME_GRAPH_EXECUTOR_KEY } from '../../consultation-gates.constants';
import { DEFAULT_LIVE_TOOL_PLAN, type FrozenLiveAgentSnapshot } from '../live-agent.port';
import type { ResolvedWorkflowAssignment } from '../../../workflow-assignment/IWorkflowAssignmentService';
import type { ResolvedTextCandidate, ResolvedTextGenerationSpec } from '../../../agent/text-generation-spec';

const TENANT = '50000000-0000-0000-0000-000000000001';
const CID = 'consultation-provenance';
const LANE_SLUG = 'arcaai-bren-consultation';
const TURN = JSON.stringify({ subjective: { addition: 'Cough since monday.' } });

/** The REVISIT summariser — the agent the graph's revisit branch actually binds. */
const revisitCandidate = (): ResolvedTextCandidate => ({
  kind: 'primary',
  agent: { slug: 'arcaai-bren-summary-revisit', versionId: 'agent-revisit-v4', versionNumber: 4, tenantId: TENANT, source: 'explicit' },
  modelSlug: 'tenant-medgemma',
  provider: 'vllm',
  model: 'medgemma-27b',
  resolvedPrompt: { source: 'inline', content: 'REVISIT PROMPT.' },
  instruction: { systemPrompt: 'REVISIT PROMPT.' },
  parameters: { generation: { temperature: 0.1, maxTokens: 900 } },
  tools: [],
  fundingTier: 'tenant',
  contextSchema: null,
});

/** The SYSTEM row that terminates the fallback chain. */
const platformCandidate = (): ResolvedTextCandidate => ({
  ...revisitCandidate(),
  kind: 'platform-default',
  agent: {
    slug: 'platform-summarization',
    versionId: 'agent-platform-v1',
    versionNumber: 1,
    tenantId: '00000000-0000-0000-0000-000000000000',
    source: 'tenant',
  },
  provider: 'lm-studio',
  model: 'gemma-4-e2b-it-qat',
  fundingTier: 'platform',
});

const spec = (): ResolvedTextGenerationSpec => ({
  schemaVersion: 1,
  agent: {} as never,
  primary: revisitCandidate(),
  fallback: { autoSwitch: true, chain: [platformCandidate()] },
});

/** capture → one realtime `core.agent`, or (when `bind` is false) a node with no agentRef at all. */
const lane = (bind: boolean) => ({
  slug: LANE_SLUG,
  versionNumber: 2,
  stages: [
    { stageIndex: 0, nodes: [{ nodeId: 'capture', type: 'consultation.captureBinding', config: {}, inputs: [], onError: 'fail' }] },
    {
      stageIndex: 1,
      nodes: [
        {
          nodeId: 'n_summary_revisit',
          type: 'core.agent',
          config: {
            ...(bind ? { agentRef: { slug: 'arcaai-bren-summary-revisit', versionNumber: 4 } } : {}),
            execution: { lane: 'realtime', cadence: 'perTurn' },
          },
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

/**
 * The session freeze: the DEPARTMENT DEFAULT, which on this tenant is the new-visit agent. It is
 * deliberately nothing like the revisit candidate above — that difference is the defect.
 */
const snapshot = (): FrozenLiveAgentSnapshot => ({
  resolvedFrom: 'agent',
  agentId: 'agent-newvisit-v2',
  agentName: 'BREN New Visit',
  promptTemplateId: 'tmpl-newvisit',
  promptVersionNumber: 2,
  stableUserPrefix: 'PREFIX.',
  systemPrompt: 'SYSTEM.',
  toolPlan: DEFAULT_LIVE_TOOL_PLAN,
  frozenAt: '2026-09-13T00:00:00.000Z',
});

const textAgents = { resolve: vi.fn() };

function buildService(opts: { bind: boolean; generate: (call: number) => unknown }) {
  let n = 0;
  const post = vi.fn().mockImplementation((url: string) => {
    if (url.includes('/classify/tokens')) return Promise.resolve({ data: { entities: [], vitals: {} } });
    if (url.includes('/generate')) {
      const answer = opts.generate(n++);
      return answer instanceof Error
        ? Promise.reject(answer)
        : Promise.resolve({ data: { summary: answer, stats: { provider: 'echo', model: 'echo' } } });
    }
    return Promise.resolve({ data: {} });
  });
  const env: Record<string, unknown> = { LIVE_DOC_MIN_INTERVAL_MS: '0', LIVE_DOC_DURABLE_SNAPSHOT_MS: '0' };

  const service = new LiveDocumentationService(
    { axiosRef: { post } } as never,
    { get: vi.fn().mockImplementation((k: string) => env[k]) } as never,
    cacheMock() as never,
    { subscribeToChannel: vi.fn(), unsubscribeFromChannel: vi.fn() } as never,
    undefined, // audioBridge
    undefined, // contextItemRepository
    { resolveTextSelection: vi.fn().mockResolvedValue({ provider: 'vllm', model: 'tenant-default' }) } as never,
    { encrypt: vi.fn(), decrypt: vi.fn(), getSecretOptional: vi.fn().mockResolvedValue('svc-token') } as never,
    undefined, // trajectoryService
    {
      resolveEffective: vi.fn(async (key: string) =>
        key === CONSULTATION_REALTIME_GRAPH_EXECUTOR_KEY ? { value: true, sourceScope: 'tenant' } : { value: undefined, sourceScope: 'code-default' },
      ),
    } as never,
    { resolveDefault: vi.fn().mockResolvedValue({ model: { sourceUri: 'blaze999/Medical-NER' } }) } as never,
    { run: vi.fn((cb: () => unknown) => cb()), set: vi.fn(), get: vi.fn() } as never,
    { resolveForSession: vi.fn().mockResolvedValue(snapshot()) } as never,
    undefined, // textRequestEnrichment
    undefined, // documentTemplateService
    { findById: vi.fn(async (id: string) => ({ id, tenantId: TENANT, metadata: null })) } as never,
    { resolve: vi.fn(async (): Promise<ResolvedWorkflowAssignment> => ({ workflowDefinitionSlug: LANE_SLUG, source: 'tenant' })) } as never,
    {
      findPublishedBySlug: vi.fn(async (tenantId: string, slug: string) =>
        tenantId === TENANT && slug === LANE_SLUG ? { slug, paletteKey: 'consultation', compiledConfig: lane(opts.bind) } : null,
      ),
    } as never,
    undefined, // documentSectionRepository
    undefined, // promptTemplateRepository
    undefined, // liveAssist
    textAgents as never,
  );
  return service;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) await new Promise((resolve) => setImmediate(resolve));
}

async function runOneFlush(service: LiveDocumentationService) {
  service.start({ consultationId: CID, tenantId: TENANT });
  await settle();
  service.ingestSegment(CID, { text: 'Patient reports cough since monday.', isFinal: true, segmentId: 's1' });
  const payload = await service.flush(CID);
  await service.stop(CID, { persistSnapshot: false });
  return payload;
}

beforeEach(() => {
  vi.clearAllMocks();
  textAgents.resolve.mockResolvedValue(spec());
});

describe('A3 — live provenance names the agent that served the turn', () => {
  it('reports the BOUND node’s agent, not the department default frozen at start', async () => {
    const payload = await runOneFlush(buildService({ bind: true, generate: () => TURN }));

    expect(payload!.metadata?.agent).toEqual({
      id: 'agent-revisit-v4',
      name: 'arcaai-bren-summary-revisit',
      slug: 'arcaai-bren-summary-revisit',
      promptTemplateId: 'agent-revisit-v4',
      promptVersionNumber: 4,
      resolvedFrom: 'agent',
    });
    // The two halves of the envelope now agree. This equality IS the fix: they are both read off
    // the candidate the call ran, so they cannot drift again.
    expect(payload!.metadata?.agent?.slug).toBe(payload!.metadata?.stats?.agent_slug);
    // And none of the frozen new-visit identity survives anywhere in the provenance block.
    expect(JSON.stringify(payload!.metadata?.agent)).not.toContain('newvisit');
  });

  it('follows a FALLBACK: the candidate that answered is the one named', async () => {
    // The revisit agent's provider is down; `autoSwitch` walks the chain to the platform default,
    // which answers. `stats.agent_slug` has always said so — now the provenance does too.
    const payload = await runOneFlush(
      buildService({ bind: true, generate: (call) => (call === 0 ? new Error('vllm: connection refused') : TURN) }),
    );

    expect(payload!.metadata?.stats?.agent_slug).toBe('platform-summarization');
    expect(payload!.metadata?.agent).toMatchObject({
      id: 'agent-platform-v1',
      slug: 'platform-summarization',
      promptVersionNumber: 1,
    });
  });

  it('keeps the session-frozen identity for a node with NO agent binding', async () => {
    // Nothing was resolved per turn here, so the freeze is the honest answer and the pre-A3
    // payload shape is served unchanged — including the absence of `slug`.
    const payload = await runOneFlush(buildService({ bind: false, generate: () => TURN }));

    expect(payload!.metadata?.agent).toEqual({
      id: 'agent-newvisit-v2',
      name: 'BREN New Visit',
      promptTemplateId: 'tmpl-newvisit',
      promptVersionNumber: 2,
      resolvedFrom: 'agent',
    });
    expect(textAgents.resolve).not.toHaveBeenCalled();
  });
});
