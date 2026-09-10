/**
 * TASK-947 §4.6 (Lane B) — the REALTIME `core.agent` lane renders a COMPOSITE instruction.
 *
 * Everything here is the TASK-890 harness (`live-documentation.template-grammar.task890.test.ts`)
 * driving the same realtime flush, because the property under test is precisely that this lane's
 * render seam did not move for anything that is not composite:
 *
 *  - a `template` / `inline` artifact — and the `instruction.systemPrompt` fallback for a
 *    candidate carrying NO `resolvedPrompt` at all — must produce the SAME BYTES it did before
 *    `composePrompt` was introduced (`composePrompt`'s single-body branch IS `renderTemplate`
 *    over the §3.3 scope), and must stamp NO `prompt_fragments` on the flush stats;
 *  - a `composite` artifact selects its fragments over that same scope, renders each ON ITS OWN
 *    and joins them (§4.1), stamping the SELECTED KEYS — keys only (OD-11) — on the stats;
 *  - a condition that cannot evaluate EXCLUDES its fragment and never fails the node (OD-5),
 *    while a composition that selects NOTHING degrades it (OD-6, defensive) exactly as an
 *    unresolved prompt variable already does.
 *
 * The conditions below read `trigger.context.visit_type` — the path the SEEDED agents already bind
 * their clinical variables to. This lane's run payload carries its own `context` envelope
 * (`realtimeRunContext` answers `{ trigger: { context } }`), so the scope's `context` ALIAS is that
 * payload, and the clinical field sits one level in on either spelling. `visit_type` is always
 * supplied (TASK-943) and reads `'new-visit'` for the harness's parentless row, so every verdict here is a property
 * of the composition rather than of a session field the harness would have to fake.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LIVE_DOCUMENT_SYSTEM_PROMPT, LiveDocumentationService } from '../live-documentation.service';
import { CONSULTATION_REALTIME_GRAPH_EXECUTOR_KEY } from '../../consultation-gates.constants';
import { DEFAULT_LIVE_TOOL_PLAN, type FrozenLiveAgentSnapshot } from '../live-agent.port';
import type { ResolvedWorkflowAssignment } from '../../../workflow-assignment/IWorkflowAssignmentService';
import type { ResolvedTextCandidate, ResolvedTextGenerationSpec } from '../../../agent/text-generation-spec';

const TENANT = '50000000-0000-0000-0000-000000000001';
const CID = 'consultation-947';
const SLUG = 'agent-first-live';
const NOTE = 'Subjective: cough for three days\nObjective:\nAssessment:\nPlan:';

/** What `realtimeRunContext` binds for a consultation with no parent — the harness's own row (TASK-882/943). */
const VISIT_TYPE = 'new-visit';
/** Holds: `visit_type` is always supplied. */
const HOLDS = `trigger.context.visit_type == '${VISIT_TYPE}'`;
/** Does not hold: guarded with `has()`, so a missing key is FALSE, not an error. */
const DOES_NOT_HOLD = 'has(trigger.context.patient_age) && trigger.context.patient_age < 18';
/** Cannot evaluate: an UNGUARDED read of a key this lane does not publish (OD-5). */
const CANNOT_EVALUATE = 'trigger.context.patient_age < 18';

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

type ResolvedPrompt = ResolvedTextCandidate['resolvedPrompt'];

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

/** A spec whose primary candidate carries exactly this compiled artifact and this instruction. */
const withArtifact = (resolvedPrompt: ResolvedPrompt, instruction: Record<string, unknown> = { variables: {} }): ResolvedTextGenerationSpec =>
  ({
    schemaVersion: 1,
    agent: {} as never,
    primary: candidate({ resolvedPrompt, instruction }),
    fallback: { autoSwitch: true, chain: [] },
  }) as ResolvedTextGenerationSpec;

