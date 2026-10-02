/**
 * TASK-1001 — the note's OUTPUT language on the live lane: the tenant's policy when it is selected,
 * the PLATFORM DEFAULT (English) otherwise, and never the consultation's declared language.
 *
 * ## The history this file carries
 *
 * `operatingFrame()` used to GENERATE the output language from the consultation's declared
 * `summaryLanguage`. ALaaS declares `ml-en` — the STT code-switch MODE, "Malayalam-led, English
 * mixed" — the resolver took its primary subtag, and the frame instructed Malayalam. Lane L3 then
 * removed the step and moved the policy into a tenant prompt fragment, leaving NO instruction when
 * a tenant had none; the clinical corpus's own "the section content MUST be in the conversation
 * language" (~40 places) then decided, which for a code-switched consultation is a code-switched
 * note.
 *
 * Owner decision 2026-09-23: *"The summarization (both pre-summary and summary) is still in
 * English, by admin configuration OR by default."* So:
 *
 *  - policy fragment SELECTED for the call ⇒ the frame states NO language; the tenant's text owns
 *    it (and a tenant that wants Malayalam notes gets them, headings still English);
 *  - otherwise ⇒ the frame states the platform default (`consultation.summary.outputLanguage`), by
 *    name, NAMING and overriding the corpus's conversation-language clause (the 2026-08-10 lesson:
 *    a generic label loses to a specific in-template instruction), and keeping the headings clause;
 *  - the pre-summary's `language_name` is the OUTPUT language; `language` stays the SOURCE tag.
 *
 * ## The regression pin that must never go (finding S-4)
 *
 * *"Keep the section keys and headings exactly as given, in English."* ALaaS merges a live section
 * onto a held one by byte-identical title when one identity is generic; a translated heading is a
 * different section to that reducer, it inserts a twin, and nothing ever removes it. Whichever of
 * the two sources states the language — the tenant's policy or the platform default — the clause
 * must be in the prompt.
 *
 * Everything is asserted through the REAL request the service sends: `system_prompt` carries the
 * composed instruction and, after it, the operating frame.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { LiveDocumentationService } from '../live-documentation.service';
import { CONSULTATION_REALTIME_GRAPH_EXECUTOR_KEY } from '../../consultation-gates.constants';
import { CONSULTATION_OUTPUT_LANGUAGE_KEY } from '../../../settings-registry/descriptors/consultation-output-language.descriptors';
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
 * requirement independently of whatever the runtime or any seed happens to say today.
 */
const HEADINGS_CLAUSE = 'Keep the section keys and headings exactly as given, in English.';

/** The override, named — the corpus says "the section content MUST be in the conversation language". */
const OVERRIDE_CLAUSE = 'regardless of any instruction elsewhere in this prompt to write content in the conversation language';

/** What the seeded `Output language policy` template says — the tenant's English opinion. */
const ENGLISH_POLICY = `OUTPUT LANGUAGE POLICY

Write every section value in English, whatever language was spoken, ${OVERRIDE_CLAUSE}.

${HEADINGS_CLAUSE} Do not translate, reword or re-order them.`;

