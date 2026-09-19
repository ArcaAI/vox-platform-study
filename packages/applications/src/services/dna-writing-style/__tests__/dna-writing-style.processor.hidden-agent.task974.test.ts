/**
 * TASK-974 §5.1 item 6 — the DNA job runs on the PLATFORM's own agent.
 *
 * Before this ticket the job borrowed the tenant's FINALIZE agent
 * (`HarnessPolicyService.resolveTextSelection()`), which meant the model that extracts a
 * clinician's writing style was whatever that tenant happened to assign for note synthesis — and
 * a tenant with nothing assigned could not run DNA at all. D-1 makes the analyst a platform
 * service agent: ONE SYSTEM row, read explicitly, with the platform admin owning its model,
 * fallback chain and hyper-parameters, and the tenant owning only the INSTRUCTION.
 *
 * What is pinned here:
 *   · the SYSTEM agent's provider / model / temperature / max_tokens / top_p / reasoning reach
 *     the wire — selecting a posture and dropping it is TASK-891 C2's defect, and it is the
 *     reason this job had been running on the engine's own defaults;
 *   · the credential and funding are resolved for the JOB tenant, not for SYSTEM (BYO wins);
 *   · an absent SYSTEM row FAILS CLOSED with a named reason, never a substituted model;
 *   · the instruction and schema cascades, each in every branch;
 *   · `reportData.generator`, so a report can say which agent version wrote it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentTask, SYSTEM_TENANT_ID } from '@arcaai/domains';
import { DnaWritingStyleProcessor } from '../dna-writing-style.processor';
import { DNA_WRITING_STYLE_ANALYST_SLUG } from '../../agent/platform-hidden-agents';
import { TextRequestEnrichmentService } from '../../text-request/text-request-enrichment.service';

const TENANT = 'tenant-1';

vi.mock('@arcaai/domains', async () => {
  const actual = await vi.importActual('@arcaai/domains');
  const stamp = (data: Record<string, unknown>, id: string) => ({ ...data, id, createdAt: new Date(), updatedAt: new Date() });
  return {
    ...actual,
    DnaWritingStyleReportFactory: {
      CreateDnaWritingStyleReport: vi.fn((d: Record<string, unknown>) => ({ ...stamp(d, 'report-1'), isLatest: true, currentVersionNumber: 1 })),
    },
    DnaWritingStyleVersionFactory: { CreateDnaWritingStyleVersion: vi.fn((d: Record<string, unknown>) => stamp(d, 'version-1')) },
    DnaUsageRecordFactory: { CreateDnaUsageRecord: vi.fn((d: Record<string, unknown>) => stamp(d, 'usage-1')) },
    PromptUsageRecordFactory: { CreatePromptUsageRecord: vi.fn((d: Record<string, unknown>) => stamp(d, 'prompt-usage-1')) },
  };
});

/** The DNA profile the fake TEXT service answers with — schema-conforming, so the job completes. */
const DNA_PROFILE = {
  sentenceStructure: 'active',
  verbosity: 'terse',
  listVsNarrative: 'list',
  sectionOrderPreference: 'Subjective, Objective',
  abbreviationFrequency: 'high',
  toneFormality: 'neutral',
  confidenceScores: { verbosity: 0.9 },
};

const DNA_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'sentenceStructure',
    'verbosity',
    'listVsNarrative',
    'sectionOrderPreference',
    'abbreviationFrequency',
    'toneFormality',
    'confidenceScores',
  ],
  properties: {
    sentenceStructure: { type: 'string', enum: ['active', 'passive', 'mixed'] },
    verbosity: { type: 'string', enum: ['terse', 'moderate', 'verbose'] },
    listVsNarrative: { type: 'string', enum: ['list', 'narrative', 'mixed'] },
    sectionOrderPreference: { type: 'string', maxLength: 200 },
    abbreviationFrequency: { type: 'string', enum: ['low', 'medium', 'high'] },
    toneFormality: { type: 'string', enum: ['casual', 'neutral', 'formal'] },
    confidenceScores: { type: 'object' },
  },
};

