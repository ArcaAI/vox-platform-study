/**
 * TASK-891 C2 (owner decision OD-4) — the ASSIGNED live agent's reasoning posture reaches TEXT.
 *
 * ## The defect
 *
 * Two halves that did not meet. TASK-891 made the routing task a real selector, so
 * `resolveTextSelection(tenant, 'live')` resolves a distinct live-tier agent through the
 * `phase:live` assignment tag — and that agent is seeded with
 * `parameters.generation.reasoning = { enabled: false }`. TASK-891 C2 built the wire:
 * `applyTextRuntimeProfile(target, generation)` turns the block into `extra.reasoning_effort`,
 * forwarded by `apps/text` as `extra_body`.
 *
 * But `resolveTextSelection` returned only `{ provider, model }`. The agent's parameters were
 * loaded during resolution and discarded, so on the ASSIGNED-AGENT path (`callText`'s
 * non-`core.agent` branch — every legacy `consultation.realtimeSummary` node, which is what the
 * seeded consultation graphs still carry) nothing was passed as `generation`. The live agent was
 * selected and its reasoning posture was inert.
 *
 * `live-documentation.reasoning.task891.test.ts` covers the OTHER branch — a `core.agent` node,
 * which has always had the block in hand via `callTextCandidate`. This file covers the branch
 * the cluster actually runs.
 *
 * ## Why the real chain, and the real enrichment service
 *
 * The claim is end to end: an agent ROW that authors `reasoning: { enabled: false }` produces a
 * `/api/v1/generate` body carrying `extra.reasoning_effort: 'minimal'`. Every link between those
 * two facts is real here — the assignment cascade, `AgentResolverService`,
 * `TextAgentResolverService`, `HarnessPolicyService.resolveTextSelection`, `callText` and
 * `TextRequestEnrichmentService`. Only the repositories and the HTTP hop are doubles.
 *
 * Why it is worth this much: measured on `gemma-4-e2b-it-qat` (cluster idle, 2026-09-07),
 * `reasoning_effort` unset costs 5168 ms and 184 reasoning tokens where `minimal` costs 1237 ms
 * and 30 — and a realtime SOAP flush of a 136-token transcript took 14.06 s against a 20 s
 * timeout, 78% of its completion budget spent on reasoning. This wiring is what turns the
 * live/finalize agent split into an actual speedup.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentTask, SYSTEM_TENANT_ID } from '@arcaai/domains';
import { agentTagsSatisfy, canonicalAgentTags } from '@arcaai/workflow-contract';
import { LiveDocumentationService } from '../live-documentation.service';
import { AgentResolverService } from '../../../agent/agent-resolver.service';
import { TextAgentResolverService } from '../../../agent/text-agent-resolver.service';
import { HarnessPolicyService } from '../../../harness-policy/harness-policy.service';
import { TextRequestEnrichmentService } from '../../../text-request/text-request-enrichment.service';
import { CONSULTATION_REALTIME_GRAPH_EXECUTOR_KEY } from '../../consultation-gates.constants';
import { DEFAULT_LIVE_TOOL_PLAN, type FrozenLiveAgentSnapshot } from '../live-agent.port';
import type { ResolvedWorkflowAssignment } from '../../../workflow-assignment/IWorkflowAssignmentService';

const TENANT = '50000000-0000-0000-0000-000000000001';
const CID = 'consultation-891-assigned';
const SLUG = 'legacy-realtime-summary';
const NOTE = 'Subjective: patient reports cough for three days\nObjective:\nAssessment:\nPlan:';

/** Agent rows, keyed by slug. The only thing that differs is the generation block each authored. */
const AGENTS: Record<string, { wireModelId: string; parameters: Record<string, unknown> }> = {
  /** The finalize tier: reasoning ON and expensive. It must NOT be what a live flush ships. */
  'platform-summarization': {
    wireModelId: 'gemma-4-e2b-it-qat',
    parameters: { generation: { temperature: 0.2, reasoning: { enabled: true, effort: 'high' } }, responseFormat: 'text' },
  },
  /** The live tier (seeded by TASK-891 C3): reasoning OFF. */
  'platform-summarization-live': {
    wireModelId: 'gemma-4-e2b-it-qat-live',
    parameters: { generation: { temperature: 0.1, reasoning: { enabled: false } }, responseFormat: 'text' },
  },
  /** A tenant that never authored a reasoning block — the engine's own default must stand. */
  'no-opinion-live': { wireModelId: 'quiet-model', parameters: { generation: { temperature: 0.1 }, responseFormat: 'text' } },
  /** `enabled: true` with a named budget — the posture travels verbatim, it is not a boolean. */
  'measured-live': {
    wireModelId: 'measured-model',
    parameters: { generation: { reasoning: { enabled: true, effort: 'low' } }, responseFormat: 'text' },
  },
};

