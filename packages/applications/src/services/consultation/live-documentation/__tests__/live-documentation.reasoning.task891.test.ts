/**
 * TASK-891 C2 + C5 — the agent's reasoning posture on the wire, and `reasoning_content` off it.
 *
 * ## C2 — the posture reaches TEXT
 *
 * The agent's `parameters.generation.reasoning` block travels as `GenerateRequest.reasoning`,
 * the neutral posture each adapter renders into its own engine's parameter (TASK-970; it was
 * `extra.reasoning_effort` under TASK-891, which only three adapters ever read).
 * So the whole of C2 is: read `parameters.generation.reasoning` off the RESOLVED agent and
 * merge it into `extra` on the `applyTextRuntimeProfile` path the three live TEXT hops
 * already call. No new field, no new HTTP call, no new adapter.
 *
 * ## C5 — the contract that keeps thinking out of the note
 *
 * The providers split `reasoning_content` from `content` and meter it separately
 * (`apps/text/.../providers/openai.py`). The gateway reads only `summary`/`content`
 * (`mapTextGenerateResponse`), so a model's chain of thought has never reached
 * `parseDocumentJson` — and with reasoning now a per-agent control, someone WILL turn it up.
 * This pins the property rather than leaving it a happy accident: a response carrying a
 * reasoning field must produce a note built from the answer alone.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LiveDocumentationService } from '../live-documentation.service';
import { TextRequestEnrichmentService } from '../../../text-request/text-request-enrichment.service';
import { CONSULTATION_REALTIME_GRAPH_EXECUTOR_KEY } from '../../consultation-gates.constants';
import { DEFAULT_LIVE_TOOL_PLAN, type FrozenLiveAgentSnapshot } from '../live-agent.port';
import type { ResolvedWorkflowAssignment } from '../../../workflow-assignment/IWorkflowAssignmentService';
import type { ResolvedTextCandidate, ResolvedTextGenerationSpec } from '../../../agent/text-generation-spec';

const TENANT = '50000000-0000-0000-0000-000000000001';
const CID = 'consultation-891-c2';
const SLUG = 'agent-first-live';
const NOTE = 'Subjective: patient reports cough for three days\nObjective:\nAssessment:\nPlan:';
/** What a reasoning model would emit alongside the answer — and must never reach the note. */
const CHAIN_OF_THOUGHT = 'The user wants a SOAP note. Let me think about differentials: pneumonia? bronchitis?';

const candidate = (generation: Record<string, unknown>): ResolvedTextCandidate => ({
  kind: 'primary',
  agent: { slug: 'clinic-summarizer', versionId: 'a1', versionNumber: 3, tenantId: TENANT, source: 'explicit' },
  modelSlug: 'tenant-medgemma',
  provider: 'vllm',
  model: 'medgemma-27b',
  resolvedPrompt: { source: 'inline', content: 'Write the note.' },
  instruction: { systemPrompt: 'Write the note.' },
  parameters: { generation, responseFormat: 'text' },
  tools: [],
  fundingTier: 'tenant',
});

const spec = (generation: Record<string, unknown>): ResolvedTextGenerationSpec => ({
  schemaVersion: 1,
  agent: {} as never,
  primary: candidate(generation),
  fallback: { autoSwitch: false, chain: [] },
});