/** A CLS double that MODELS `run({ ifNested: 'inherit' }, work)` — `runInTenantContext` needs both arities. */
function makeCls() {
  const store: Record<string, unknown> = {};
  return {
    store,
    get: vi.fn((key: string) => store[key]),
    set: vi.fn((key: string, value: unknown) => {
      store[key] = value;
    }),
    run: vi.fn((optionsOrWork: unknown, maybeWork?: unknown) => {
      const work = (typeof optionsOrWork === 'function' ? optionsOrWork : maybeWork) as () => unknown;
      const snapshot = { ...store };
      const restore = () => {
        for (const key of Object.keys(store)) delete store[key];
        Object.assign(store, snapshot);
      };
      const result = work();
      return result instanceof Promise ? result.finally(restore) : (restore(), result);
    }),
  };
}

interface BuildOptions {
  /** The SYSTEM row `findPlatformHiddenBySlug` answers with; `null` ⇒ the platform agent is missing. */
  systemRow?: Record<string, unknown> | null;
  /** `parameters.generation` of the resolved SYSTEM agent. */
  generation?: Record<string, unknown>;
  /** `compiledConfig.resolvedPrompt` of the resolved SYSTEM agent. */
  resolvedPrompt?: { source: string; content: string } | null;
  /** What the tenant's DNA_ANALYSIS template lookup answers (`[]` ⇒ the tenant has no override). */
  templates?: Array<Record<string, unknown>>;
  /** The tenant template ENTITY, whose `metaData.promptConfig.outputSchema` is the tenant schema. */
  templateEntity?: Record<string, unknown> | null;
  /** The one-hop credential the JOB tenant's resolution produced. */
  providerOverride?: Record<string, unknown>;
  maxContextChars?: number;
}