interface Row {
  agentSlug: string;
  selectorKey: string;
}

/** The real tier walk of `AgentAssignmentService.resolve`: subset match, most specific first. */
function assignmentStore(rows: Row[]) {
  return {
    resolve: vi.fn(async (_tenantId: string, _task: AgentTask, _departmentId?: string | null, selectorTags: readonly string[] = []) => {
      const requestTags = canonicalAgentTags([...selectorTags]);
      const match = rows
        .map((row) => ({ row, selector: row.selectorKey ? row.selectorKey.split(',') : [] }))
        .filter(({ selector }) => agentTagsSatisfy(requestTags, selector))
        .sort((a, b) => b.selector.length - a.selector.length || a.row.selectorKey.localeCompare(b.row.selectorKey))[0];
      return match
        ? { agentSlug: match.row.agentSlug, source: 'tenant' as const, selector: match.selector }
        : { agentSlug: null, source: 'unassigned' as const, selector: [] };
    }),
  };
}

const agentRepository = {
  findPublishedActiveBySlug: vi.fn(async (tenantId: string, slug: string) => {
    const fixture = AGENTS[slug];
    if (!fixture) return null;
    return {
      id: `agent-${slug}`,
      tenantId,
      slug,
      versionNumber: 1,
      task: AgentTask.TEXT_GENERATION,
      compiledConfig: {
        task: 'TEXT_GENERATION',
        service: 'llm',
        model: { id: `m-${slug}`, slug: `m-${slug}`, provider: 'lm-studio', taskType: 'TEXT_GENERATION' },
        fallbacks: [],
        instruction: null,
        resolvedPrompt: null,
        parameters: fixture.parameters,
        inputSchema: { type: 'object' },
        outputSchema: { type: 'object' },
        tools: [],
        protocols: ['http'],
      },
    };
  }),
};

const aiModelRepository = {
  findById: vi.fn(async (id: string) => ({
    id,
    tenantId: SYSTEM_TENANT_ID,
    slug: id,
    sourceUri: id,
    sourceRevision: null,
    localPath: null,
    checksum: null,
    format: 'GGUF',
    computeType: null,
    provider: 'lm-studio',
    wireModelId: AGENTS[id.replace(/^m-/, '')]?.wireModelId ?? id,
  })),
  findBySlug: vi.fn(async () => null),
};

/** A tenant graph carrying the LEGACY summary node — no `agentRef`, so `callText` takes the assigned-agent branch. */
const legacyLane = () => ({
  slug: SLUG,
  versionNumber: 2,
  stages: [
    { stageIndex: 0, nodes: [{ nodeId: 'capture', type: 'consultation.captureBinding', config: {}, inputs: [], onError: 'fail' }] },
    {
      stageIndex: 1,
      nodes: [
        {
          nodeId: 'summarize',
          type: 'consultation.realtimeSummary',
          config: {},
          inputs: [{ fromNodeId: 'capture', fromPort: 'out', toPort: 'in' }],
          onError: 'degrade',
        },
      ],
    },
  ],
});