const coreAgentLane = () => ({
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

const textAgents = { resolve: vi.fn() };

/**
 * The REAL enrichment service, not a double — C2's whole claim is that the existing
 * `applyTextRuntimeProfile` path carries this, so a stubbed one would assert nothing.
 */
const enrichment = () =>
  new TextRequestEnrichmentService({ get: vi.fn().mockReturnValue(TENANT) } as never, undefined, undefined);

function buildService(opts: { generation: Record<string, unknown>; responseData?: Record<string, unknown> }) {
  const post = vi.fn(async (url: string) => {
    if (url.includes('/generate')) return { data: opts.responseData ?? { summary: NOTE } };
    return { data: {} };
  });
  const env: Record<string, unknown> = { LIVE_DOC_MIN_INTERVAL_MS: '0' };
  textAgents.resolve.mockResolvedValue(spec(opts.generation));

  const service = new LiveDocumentationService(
    { axiosRef: { post }, post } as never,
    { get: vi.fn().mockImplementation((k: string) => env[k]) } as never,
    cacheMock() as never,
    { subscribeToChannel: vi.fn(), unsubscribeFromChannel: vi.fn() } as never,
    undefined,
    undefined,
    { resolveTextSelection: vi.fn().mockResolvedValue({ provider: 'vllm', model: 'tenant-default' }) } as never,
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
    enrichment() as never,
    undefined,
    { findById: vi.fn(async (id: string) => ({ id, tenantId: TENANT, metadata: null })) } as never,
    { resolve: vi.fn(async (): Promise<ResolvedWorkflowAssignment> => ({ workflowDefinitionSlug: SLUG, source: 'tenant' })) } as never,
    { findPublishedBySlug: vi.fn(async () => ({ slug: SLUG, paletteKey: 'consultation', compiledConfig: coreAgentLane() })) } as never,
    undefined,
    undefined,
    undefined,
    textAgents as never,
  );
  return { service, post };
}

async function runOneFlush(opts: Parameters<typeof buildService>[0]) {
  const { service, post } = buildService(opts);
  service.start({ consultationId: CID, tenantId: TENANT });
  for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setImmediate(resolve));
  service.ingestSegment(CID, { text: 'Patient reports cough for three days.', isFinal: true, segmentId: 's1' });
  const payload = await service.flush(CID);
  const bodies = post.mock.calls.filter((c) => String(c[0]).includes('/generate')).map((c) => c[1] as Record<string, unknown>);
  await service.stop(CID, { persistSnapshot: false });
  return { payload, bodies };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('TASK-891 C2 — the agent`s reasoning posture rides GenerateRequest.reasoning', () => {
  it('an agent that disables reasoning instructs the engine not to reason', async () => {
    const { bodies } = await runOneFlush({ generation: { temperature: 0.1, reasoning: { enabled: false } } });

    expect(bodies).toHaveLength(1);
    expect(bodies[0].reasoning, 'the agent`s reasoning posture never reached the wire').toEqual({ enabled: false });
  });

  it('an agent that asks for an effort sends that effort', async () => {
    const { bodies } = await runOneFlush({ generation: { reasoning: { enabled: true, effort: 'low' } } });
    expect(bodies[0].reasoning).toEqual({ enabled: true, effort: 'low' });
  });

  it('an agent with no reasoning opinion sends no `reasoning` at all — absence is its own statement', async () => {
    const { bodies } = await runOneFlush({ generation: { temperature: 0.1 } });
    expect(bodies[0].reasoning).toBeUndefined();
  });
});

describe('TASK-891 C5 — `reasoning_content` never reaches the document parser', () => {
  it('a response carrying reasoning builds the note from the answer alone', async () => {
    const { payload, bodies } = await runOneFlush({
      generation: { reasoning: { enabled: true, effort: 'high' } },
      responseData: { summary: NOTE, reasoning_content: CHAIN_OF_THOUGHT, content: NOTE },
    });

    expect(bodies[0].reasoning).toEqual({ enabled: true, effort: 'high' });
    expect(payload).not.toBeNull();
    expect(payload!.runningSummary).not.toContain('differentials');
    expect(payload!.runningSummary).not.toContain(CHAIN_OF_THOUGHT);
    for (const section of payload!.sections) {
      expect(section.content).not.toContain(CHAIN_OF_THOUGHT);
    }
    // The answer itself still made it through — this is not passing by producing nothing.
    expect(payload!.runningSummary).toContain('cough');
  });

  it('reasoning that arrives INSTEAD of an answer produces no note rather than a note of thoughts', async () => {
    const { payload } = await runOneFlush({
      generation: { reasoning: { enabled: true } },
      responseData: { reasoning_content: CHAIN_OF_THOUGHT },
    });

    expect(payload?.runningSummary ?? '').not.toContain(CHAIN_OF_THOUGHT);
  });
});