/** The same row, edited by a tenant admin who wants Malayalam notes. */
const MALAYALAM_POLICY = `OUTPUT LANGUAGE POLICY

Write every section value in Malayalam, whatever language was spoken, ${OVERRIDE_CLAUSE}.

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

const INLINE_BODY = (): ResolvedPrompt => ({ source: 'inline', content: CLINICAL_BODY }) as ResolvedPrompt;

/**
 * The seeded shape: the department's clinical template, then the shared policy row. `when: null` is
 * what publish freezes for "always included"; a string is the authored CEL condition.
 */
const compositeWithPolicy = (policyBody: string, when: string | null = null): ResolvedPrompt =>
  ({
    source: 'composite',
    join: '\n\n',
    content: when === null ? `${CLINICAL_BODY}\n\n${policyBody}` : CLINICAL_BODY,
    fragments: [
      { key: 'clinical_note', source: 'template' as const, content: CLINICAL_BODY, when: null },
      { key: 'output_language_policy', source: 'template' as const, content: policyBody, when },
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

/**
 * The settings facade: the graph executor on, and `consultation.summary.outputLanguage` answering
 * `platformDefault` — `undefined` reproduces "nothing stored", which the real facade answers with
 * the descriptor default and this lane must treat the same way.
 */
const settingsFacade = (platformDefault?: unknown) => ({
  resolveEffective: vi.fn(async (key: string) => {
    if (key === CONSULTATION_REALTIME_GRAPH_EXECUTOR_KEY) return { value: true, sourceScope: 'tenant' };
    if (key === CONSULTATION_OUTPUT_LANGUAGE_KEY) {
      return platformDefault === undefined ? { value: 'en', sourceScope: 'code-default' } : { value: platformDefault, sourceScope: 'system' };
    }
    return { value: undefined, sourceScope: 'code-default' };
  }),
});

/** `metadata` is what the consultation row carries — `{ summaryLanguage }` or nothing. */
function buildService(spec: ResolvedTextGenerationSpec, metadata: Record<string, unknown> | null, platformDefault?: unknown) {
  const post = vi.fn().mockImplementation((url: string) => {
    if (url.includes('/generate')) return Promise.resolve({ data: { summary: NOTE, stats: { provider: 'lm-studio', model: 'gemma-4-e2b' } } });
    return Promise.resolve({ data: {} });
  });
  textAgents.resolve.mockResolvedValue(spec);
  const env: Record<string, unknown> = { LIVE_DOC_MIN_INTERVAL_MS: '0' };
  const configService = { get: vi.fn().mockImplementation((k: string) => env[k]) };
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
    settingsFacade(platformDefault) as never,
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

interface Flush {
  prompt: string;
  systemPrompt: string;
  /** From `HOW TO PRODUCE THIS TURN:` to the end of the system message. */
  frame: string;
  /** The numbered frame steps, in order. */
  steps: string[];
}

/** One flush. Returns BOTH halves of what the model reads: the user prompt and the instruction. */
async function flushOnce(
  spec: ResolvedTextGenerationSpec,
  metadata: Record<string, unknown> | null = null,
  platformDefault?: unknown,
): Promise<Flush> {
  const { service, post } = buildService(spec, metadata, platformDefault);
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
  // The turn's operating frame is an instruction, so it is part of the SYSTEM message, after the
  // agent's instruction and the stable lead-in; `systemPrompt` is everything before it.
  const system = String(body.system_prompt ?? '');
  const frameAt = system.indexOf('HOW TO PRODUCE THIS TURN:');
  const frame = system.slice(frameAt);
  return {
    prompt,
    systemPrompt: system.slice(0, frameAt),
    frame,
    steps: frame.split('\n').filter((line) => /^\d+\. /.test(line)),
  };
}

beforeEach(() => vi.clearAllMocks());

describe('no tenant policy selected — the frame states the PLATFORM DEFAULT, English', () => {
  it.each([
    ['`ml-en` (the code-switch mode that caused the report)', { summaryLanguage: 'ml-en' }],
    ['`ml`', { summaryLanguage: 'ml' }],
    ['nothing', {}],
  ])('a consultation declaring %s gets an ENGLISH note', async (_label, metadata) => {
    const { frame } = await flushOnce(withArtifact(INLINE_BODY()), metadata);

    expect(frame).toContain('Write every section value in English, whatever language was spoken');
    // The source tag never reaches the output instruction by any spelling.
    expect(frame).not.toContain('Malayalam');
    expect(frame).not.toContain('ml-en');
  });

  it('…and so does a session with no consultation repository wired at all', async () => {
    const { frame } = await flushOnce(withArtifact(INLINE_BODY()), null);
    expect(frame).toContain('Write every section value in English');
  });

  it('NAMES the conflict it overrides — a bare "write in English" loses to the corpus`s own clause', async () => {
    const { frame } = await flushOnce(withArtifact(INLINE_BODY()), { summaryLanguage: 'ml-en' });
    expect(frame).toContain(OVERRIDE_CLAUSE);
  });

  it('carries the S-4 headings clause verbatim (REGRESSION PIN)', async () => {
    const { frame } = await flushOnce(withArtifact(INLINE_BODY()), { summaryLanguage: 'ml-en' });
    expect(frame, 'without it ALaaS twins every section it cannot match by title').toContain(HEADINGS_CLAUSE);
  });

  it('is step 3 of five, numbered with no gap, and every other step is still there', async () => {
    const { steps } = await flushOnce(withArtifact(INLINE_BODY()), { summaryLanguage: 'ml' });

    expect(steps.map((line) => line.slice(0, 2))).toEqual(['1.', '2.', '3.', '4.', '5.']);
    expect(steps[0]).toMatch(/PARTIAL and may be code-switched/);
    expect(steps[1]).toMatch(/This is an UPDATE, not a fresh note/);
    expect(steps[2]).toMatch(/^3\. Write every section value in English/);
    expect(steps[3]).toMatch(/using these keys exactly:/);
    expect(steps[4]).toMatch(/still in progress/);
  });

  it('a platform admin can change the default — `ml` is stated as Malayalam, headings still English', async () => {
    const { frame } = await flushOnce(withArtifact(INLINE_BODY()), { summaryLanguage: 'en' }, 'ml');

    expect(frame).toContain('Write every section value in Malayalam');
    expect(frame).toContain(HEADINGS_CLAUSE);
  });

  it('a stored value that is not ONE language (`ml-en` past the write lane) still states English', async () => {
    const { frame } = await flushOnce(withArtifact(INLINE_BODY()), { summaryLanguage: 'ml-en' }, 'ml-en');
    expect(frame).toContain('Write every section value in English');
  });
});