function build(options: BuildOptions = {}) {
  const {
    systemRow = { id: 'sys-agent-1', tenantId: SYSTEM_TENANT_ID, slug: DNA_WRITING_STYLE_ANALYST_SLUG, outputSchema: DNA_SCHEMA },
    generation = { temperature: 0, maxTokens: 2048, topP: 0.95, reasoning: { enabled: false } },
    resolvedPrompt = { source: 'inline', content: 'PLATFORM DNA INSTRUCTION' },
    templates = [],
    templateEntity = null,
    providerOverride,
    maxContextChars = 100_000,
  } = options;

  const httpService = {
    axiosRef: {
      post: vi.fn().mockResolvedValue({
        data: { task_id: 't', status: 'completed', content: JSON.stringify(DNA_PROFILE), provider: 'lm-studio', model: 'gemma' },
      }),
    },
  };

  const resolvedAgent = {
    agentId: 'sys-agent-1',
    agentVersionId: 'sys-agent-1',
    slug: DNA_WRITING_STYLE_ANALYST_SLUG,
    versionNumber: 4,
    task: AgentTask.TEXT_GENERATION,
    tenantId: SYSTEM_TENANT_ID,
    source: 'explicit',
    compiledConfig: { resolvedPrompt, parameters: { generation }, outputSchema: DNA_SCHEMA },
    models: [],
  };

  const agentResolver = { resolve: vi.fn().mockResolvedValue(resolvedAgent) };
  const textAgents = {
    resolveFromAgent: vi.fn().mockResolvedValue({
      agent: resolvedAgent,
      primary: {
        kind: 'primary',
        agent: { slug: DNA_WRITING_STYLE_ANALYST_SLUG, versionId: 'sys-agent-1', versionNumber: 4, tenantId: SYSTEM_TENANT_ID, source: 'explicit' },
        modelSlug: 'lms-gemma-4-e2b-it-qat',
        provider: 'lm-studio',
        model: 'gemma-4-e2b-it-qat',
        resolvedPrompt,
        instruction: null,
        parameters: { generation },
        tools: [],
        fundingTier: 'CLOUD',
        ...(providerOverride ? { providerOverride } : {}),
        contextSchema: null,
      },
      fallback: { autoSwitch: true, chain: [] },
    }),
  };
  const agentRepository = { findPlatformHiddenBySlug: vi.fn().mockResolvedValue(systemRow) };
  const databaseService = { baseClient: { __base: true } };
  const cls = makeCls();
  const notifyFailed = vi.fn();

  const processor = new DnaWritingStyleProcessor(
    { notifyProgress: vi.fn(), notifyComplete: vi.fn(), notifyFailed } as never,
    {
      getValueWithDefault: vi.fn(<T>(key: string, fallback: T): T => (key === 'dna-regen.max-context-chars' ? (maxContextChars as T) : fallback)),
    } as never,
    { findFinalSummariesByDoctor: vi.fn() } as never,
    { getVersionsByChangeReason: vi.fn().mockResolvedValue([]) } as never,
    { findLatestForDoctor: vi.fn().mockResolvedValue(null), create: vi.fn().mockResolvedValue({ id: 'report-1' }), update: vi.fn() } as never,
    { create: vi.fn().mockResolvedValue({ id: 'version-1' }) } as never,
    { create: vi.fn().mockResolvedValue({ id: 'usage-1' }) } as never,
    { create: vi.fn().mockResolvedValue({ id: 'prompt-usage-1' }) } as never,
    { listPromptTemplates: vi.fn().mockResolvedValue(templates) } as never,
    httpService as never,
    { get: vi.fn().mockReturnValue('http://text.test') } as never,
    {
      recordJobStart: vi.fn().mockReturnValue(vi.fn().mockReturnValue(5)),
      recordJobComplete: vi.fn(),
      recordJobFailed: vi.fn(),
      recordWaitingDuration: vi.fn(),
      recordTextCallDuration: vi.fn(),
    } as never,
    cls as never,
    undefined, // secretsService
    // The finalize-agent seam stays wired and must NOT be consulted once the platform agent is.
    { resolveTextSelection: vi.fn().mockResolvedValue({ provider: 'tenant-provider', model: 'tenant-model' }) } as never,
    undefined, // configResolver
    { findById: vi.fn().mockResolvedValue(templateEntity) } as never,
    { redact: vi.fn(async (text: string) => text) } as never,
    new TextRequestEnrichmentService({ get: vi.fn().mockReturnValue(TENANT) } as never, undefined, undefined) as never,
    agentRepository as never,
    agentResolver as never,
    textAgents as never,
    databaseService as never,
  );

  return { processor, httpService, agentRepository, agentResolver, textAgents, notifyFailed, cls };
}

const job = (data: Record<string, unknown> = {}) =>
  ({
    id: 'job-1',
    timestamp: Date.now(),
    progress: 0,
    updateProgress: vi.fn(),
    data: { jobId: 'job-1', doctorId: 'doctor-1', tenantId: TENANT, userId: 'user-1', textSamples: ['Chest pain, resolved.'], ...data },
  }) as never;

const body = (httpService: { axiosRef: { post: ReturnType<typeof vi.fn> } }) =>
  httpService.axiosRef.post.mock.calls.at(-1)![1] as Record<string, unknown>;

beforeEach(() => vi.clearAllMocks());

