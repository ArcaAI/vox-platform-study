/**
 * TASK-1001 Phase 3 (OD-1 / OD-3) — the output-language policy moves from CODE to CONTENT.
 *
 * ## What was wrong
 *
 * `operatingFrame()` GENERATED the note's output language from the consultation's declared
 * `summaryLanguage` and appended it after the rendered instruction. ALaaS declares `ml-en` — the
 * STT code-switch MODE, not an output language — the resolver took its primary subtag, and the
 * frame instructed the model to write the note in Malayalam. It did. No console setting could
 * have stopped it, because the rule lived in a private method.
 *
 * TASK-947 had already shipped the mechanism this needs (`instruction.fragments[]`: ordered,
 * each an inline body or a template pointer, each with an optional CEL `when`), with a tenant-admin
 * editor and per-call telemetry — and no seeded agent used it. The policy is now one shared
 * PromptTemplate referenced as an unconditional fragment by all 22 ArcaAI department summary
 * agents.
 *
 * ## The regression pin that is the whole point of this file (finding S-4)
 *
 * The generated line carried a second clause: *"Keep the section keys and headings exactly as
 * given, in English."* That clause is not cosmetic. ALaaS merges a live section onto a held one
 * by exact `documentKey::sectionKey`, or by title SLUG when one identity is generic
 * (`reducer/document.js` `findHeldIndex`). A translated or reworded heading is a DIFFERENT section
 * to that reducer: it inserts a twin, and `orderSections` dedupes on key only, so nothing ever
 * removes it. Retiring the generated line without carrying the clause forward would have caused
 * duplicate sections in the client — the very defect this ticket was opened about — by fixing the
 * language half. `carries the S-4 headings clause` below is that pin.
 *
 * Everything is asserted through the REAL prompt the service sends, never a snapshot of a private
 * method: `prompt` carries the operating frame, `system_prompt` carries the composed instruction.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { LiveDocumentationService } from '../live-documentation.service';
import { CONSULTATION_REALTIME_GRAPH_EXECUTOR_KEY } from '../../consultation-gates.constants';
import { DEFAULT_LIVE_TOOL_PLAN, type FrozenLiveAgentSnapshot } from '../live-agent.port';
import type { ResolvedWorkflowAssignment } from '../../../workflow-assignment/IWorkflowAssignmentService';
import type { ResolvedTextCandidate, ResolvedTextGenerationSpec } from '../../../agent/text-generation-spec';

const TENANT = '50000000-0000-0000-0000-000000000001';
const CID = 'consultation-1001-frame';
const SLUG = 'arcaai-heme-consultation';
const NOTE = 'Subjective: cough for three days\nObjective:\nAssessment:\nPlan:';

/** The department's own clinical body — the fragment that is NOT about language. */
const CLINICAL_BODY = 'HEMATOLOGY — NEW REFERRAL. Record the encounter under the headings below.';

/**
 * The S-4 clause, verbatim. Written out here rather than imported so this file states the
 * requirement independently of whatever any seed happens to say today: if the seeded policy body
 * ever drops it, the seed-side twin of this pin
 * (`packages/database/…/seed/__tests__/output-language-policy.task1001.test.ts`) fails, and if the
 * RENDER ever drops it, this one does.
 */
const HEADINGS_CLAUSE = 'Keep the section keys and headings exactly as given, in English.';

/** What the seeded `Output language policy` template says — the tenant's English opinion. */
const ENGLISH_POLICY = `OUTPUT LANGUAGE POLICY

Write every section value in English, whatever language was spoken.

${HEADINGS_CLAUSE} Do not translate, reword or re-order them.`;

/** The same row, edited by a tenant admin who wants Malayalam notes. One row, one edit, 22 agents. */
const MALAYALAM_POLICY = `OUTPUT LANGUAGE POLICY

Write every section value in Malayalam, whatever language was spoken.

${HEADINGS_CLAUSE} Do not translate, reword or re-order them.`;

type ResolvedPrompt = ResolvedTextCandidate['resolvedPrompt'];