describe('the tenant`s policy fragment SELECTED — the tenant owns the language, the frame states none', () => {
  it('emits NO language step: four steps, numbered 1-4', async () => {
    const { steps, frame } = await flushOnce(withArtifact(compositeWithPolicy(ENGLISH_POLICY)), { summaryLanguage: 'ml-en' });

    expect(steps.map((line) => line.slice(0, 2))).toEqual(['1.', '2.', '3.', '4.']);
    expect(frame, 'a second, generated statement beside the tenant`s policy').not.toContain('Write every section value in');
  });

  it('the policy — with its headings clause — rides on the INSTRUCTION, beside the department body (S-4 pin)', async () => {
    const { systemPrompt } = await flushOnce(withArtifact(compositeWithPolicy(ENGLISH_POLICY)), { summaryLanguage: 'ml-en' });

    expect(systemPrompt).toContain('Write every section value in English');
    expect(systemPrompt).toContain(HEADINGS_CLAUSE);
    // ADDED to the clinical instruction, never instead of it; last, nearest the generation point.
    expect(systemPrompt).toContain(CLINICAL_BODY);
    expect(systemPrompt.indexOf(CLINICAL_BODY)).toBeLessThan(systemPrompt.indexOf('OUTPUT LANGUAGE POLICY'));
  });

  it('a tenant that wants Malayalam notes gets them — and the headings still stay English', async () => {
    const { systemPrompt, frame } = await flushOnce(withArtifact(compositeWithPolicy(MALAYALAM_POLICY)), { summaryLanguage: 'ml' });

    expect(systemPrompt).toContain('Write every section value in Malayalam');
    expect(systemPrompt).toContain(HEADINGS_CLAUSE);
    // One place states the rule: the tenant's row. The frame does not contradict it with English.
    expect(frame).not.toContain('Write every section value in');
  });

  it('the TENANT beats the platform: an English policy wins over a platform default of Malayalam', async () => {
    const { systemPrompt, frame } = await flushOnce(withArtifact(compositeWithPolicy(ENGLISH_POLICY)), {}, 'ml');

    expect(systemPrompt).toContain('Write every section value in English');
    expect(frame).not.toContain('Malayalam');
  });
});

describe('"selected" is decided PER CALL, by the fragment`s own `when`', () => {
  const WHEN_CODE_SWITCHED = "trigger.context.language == 'ml-en'";

  it('condition TRUE ⇒ selected ⇒ the policy states the language and the frame does not', async () => {
    const { systemPrompt, frame } = await flushOnce(withArtifact(compositeWithPolicy(MALAYALAM_POLICY, WHEN_CODE_SWITCHED)), {
      summaryLanguage: 'ml-en',
    });

    expect(systemPrompt).toContain('Write every section value in Malayalam');
    expect(frame).not.toContain('Write every section value in');
  });

  it('condition FALSE ⇒ excluded ⇒ nothing in the instruction states a language, so the frame states the platform default', async () => {
    const { systemPrompt, frame } = await flushOnce(withArtifact(compositeWithPolicy(MALAYALAM_POLICY, WHEN_CODE_SWITCHED)), {
      summaryLanguage: 'ml',
    });

    expect(systemPrompt).not.toContain('OUTPUT LANGUAGE POLICY');
    expect(frame).toContain('Write every section value in English');
    expect(frame).toContain(HEADINGS_CLAUSE);
  });

  it('a condition that cannot be evaluated is excluded, never "selected" — the default is stated', async () => {
    const { frame } = await flushOnce(withArtifact(compositeWithPolicy(ENGLISH_POLICY, 'trigger.context.no_such_field == 1')), {
      summaryLanguage: 'ml-en',
    });

    expect(frame).toContain('Write every section value in English');
  });

  it('a composite WITHOUT the reserved key is not a policy, whatever its text says', async () => {
    const otherKey = {
      source: 'composite',
      join: '\n\n',
      content: `${CLINICAL_BODY}\n\n${ENGLISH_POLICY}`,
      fragments: [
        { key: 'clinical_note', source: 'template' as const, content: CLINICAL_BODY, when: null },
        { key: 'house_style', source: 'template' as const, content: ENGLISH_POLICY, when: null },
      ],
    } as ResolvedPrompt;

    const { frame } = await flushOnce(withArtifact(otherKey), { summaryLanguage: 'ml-en' });
    expect(frame).toContain('Write every section value in English');
  });
});