describe('the platform agent is resolved, and its selection reaches the wire', () => {
  it('reads the SYSTEM row through the allow-listed unscoped read, resolves it under SYSTEM, and funds it for the JOB tenant', async () => {
    const { processor, agentRepository, agentResolver, textAgents } = build();

    await processor.process(job());

    expect(agentRepository.findPlatformHiddenBySlug).toHaveBeenCalledWith(expect.anything(), DNA_WRITING_STYLE_ANALYST_SLUG);
    expect(agentResolver.resolve).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: SYSTEM_TENANT_ID, agentSlug: DNA_WRITING_STYLE_ANALYST_SLUG, allowPlatformHidden: true }),
    );
    // The credential and the funding tier are the JOB tenant's — BYO wins, platform is the fallback.
    expect(textAgents.resolveFromAgent).toHaveBeenCalledWith(expect.anything(), TENANT);
  });

  it('puts the agent`s provider, model and every hyper-parameter it authored on the wire', async () => {
    const { processor, httpService } = build();

    await processor.process(job());

    expect(body(httpService)).toMatchObject({
      provider: 'lm-studio',
      model: 'gemma-4-e2b-it-qat',
      temperature: 0,
      max_tokens: 2048,
      top_p: 0.95,
      // TASK-968's posture, carried through the shared enrichment.
      reasoning: { enabled: false },
    });
  });

  it('does NOT consult the tenant`s finalize agent any more', async () => {
    const { processor, httpService } = build();

    await processor.process(job());

    expect(body(httpService).provider).not.toBe('tenant-provider');
  });

  it('forwards the credential the resolution produced, so the call is metered against the tier that served', async () => {
    const { processor, httpService } = build({ providerOverride: { provider: 'lm-studio', api_key: 'k', funding: 'CLOUD' } });

    await processor.process(job());

    expect(body(httpService).provider_overrides).toEqual({ 'lm-studio': { api_key: 'k', funding: 'CLOUD' } });
  });

  it('records the generator on the report so a profile can say which agent version wrote it', async () => {
    const { processor } = build();

    const result = await processor.process(job());

    expect(result.reportData.generator).toEqual({
      agentSlug: DNA_WRITING_STYLE_ANALYST_SLUG,
      agentVersionId: 'sys-agent-1',
      provider: 'lm-studio',
      model: 'gemma-4-e2b-it-qat',
    });
  });

  it('FAILS CLOSED when SYSTEM carries no live analyst — never a substituted model', async () => {
    const { processor, httpService, notifyFailed } = build({ systemRow: null });

    await expect(processor.process(job())).rejects.toThrow(/DNA_ANALYST_AGENT_UNAVAILABLE/);

    expect(httpService.axiosRef.post).not.toHaveBeenCalled();
    expect(notifyFailed).toHaveBeenCalledWith('job-1', expect.stringContaining('DNA_ANALYST_AGENT_UNAVAILABLE'));
  });
});

describe('instruction cascade — tenant template wins, the platform agent is the fallback', () => {
  it('uses the tenant`s DNA_ANALYSIS template when it has one', async () => {
    const { processor, httpService } = build({
      templates: [{ id: 'tpl-1', content: 'TENANT DNA INSTRUCTION', category: 'DNA_ANALYSIS', currentVersionNumber: 2 }],
      templateEntity: { id: 'tpl-1', metaData: { promptConfig: { outputSchema: DNA_SCHEMA } } },
    });

    await processor.process(job());

    expect(body(httpService).system_prompt).toBe('TENANT DNA INSTRUCTION');
  });

  it('falls back to the platform agent`s own prompt when the tenant authored none', async () => {
    const { processor, httpService } = build({ templates: [] });

    await processor.process(job());

    expect(body(httpService).system_prompt).toBe('PLATFORM DNA INSTRUCTION');
  });

  it('fails closed when neither tier supplies an instruction — a DNA job must never run on an improvised prompt', async () => {
    const { processor, notifyFailed } = build({ templates: [], resolvedPrompt: null });

    await expect(processor.process(job())).rejects.toThrow(/instruction/i);
    expect(notifyFailed).toHaveBeenCalled();
  });
});