const candidate = (over: Partial<ResolvedTextCandidate> = {}): ResolvedTextCandidate =>
  ({
    kind: 'primary',
    agent: { slug: 'arcaai-heme-summary-new-visit', versionId: 'a1', versionNumber: 3, tenantId: TENANT, source: 'explicit' },
    modelSlug: 'lms-gemma-4-e2b-it-qat',
    provider: 'lm-studio',
    model: 'gemma-4-e2b',
    resolvedPrompt: { source: 'inline', content: CLINICAL_BODY },
    instruction: { variables: {} },
    parameters: { generation: { temperature: 0, maxTokens: 900 }, responseFormat: 'text' },
    tools: [],
    fundingTier: 'tenant',
    ...over,
  }) as ResolvedTextCandidate;

const withArtifact = (resolvedPrompt: ResolvedPrompt): ResolvedTextGenerationSpec =>
  ({
    schemaVersion: 1,
    agent: {} as never,
    primary: candidate({ resolvedPrompt }),
    fallback: { autoSwitch: true, chain: [] },
  }) as ResolvedTextGenerationSpec;

/**
 * The seeded shape: the department's clinical template, then the shared policy row, BOTH
 * unconditional. `when: null` is what publish freezes for "always included"; the policy is LAST
 * because the nearest instruction to the generation point is the one a model honours.
 */
const compositeWithPolicy = (policyBody: string): ResolvedPrompt =>
  ({
    source: 'composite',
    join: '\n\n',
    content: `${CLINICAL_BODY}\n\n${policyBody}`,
    fragments: [
      { key: 'clinical_note', source: 'template' as const, content: CLINICAL_BODY, when: null },
      { key: 'output_language_policy', source: 'template' as const, content: policyBody, when: null },
    ],
  }) as ResolvedPrompt;

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
          config: {
            agentRef: { slug: 'arcaai-heme-summary-new-visit', versionNumber: 3 },
            execution: { lane: 'realtime', cadence: 'perTurn' },
          },
          inputs: [{ fromNodeId: 'capture', fromPort: 'out', toPort: 'in' }],
          onError: 'degrade',
        },
      ],
    },
  ],
});

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
  agentName: 'Hematology summary (new-visit)',
  promptTemplateId: 'tmpl-heme',
  promptVersionNumber: 3,
  stableUserPrefix: 'PREFIX.',
  systemPrompt: 'SESSION SYSTEM PROMPT.',
  toolPlan: DEFAULT_LIVE_TOOL_PLAN,
  frozenAt: '2026-09-22T00:00:00.000Z',
});

const textAgents = { resolve: vi.fn() };

/** `metadata` is what the consultation row carries — `{ summaryLanguage }` or nothing. */
function buildService(spec: ResolvedTextGenerationSpec, metadata: Record<string, unknown> | null) {
  const post = vi.fn().mockImplementation((url: string) => {
    if (url.includes('/generate')) return Promise.resolve({ data: { summary: NOTE, stats: { provider: 'lm-studio', model: 'gemma-4-e2b' } } });
    return Promise.resolve({ data: {} });
  });
  textAgents.resolve.mockResolvedValue(spec);
  const env: Record<string, unknown> = { LIVE_DOC_MIN_INTERVAL_MS: '0' };
  const configService = { get: vi.fn().mockImplementation((k: string) => env[k]) };
  const effectiveSettings = {
    resolveEffective: vi.fn(async (key: string) =>
      key === CONSULTATION_REALTIME_GRAPH_EXECUTOR_KEY ? { value: true, sourceScope: 'tenant' } : { value: undefined, sourceScope: 'code-default' },
    ),
  };
  const assignments = { resolve: vi.fn(async (): Promise<ResolvedWorkflowAssignment> => ({ workflowDefinitionSlug: SLUG, source: 'tenant' })) };
  const definitions = {
    findPublishedBySlug: vi.fn(async (tenantId: string, slug: string) =>
      tenantId === TENANT && slug === SLUG ? { slug, paletteKey: 'consultation', compiledConfig: coreAgentLane() } : null,
    ),
  };
  const service = new LiveDocumentationService(
    { axiosRef: { post } } as never,
    configService as never,
    cacheMock() as never,
    { subscribeToChannel: vi.fn(), unsubscribeFromChannel: vi.fn() } as never,
    undefined,
    undefined,
    { resolveTextSelection: vi.fn().mockResolvedValue({ provider: 'lm-studio', model: 'gemma-4-e2b' }) } as never,
    { encrypt: vi.fn(), decrypt: vi.fn(), getSecretOptional: vi.fn().mockResolvedValue('svc-token') } as never,
    undefined,
    effectiveSettings as never,
    undefined,
    { run: vi.fn((cb: () => unknown) => cb()), set: vi.fn(), get: vi.fn() } as never,
    { resolveForSession: vi.fn().mockResolvedValue(snapshot()) } as never,
    undefined,
    undefined,
    { findById: vi.fn(async (id: string) => ({ id, tenantId: TENANT, metadata })) } as never,
    assignments as never,
    definitions as never,
    undefined,
    undefined,
    undefined,
    textAgents as never,
    { assertMeterQuota: vi.fn().mockResolvedValue(undefined) } as never,
    { recordUsage: vi.fn().mockResolvedValue({ recorded: 1 }) } as never,
  );
  return { service, post };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) await new Promise((resolve) => setImmediate(resolve));
}