describe('the PRE-SUMMARY variables on the native lane — `language_name` is OUTPUT, `language` is SOURCE', () => {
  /** A pre-summary-shaped body reading the pair through the run's trigger context. */
  const PRE_SUMMARY_BODY = (): ResolvedPrompt =>
    ({
      source: 'inline',
      content: 'PRE-SUMMARY. Write ALL bullet content in {{trigger.context.language_name}}. Spoken: [{{trigger.context.language}}].',
    }) as ResolvedPrompt;

  it.each([
    ['ml-en', 'Spoken: [ml-en]'],
    ['ml', 'Spoken: [ml]'],
  ])('a consultation declaring `%s` renders English output with the source tag intact', async (declared, spoken) => {
    const { systemPrompt } = await flushOnce(withArtifact(PRE_SUMMARY_BODY()), { summaryLanguage: declared });

    expect(systemPrompt).toContain('Write ALL bullet content in English.');
    expect(systemPrompt).toContain(spoken);
    expect(systemPrompt).not.toContain('in Malayalam');
  });

  it('a consultation declaring nothing renders English, with an empty source tag', async () => {
    const { systemPrompt } = await flushOnce(withArtifact(PRE_SUMMARY_BODY()), {});

    expect(systemPrompt).toContain('Write ALL bullet content in English.');
    expect(systemPrompt).toContain('Spoken: []');
  });

  it('follows the platform default, not the source tag', async () => {
    const { systemPrompt } = await flushOnce(withArtifact(PRE_SUMMARY_BODY()), { summaryLanguage: 'en' }, 'ml');
    expect(systemPrompt).toContain('Write ALL bullet content in Malayalam.');
  });
});

describe('the durable HANDOFF context spells the same pair', () => {
  function buildHandoffService(language: string | undefined, platformDefault?: unknown) {
    const stored = new Map<string, string>([
      [`live-doc:handoff:${CID}`, JSON.stringify({ endedAt: '2026-09-23T10:00:00.000Z', tenantId: TENANT, outputs: {} })],
    ]);
    const args: unknown[] = new Array(29).fill(undefined);
    args[0] = { axiosRef: { post: vi.fn() }, post: vi.fn() };
    args[1] = { get: vi.fn(() => undefined) };
    args[2] = { ...cacheMock(), get: vi.fn(async (key: string) => stored.get(key) ?? null) };
    args[3] = { subscribeToChannel: vi.fn(), unsubscribeFromChannel: vi.fn() };
    args[7] = { decrypt: vi.fn() };
    args[9] = settingsFacade(platformDefault);
    args[15] = {
      findById: vi.fn(async () => ({
        id: CID,
        tenantId: TENANT,
        doctorId: 'doctor-1001',
        departmentId: null,
        parentConsultationId: null,
        status: 'DRAINING',
        metadata: language === undefined ? null : { summaryLanguage: language },
      })),
    };
    return new (LiveDocumentationService as unknown as new (...a: unknown[]) => LiveDocumentationService)(...args);
  }

  it('`ml-en` declared ⇒ `language_name` English, `language` ml-en', async () => {
    const answer = await buildHandoffService('ml-en').readLiveHandoff(CID);
    expect(answer.context).toMatchObject({ language_name: 'English', language: 'ml-en' });
  });

  it('`ml` declared ⇒ still English — the source tag is not the output', async () => {
    const answer = await buildHandoffService('ml').readLiveHandoff(CID);
    expect(answer.context).toMatchObject({ language_name: 'English', language: 'ml' });
  });

  it('nothing declared ⇒ English, empty source tag', async () => {
    const answer = await buildHandoffService(undefined).readLiveHandoff(CID);
    expect(answer.context).toMatchObject({ language_name: 'English', language: '' });
  });

  it('follows the platform default', async () => {
    const answer = await buildHandoffService('en', 'ml').readLiveHandoff(CID);
    expect(answer.context).toMatchObject({ language_name: 'Malayalam', language: 'en' });
  });
});