describe('schema cascade — the closed vocabulary is what contains PHI, so an absent one fails the job', () => {
  it('uses the tenant template`s promptConfig schema when the template served', async () => {
    const tenantSchema = { ...DNA_SCHEMA, title: 'TenantProfile' };
    const { processor, httpService } = build({
      templates: [{ id: 'tpl-1', content: 'TENANT DNA INSTRUCTION', category: 'DNA_ANALYSIS' }],
      templateEntity: { id: 'tpl-1', metaData: { promptConfig: { outputSchema: tenantSchema } } },
    });

    await processor.process(job());

    expect((body(httpService).response_format as { json_schema: unknown }).json_schema).toEqual(tenantSchema);
  });

  it('falls back to the platform agent`s authored schema', async () => {
    const { processor, httpService } = build();

    await processor.process(job());

    expect((body(httpService).response_format as { json_schema: unknown }).json_schema).toEqual(DNA_SCHEMA);
  });

  it('fails closed when neither tier declares one', async () => {
    const { processor, httpService, notifyFailed } = build({
      systemRow: { id: 'sys-agent-1', tenantId: SYSTEM_TENANT_ID, slug: DNA_WRITING_STYLE_ANALYST_SLUG, outputSchema: null },
    });

    await expect(processor.process(job())).rejects.toThrow(/schema/i);
    expect(httpService.axiosRef.post).not.toHaveBeenCalled();
    expect(notifyFailed).toHaveBeenCalled();
  });
});

describe('the `samples` time series (§4.3)', () => {
  const samples = [
    { text: 'THIRD', writtenAt: '2026-03-03T09:00:00.000Z', kind: 'CASE_NOTE' },
    { text: 'FIRST', writtenAt: '2026-03-01T09:00:00.000Z', kind: 'WORK_NOTE' },
    { text: 'SECOND', writtenAt: '2026-03-02T09:00:00.000Z', kind: 'CASE_NOTE' },
  ];

  it('renders CHRONOLOGICALLY whatever order the caller sent, with a dated, numbered header per item', async () => {
    const { processor, httpService } = build();

    await processor.process(job({ textSamples: undefined, samples }));

    expect(body(httpService).prompt).toBe(
      '[1/3] 2026-03-01 · WORK_NOTE\nFIRST\n\n---\n\n[2/3] 2026-03-02 · CASE_NOTE\nSECOND\n\n---\n\n[3/3] 2026-03-03 · CASE_NOTE\nTHIRD',
    );
  });

  it('drops the OLDEST whole items over the char budget — a style is learned from what the clinician writes NOW', async () => {
    const { processor, httpService } = build({ maxContextChars: 60 });

    await processor.process(job({ textSamples: undefined, samples }));

    const prompt = body(httpService).prompt as string;
    expect(prompt).toContain('THIRD');
    expect(prompt).not.toContain('FIRST');
    // Whole items, never a mid-item cut: a half-sentence teaches the model a style nobody writes.
    expect(prompt.length).toBeLessThanOrEqual(60);
  });

  it('explains itself on the report — counts and a window, never the text and never a sourceRef', async () => {
    const { processor } = build();

    const result = await processor.process(job({ textSamples: undefined, samples: samples.map((s) => ({ ...s, sourceRef: 'emr://secret' })) }));

    expect(result.reportData.ingest).toEqual({
      itemCount: 3,
      from: '2026-03-01T09:00:00.000Z',
      to: '2026-03-03T09:00:00.000Z',
      kinds: { CASE_NOTE: 2, WORK_NOTE: 1 },
    });
    expect(JSON.stringify(result.reportData)).not.toContain('emr://secret');
    expect(JSON.stringify(result.reportData)).not.toContain('FIRST');
  });

  it('PHI-redacts the rendered series exactly as every other corpus is redacted', async () => {
    const { processor, httpService } = build();
    // Prove the hop is on this branch too by asserting the redactor's output is what was posted.
    const redactor = { redact: vi.fn(async () => 'REDACTED CORPUS') };
    (processor as unknown as { phiRedactor: unknown }).phiRedactor = redactor;

    await processor.process(job({ textSamples: undefined, samples }));

    expect(redactor.redact).toHaveBeenCalledWith(expect.stringContaining('FIRST'), 'full');
    expect(body(httpService).prompt).toBe('REDACTED CORPUS');
  });
});