/** One flush. Returns BOTH halves of what the model reads: the user prompt and the instruction. */
async function flushOnce(
  spec: ResolvedTextGenerationSpec,
  metadata: Record<string, unknown> | null = null,
): Promise<{ prompt: string; systemPrompt: string; everything: string }> {
  const { service, post } = buildService(spec, metadata);
  service.start({ consultationId: CID, tenantId: TENANT });
  await settle();
  service.ingestSegment(CID, { text: 'Patient reports cough for three days.', isFinal: true, segmentId: 's1' });
  await service.flush(CID);
  // Read BEFORE `stop()`: stop runs its own final flush, and `at(-1)` would then sample that one.
  const generate = post.mock.calls.filter((call) => String(call[0]).includes('/generate'));
  await service.stop(CID, { persistSnapshot: false });
  expect(generate.length, 'the flush made no TEXT call').toBeGreaterThan(0);
  const body = generate.at(-1)![1] as { prompt?: string; system_prompt?: string };
  const prompt = String(body.prompt ?? '');
  const systemPrompt = String(body.system_prompt ?? '');
  return { prompt, systemPrompt, everything: `${systemPrompt}\n${prompt}` };
}

beforeEach(() => vi.clearAllMocks());

describe('`operatingFrame` no longer states the output language', () => {
  it('emits no language line for a consultation that DECLARED one', async () => {
    const { prompt } = await flushOnce(withArtifact({ source: 'inline', content: CLINICAL_BODY }), { summaryLanguage: 'ml' });

    expect(prompt).toContain('HOW TO PRODUCE THIS TURN:');
    // The two forms the retired step could take. Neither may survive in generated text.
    expect(prompt, 'the generated language directive is still being appended').not.toContain('Write every section value in');
    expect(prompt).not.toContain('No output language was declared');
    // …and `ml` must not reach the prompt by any other spelling either.
    expect(prompt).not.toContain('Malayalam');
  });

  it('emits no language line for the `ml-en` code-switch tag that caused the report', async () => {
    const { prompt } = await flushOnce(withArtifact({ source: 'inline', content: CLINICAL_BODY }), { summaryLanguage: 'ml-en' });

    expect(prompt).not.toContain('Write every section value in');
    expect(prompt).not.toContain('Malayalam');
  });

  it('keeps every OTHER step of the frame — this ticket retires one rule, not the procedure', async () => {
    const { prompt } = await flushOnce(withArtifact({ source: 'inline', content: CLINICAL_BODY }), { summaryLanguage: 'ml' });

    // 1 — translate internally (a property of the TRANSCRIPT, which is genuinely runtime).
    expect(prompt).toMatch(/PARTIAL and may be code-switched/);
    expect(prompt).toMatch(/understand it in English internally/);
    // 2 — merge, do not restart.
    expect(prompt).toMatch(/This is an UPDATE, not a fresh note/);
    // 3 — fill by key.
    expect(prompt).toMatch(/using these keys exactly:/);
    expect(prompt).toMatch(/never a placeholder, never invented content/);
    // 4 — no closing summary.
    expect(prompt).toMatch(/still in progress/);
  });

  it('renumbers the remaining steps 1-4 with no gap where the language step used to be', async () => {
    const { prompt } = await flushOnce(withArtifact({ source: 'inline', content: CLINICAL_BODY }));
    const frame = prompt.slice(prompt.indexOf('HOW TO PRODUCE THIS TURN:'));

    expect(frame.split('\n').filter((line) => /^\d+\. /.test(line)).map((line) => line.slice(0, 2))).toEqual(['1.', '2.', '3.', '4.']);
  });
});