/**
 * The two SIBLING live hops that share the same selection: Lane R's grammar pass and Lane N's
 * findings miner. Both call `resolveTextSelection(tenantId, 'live')` and both post to
 * `/api/v1/generate` on the same 20 s realtime budget, so a live agent that declined reasoning
 * must be obeyed by all three or the flush pays for it twice on the hops nobody looked at.
 */
const siblingHopsLane = () => ({
  slug: SLUG,
  versionNumber: 2,
  stages: [
    { stageIndex: 0, nodes: [{ nodeId: 'capture', type: 'consultation.captureBinding', config: {}, inputs: [], onError: 'fail' }] },
    {
      stageIndex: 1,
      nodes: [
        {
          nodeId: 'grammar',
          type: 'agent.grammar',
          config: { promptTemplateId: 'tmpl-correction' },
          inputs: [{ fromNodeId: 'capture', fromPort: 'out', toPort: 'in' }],
          onError: 'degrade',
        },
        {
          nodeId: 'findings',
          type: 'agent.important_findings',
          config: { promptTemplateId: 'tmpl-findings' },
          inputs: [{ fromNodeId: 'capture', fromPort: 'out', toPort: 'in' }],
          onError: 'degrade',
        },
      ],
    },
  ],
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
  frozenAt: '2026-09-07T00:00:00.000Z',
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

/** A fresh chain per run — `TextAgentResolverService` caches a resolved spec for 15 s. */
function buildService(rows: Row[], lane: () => unknown = legacyLane) {
  const post = vi.fn(async (url: string) => (url.includes('/generate') ? { data: { summary: NOTE } } : { data: {} }));
  const env: Record<string, unknown> = { LIVE_DOC_MIN_INTERVAL_MS: '0' };
  const assignments = assignmentStore(rows);
  const agents = new AgentResolverService(
    agentRepository as never,
    { findByAgentId: vi.fn(async () => []) } as never,
    aiModelRepository as never,
    assignments as never,
  );
  const textAgents = new TextAgentResolverService(agents, assignments as never);
  const harnessPolicyService = new HarnessPolicyService(
    { findForExactTenant: vi.fn(async () => null), findSystemDefault: vi.fn(async () => null) } as never,
    { create: vi.fn() } as never,
    { baseClient: { $transaction: vi.fn() } } as never,
    { get: vi.fn((key: string) => (key === 'tenantId' ? TENANT : undefined)) } as never,
    undefined,
    { resolveDefault: vi.fn() } as never,
    undefined,
    undefined,
    textAgents,
  );

  const service = new LiveDocumentationService(
    { axiosRef: { post }, post } as never,
    { get: vi.fn().mockImplementation((k: string) => env[k]) } as never,
    cacheMock() as never,
    { subscribeToChannel: vi.fn(), unsubscribeFromChannel: vi.fn() } as never,
    undefined,
    undefined,
    harnessPolicyService as never,
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
    // The REAL enrichment service — a double would assert nothing about the wire it builds.
    new TextRequestEnrichmentService({ get: vi.fn().mockReturnValue(TENANT) } as never, undefined, undefined) as never,
    undefined,
    { findById: vi.fn(async (id: string) => ({ id, tenantId: TENANT, metadata: null })) } as never,
    { resolve: vi.fn(async (): Promise<ResolvedWorkflowAssignment> => ({ workflowDefinitionSlug: SLUG, source: 'tenant' })) } as never,
    { findPublishedBySlug: vi.fn(async () => ({ slug: SLUG, paletteKey: 'consultation', compiledConfig: lane() })) } as never,
    undefined,
    // promptTemplateRepository — the governed prompts the grammar / findings nodes bind.
    { findById: vi.fn(async (id: string) => ({ id, status: 'APPROVED', content: `PROMPT ${id}` })) } as never,
    undefined,
    textAgents as never,
  );
  return { service, post };
}

/** One flush on the legacy summary node; returns the bodies actually POSTed to TEXT. */
async function runOneFlush(rows: Row[], lane?: () => unknown) {
  const { service, post } = buildService(rows, lane);
  service.start({ consultationId: CID, tenantId: TENANT });
  for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setImmediate(resolve));
  service.ingestSegment(CID, { text: 'Patient reports cough for three days.', isFinal: true, segmentId: 's1' });
  await service.flush(CID);
  const bodies = post.mock.calls.filter((c) => String(c[0]).includes('/generate')).map((c) => c[1] as Record<string, unknown>);
  await service.stop(CID, { persistSnapshot: false });
  return bodies;
}

const SPLIT: Row[] = [
  { agentSlug: 'platform-summarization', selectorKey: '' },
  { agentSlug: 'platform-summarization-live', selectorKey: 'phase:live' },
];

beforeEach(() => vi.clearAllMocks());

describe('TASK-891 — the ASSIGNED live agent`s reasoning posture reaches the wire', () => {
  it('a live agent that disables reasoning ships `extra.reasoning_effort: minimal`', async () => {
    const bodies = await runOneFlush(SPLIT);

    expect(bodies).toHaveLength(1);
    // The LIVE tier answered, not the unqualified finalize row.
    expect(bodies[0].model).toBe('gemma-4-e2b-it-qat-live');
    expect(bodies[0].extra, 'the live agent`s reasoning posture never reached the wire').toEqual({ reasoning_effort: 'minimal' });
  });

  /**
   * ABSENCE, not `undefined`. An unset optional serialises as a JSON key with a null-ish value
   * on some transports and as nothing on others; the engine's default is what "no opinion"
   * means, so the field must simply not be there.
   */
  it('a live agent with no reasoning block sends no `extra` key at all', async () => {
    const bodies = await runOneFlush([{ agentSlug: 'no-opinion-live', selectorKey: '' }]);

    expect(bodies[0].model).toBe('quiet-model');
    expect(Object.keys(bodies[0])).not.toContain('extra');
  });

  it('an effort the agent named travels verbatim rather than collapsing to on/off', async () => {
    const bodies = await runOneFlush([{ agentSlug: 'measured-live', selectorKey: '' }]);

    expect(bodies[0].extra).toEqual({ reasoning_effort: 'low' });
  });

  /**
   * The whole point of the live/finalize split: one agent holds one posture, so the tier that
   * SERVED must be the tier whose posture ships. A tenant with only the unqualified row is
   * unaffected — that row satisfies every phase — which is what the second case pins.
   */
  it('the LIVE tier`s posture ships, never the finalize tier`s', async () => {
    const split = await runOneFlush(SPLIT);
    expect(split[0].extra).toEqual({ reasoning_effort: 'minimal' });

    const unqualifiedOnly = await runOneFlush([{ agentSlug: 'platform-summarization', selectorKey: '' }]);
    expect(unqualifiedOnly[0].model).toBe('gemma-4-e2b-it-qat');
    expect(unqualifiedOnly[0].extra).toEqual({ reasoning_effort: 'high' });
  });
});

/**
 * The running note is not the only TEXT call a flush makes. Lane R's grammar pass and Lane N's
 * findings miner resolve the SAME `('live')` selection and post to the same endpoint inside the
 * same flush budget — so a posture honoured on one hop and ignored on the other two buys back a
 * third of the saving and makes the control look broken to the tenant who set it.
 */
describe('TASK-891 — the sibling live hops obey the same agent', () => {
  it('the grammar pass and the findings miner both carry the live agent`s posture', async () => {
    const bodies = await runOneFlush(SPLIT, siblingHopsLane);

    expect(bodies).toHaveLength(2);
    for (const body of bodies) {
      expect(body.model).toBe('gemma-4-e2b-it-qat-live');
      expect(body.extra).toEqual({ reasoning_effort: 'minimal' });
    }
  });

  it('an agent with no reasoning opinion leaves both sibling hops byte-identical to before', async () => {
    const bodies = await runOneFlush([{ agentSlug: 'no-opinion-live', selectorKey: '' }], siblingHopsLane);

    expect(bodies).toHaveLength(2);
    for (const body of bodies) expect(Object.keys(body)).not.toContain('extra');
  });
});