/** The composite shape publish stamps (OD-3): the static projection in `content`, fragments beside it. */
const composite = (fragments: Array<{ key: string; content: string; when: string | null }>): ResolvedPrompt =>
  ({
    source: 'composite',
    join: '\n\n',
    content: fragments
      .filter((fragment) => fragment.when === null)
      .map((fragment) => fragment.content)
      .join('\n\n'),
    fragments: fragments.map((fragment) => ({ key: fragment.key, source: 'inline' as const, content: fragment.content, when: fragment.when })),
  }) as ResolvedPrompt;

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

type FlushStats = { prompt_fragments?: string[] | null; agent_slug?: string | null } & Record<string, unknown>;

async function runOneFlush(service: LiveDocumentationService, post: ReturnType<typeof vi.fn>) {
  service.start({ consultationId: CID, tenantId: TENANT });
  await settle();
  service.ingestSegment(CID, { text: 'Patient reports cough for three days.', isFinal: true, segmentId: 's1' });
  const payload = await service.flush(CID);
  const calls = generateCalls(post).map((c) => c[1] as Record<string, unknown>);
  const stats = ((payload as { metadata?: { stats?: FlushStats } } | null)?.metadata?.stats ?? null) as FlushStats | null;
  await service.stop(CID, { persistSnapshot: false });
  return { payload, calls, stats };
}

beforeEach(() => {
  vi.clearAllMocks();
  entitlements.assertMeterQuota.mockResolvedValue(undefined);
  usageLedger.recordUsage.mockResolvedValue({ recorded: 1 });
});

describe('BYTE IDENTITY — an agent that is not composite renders exactly as it did before TASK-947', () => {
  it('an `inline` artifact produces the same bytes (composePrompt`s single-body branch IS renderTemplate)', async () => {
    const { service, post } = buildService(
      withArtifact({ source: 'inline', content: 'Patient {{patient.name}}, ward {{patient.ward}}.' }, { variables: { patient: { name: 'Ada', ward: '3' } } }),
    );

    const { calls } = await runOneFlush(service, post);

    expect(calls[0]?.system_prompt).toBe('Patient Ada, ward 3.');
  });

  it('a `template` artifact produces the same bytes', async () => {
    const { service, post } = buildService(
      withArtifact({ source: 'template', promptTemplateId: 'tmpl-1', promptVersionNumber: 3, content: 'Visit: {{trigger.context.visit_type}}.' }),
    );

    const { calls } = await runOneFlush(service, post);

    expect(calls[0]?.system_prompt).toBe(`Visit: ${VISIT_TYPE}.`);
  });

  it('a candidate with NO resolvedPrompt still falls back to `instruction.systemPrompt`', async () => {
    const { service, post } = buildService(withArtifact(null, { systemPrompt: 'INLINE FALLBACK {{trigger.context.visit_type}}', variables: {} }));

    const { calls } = await runOneFlush(service, post);

    expect(calls[0]?.system_prompt).toBe(`INLINE FALLBACK ${VISIT_TYPE}`);
  });

  it('a candidate carrying no instruction body at all still sends the platform prompt', async () => {
    const { service, post } = buildService(withArtifact(null, { variables: {} }));

    const { calls } = await runOneFlush(service, post);

    expect(calls[0]?.system_prompt).toBe(LIVE_DOCUMENT_SYSTEM_PROMPT);
  });

  it('stamps NO `prompt_fragments` on the stats — a single-body agent has no fragments to report', async () => {
    const { service, post } = buildService(withArtifact({ source: 'inline', content: 'PROMPT' }));

    const { stats } = await runOneFlush(service, post);

    expect(stats?.agent_slug).toBe('clinic-summarizer');
    expect(stats?.prompt_fragments ?? null).toBeNull();
  });
});