describe('ABSENT is not English — nothing invents a default (TASK-891 OD-1 on the output axis)', () => {
  it('a consultation that declares nothing, on an agent with no policy, gets NO output-language instruction at all', async () => {
    const { everything } = await flushOnce(withArtifact({ source: 'inline', content: CLINICAL_BODY }), {});

    expect(everything).not.toContain('Write every section value in');
    expect(everything).not.toContain('No output language was declared');
    // The trap this whole posture exists to close: silently defaulting to English.
    expect(everything, 'an output language was invented for a consultation that declared none').not.toMatch(/OUTPUT LANGUAGE POLICY/);
  });

  it('…and the same holds when there is no consultation repository wired at all', async () => {
    const { everything } = await flushOnce(withArtifact({ source: 'inline', content: CLINICAL_BODY }), null);

    expect(everything).not.toContain('Write every section value in');
    expect(everything).not.toContain('No output language was declared');
  });
});

describe('the policy arrives through the FRAGMENT path instead', () => {
  it('carries the S-4 headings clause into the rendered instruction (REGRESSION PIN)', async () => {
    const { systemPrompt, everything } = await flushOnce(withArtifact(compositeWithPolicy(ENGLISH_POLICY)), { summaryLanguage: 'ml-en' });

    // If this fails, ALaaS twins every section it cannot match by title slug and nothing removes
    // the duplicates. See the module comment.
    expect(everything, 'the section-keys-and-headings-stay-English clause is gone from the prompt').toContain(HEADINGS_CLAUSE);
    expect(systemPrompt, 'the clause must ride on the instruction, where the tenant can edit it').toContain(HEADINGS_CLAUSE);
  });

  it('states the tenant`s output language, and the department body is still there beside it', async () => {
    const { systemPrompt } = await flushOnce(withArtifact(compositeWithPolicy(ENGLISH_POLICY)), { summaryLanguage: 'ml-en' });

    expect(systemPrompt).toContain('Write every section value in English');
    // The policy must be ADDED to the clinical instruction, never instead of it: the composite
    // form replaces `promptTemplateId`, so a wrong compile silently loses the department's body.
    expect(systemPrompt).toContain(CLINICAL_BODY);
    // Order: the policy is last, nearest the generation point.
    expect(systemPrompt.indexOf(CLINICAL_BODY)).toBeLessThan(systemPrompt.indexOf('OUTPUT LANGUAGE POLICY'));
  });

  it('a tenant that wants Malayalam notes gets them from ONE edited row — a consultation declaring `ml` included', async () => {
    const { systemPrompt, everything } = await flushOnce(withArtifact(compositeWithPolicy(MALAYALAM_POLICY)), { summaryLanguage: 'ml' });

    expect(systemPrompt).toContain('Write every section value in Malayalam');
    // …and even then the keys and headings stay English. The two clauses are independent: the
    // language is the tenant's choice, the heading identity is the client's contract.
    expect(systemPrompt).toContain(HEADINGS_CLAUSE);
    // The frame still says nothing about language — one place states the rule, and it is the row.
    expect(everything.slice(everything.indexOf('HOW TO PRODUCE THIS TURN:'))).not.toContain('Malayalam');
  });

  it('the policy does not depend on the consultation`s declaration — an undeclared consultation still gets it', async () => {
    // This is the flip side of "absent is not English": absent means the PLATFORM has no opinion,
    // not that the TENANT's configured one stops applying.
    const { systemPrompt } = await flushOnce(withArtifact(compositeWithPolicy(ENGLISH_POLICY)), {});

    expect(systemPrompt).toContain('Write every section value in English');
    expect(systemPrompt).toContain(HEADINGS_CLAUSE);
  });
});