/**
 * L5/F4 — the PRIMARY binding policy.
 *
 * `primaryBinding` decides what happens when the agent's primary model NAMES a connection that
 * cannot serve (disabled, keyless, or an id this tenant cannot read). `'mark'` returns the agent
 * with NO `providerOverride`, and `applyTenantProviderOverrides` then folds by provider NAME —
 * spending the tenant's DEFAULT vendor account, which the binding did not name, and metering the
 * call there (the TASK-958 D-3 hazard verbatim).
 *
 * `'mark'` is the right answer for the CHAIN planes, because they resolve a credential per
 * candidate and walk on. This job does not: `callText` dispatches `spec.primary` and nothing else,
 * so there is no fallback for `'mark'` to protect. A chain walk here is a follow-up; until it
 * exists, an unusable binding must stop the job.
 */
describe('an unusable connection binding stops the job — it never quietly spends another account', () => {
  it('asks the resolver to FAIL CLOSED on the primary binding', async () => {
    const { processor, agentResolver } = build();

    await processor.process(job());

    expect(agentResolver.resolve).toHaveBeenCalledWith(expect.objectContaining({ primaryBinding: 'fail-closed' }));
  });

  it('fails the job with the resolver`s named reason instead of dispatching', async () => {
    const { processor, agentResolver, httpService, notifyFailed } = build();
    agentResolver.resolve.mockRejectedValue(
      Object.assign(new Error("Agent 'dna-writing-style-analyst' binds a connection that cannot serve"), { code: 'AGENT_CONNECTION_UNAVAILABLE' }),
    );

    await expect(processor.process(job())).rejects.toThrow(/cannot serve/);

    expect(httpService.axiosRef.post).not.toHaveBeenCalled();
    expect(notifyFailed).toHaveBeenCalledWith('job-1', expect.stringContaining('cannot serve'));
  });
});

/**
 * L5/F3 — the ingest renderer's half of the `writtenAt` contract.
 *
 * `renderIngestedSeries` SORTS by `Date.parse(writtenAt)` and reports the surviving window from
 * it. A `NaN` there sorts unpredictably and renders a window of `Invalid Date`, which is then
 * persisted on the report as the profile's provenance. The service refuses such a value at
 * enqueue; this is the second lock, for a payload that reached the queue another way (an older
 * build's job still in flight, a hand-enqueued replay).
 */
describe('the ingested time series must be orderable', () => {
  it('fails the job, naming the field, rather than rendering a corpus around an unreadable date', async () => {
    const { processor, httpService, notifyFailed } = build();

    await expect(
      processor.process(
        job({ textSamples: undefined, samples: [{ text: 'A note.', writtenAt: '2026-W01', kind: 'CASE_NOTE' }] }),
      ),
    ).rejects.toThrow(/writtenAt/);

    expect(httpService.axiosRef.post).not.toHaveBeenCalled();
    expect(notifyFailed).toHaveBeenCalledWith('job-1', expect.stringContaining('writtenAt'));
  });

  it('renders a well-formed series unchanged', async () => {
    const { processor, httpService } = build();

    const result = await processor.process(
      job({
        textSamples: undefined,
        samples: [
          { text: 'Later note.', writtenAt: '2026-09-02T09:00:00.000Z', kind: 'CASE_NOTE' },
          { text: 'Earlier note.', writtenAt: '2026-09-01T09:00:00.000Z', kind: 'WORK_NOTE' },
        ],
      }),
    );

    expect(body(httpService).prompt).toContain('Earlier note.');
    expect(result.reportData.ingest).toMatchObject({ itemCount: 2, from: '2026-09-01T09:00:00.000Z', to: '2026-09-02T09:00:00.000Z' });
  });
});