describe('a COMPOSITE artifact selects over the §3.3 scope, renders per fragment and joins', () => {
  const threeFragments = () =>
    composite([
      { key: 'base', content: 'BASE for {{trigger.context.visit_type}}.', when: null },
      { key: 'revisit', content: 'REVISIT ADDENDUM.', when: HOLDS },
      { key: 'peds', content: 'PEDS ADDENDUM.', when: DOES_NOT_HOLD },
    ]);

  it('sends the selected fragments joined by the artifact`s `join`, each rendered over the ONE scope', async () => {
    const { service, post } = buildService(withArtifact(threeFragments()));

    const { calls } = await runOneFlush(service, post);

    expect(calls[0]?.system_prompt).toBe(`BASE for ${VISIT_TYPE}.\n\nREVISIT ADDENDUM.`);
  });

  it('never sends the STATIC PROJECTION alone — the pre-947 read (`resolvedPrompt.content`) would have', async () => {
    const { service, post } = buildService(withArtifact(threeFragments()));

    const { calls } = await runOneFlush(service, post);

    expect(calls[0]?.system_prompt).not.toBe('BASE for {{trigger.context.visit_type}}.');
    expect(String(calls[0]?.system_prompt)).toContain('REVISIT ADDENDUM.');
  });

  it('stamps the SELECTED KEYS on the flush stats, and NEVER a condition or a fragment body (OD-11)', async () => {
    const { service, post } = buildService(withArtifact(threeFragments()));

    const { stats } = await runOneFlush(service, post);

    expect(stats?.prompt_fragments).toEqual(['base', 'revisit']);
    const serialised = JSON.stringify(stats);
    expect(serialised, 'a condition string reached the clinician-facing stats').not.toContain('trigger.context.visit_type');
    expect(serialised, 'a fragment body reached the clinician-facing stats').not.toContain('ADDENDUM');
  });

  it('OD-5 — a condition that CANNOT evaluate excludes its fragment and never fails the node', async () => {
    const { service, post } = buildService(
      withArtifact(
        composite([
          { key: 'base', content: 'BASE.', when: null },
          { key: 'broken', content: 'NEVER.', when: CANNOT_EVALUATE },
        ]),
      ),
    );

    const { calls, stats } = await runOneFlush(service, post);

    expect(calls, 'an unevaluable condition took the node out').toHaveLength(1);
    expect(calls[0]?.system_prompt).toBe('BASE.');
    expect(stats?.prompt_fragments).toEqual(['base']);
  });

  // Honest note: the pre-947 static-projection render answers the same bytes for THIS pair,
  // because `{{{{` is the grammar's escape for a literal `{{`. It is pinned anyway — it is the
  // fixture's own `per-fragment-render-no-cross-boundary` case, and the property must hold on
  // this lane too. The DISCRIMINATING proof is the static-projection test above.
  it('renders each fragment ON ITS OWN — a `{{` can never pair with a `}}` across the join', async () => {
    const { service, post } = buildService(
      withArtifact(
        composite([
          { key: 'open', content: '{{{{', when: null },
          { key: 'close', content: 'trigger.context.visit_type}}', when: null },
        ]),
      ),
    );

    const { calls } = await runOneFlush(service, post);

    expect(calls[0]?.system_prompt).toBe('{{\n\ntrigger.context.visit_type}}');
  });

  it('OD-6 — a composition that selects NOTHING degrades the node without calling TEXT', async () => {
    const spec = withArtifact(composite([{ key: 'only', content: 'NEVER.', when: DOES_NOT_HOLD }]));
    // The fallback chain must not be walked either: every candidate would compose identically.
    (spec.fallback as { chain: ResolvedTextCandidate[] }).chain = [candidate({ kind: 'platform-default' })];

    const { service, post } = buildService(spec);
    const { calls } = await runOneFlush(service, post);

    expect(calls).toHaveLength(0);
  });

  it('an unresolved variable INSIDE a fragment still degrades the node — the §3.2 posture is unchanged', async () => {
    const { service, post } = buildService(
      withArtifact(
        composite([
          { key: 'base', content: 'BASE.', when: null },
          { key: 'bad', content: '{{absent}}', when: null },
        ]),
      ),
    );

    const { calls } = await runOneFlush(service, post);

    expect(calls).toHaveLength(0);
  });
});
