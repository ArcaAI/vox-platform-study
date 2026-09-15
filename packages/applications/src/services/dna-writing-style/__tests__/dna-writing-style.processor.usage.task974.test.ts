/**
 * TASK-974 §9.2 (design D-5) — the DNA analyst's LLM call reaches the usage ledger.
 *
 * Before this ticket `callText` typed TEXT's answer as `{ content, usage?, latency_ms? }` and
 * threw `usage_detail` / `guardrail_usage` away, so the one call on this plane that spends real
 * money — a full learning corpus in, a writing-style profile out — recorded NOTHING. Every other
 * TEXT caller (the proxy, the comprehensive-summary job, agent invocations) parses the block and
 * emits itself; nothing meters automatically, which is why this was silent rather than noisy.
 *
 * What is pinned here:
 *   · ONE `dna.analyze` batch carrying the token units off a real `usage_detail` fixture, the
 *     doctor, `requestId = task_id`, `sessionId = the DNA job id` and `attributesJson.origin`;
 *   · the guardrail COGS batch beside it, on its OWN operation and its OWN device;
 *   · the device resolved for a SELF-HOSTED provider and NOT for a cloud one;
 *   · the ledger call happening INSIDE the transaction that writes the report — usage that
 *     cannot be lost by a crash, and can never be recorded for a report that rolled back;
 *   · a metering failure rolling back and RE-PERSISTING the four rows unmetered: the model
 *     already ran, and losing a clinician's profile to protect a meter is the expensive
 *     direction to be wrong in.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentTask, AiUsageUnit, SYSTEM_TENANT_ID } from '@arcaai/domains';
import { DnaWritingStyleProcessor } from '../dna-writing-style.processor';
import { DNA_WRITING_STYLE_ANALYST_SLUG } from '../../agent/platform-hidden-agents';
import { TextRequestEnrichmentService } from '../../text-request/text-request-enrichment.service';
import type { UsageEventBatchInput } from '../../usageLedger/dto';

const TENANT = 'tenant-1';
const DOCTOR = 'doctor-1';
const JOB_ID = 'dna-job-1';
const TX = { __brand: 'tx' } as unknown as never;

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

/** What TEXT reports for the analyst's own call — a self-hosted engine, so a device applies. */
function usageDetail(overrides: Record<string, unknown> = {}) {
  return {
    task_id: 'text-task-1',
    provider: 'lm-studio',
    model: 'gemma-4-e2b-it-qat',
    endpoint_kind: 'lmstudio.chat',
    interrupted: false,
    byok: false,
    occurred_at: '2026-09-15T10:00:00.000Z',
    prompt_tokens: 12_000,
    completion_tokens: 400,
    total_ms: 42_000,
    raw: { prompt_tokens: 12_000, completion_tokens: 400 },
    ...overrides,
  };
}

/** The guard TEXT forwarded — its OWN engine, which is why it resolves its own device. */
const GUARDRAIL_USAGE = {
  task_id: 'text-guard-1',
  provider: 'ollama',
  model: 'granite-guardian',
  endpoint_kind: 'openai.chat',
  interrupted: false,
  byok: false,
  occurred_at: '2026-09-15T09:59:58.000Z',
  prompt_tokens: 900,
  completion_tokens: 6,
  total_ms: 800,
  raw: { prompt_tokens: 900, completion_tokens: 6 },
};

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
  usageDetail?: Record<string, unknown> | null;
  guardrailUsage?: Record<string, unknown> | null;
  device?: string;
  /** Wire no ledger / no unit-of-work — the legacy composition, which must stay byte-identical. */
  unmetered?: boolean;
  /** Make `recordUsage` throw, to exercise the roll-back-and-re-persist path. */
  ledgerThrows?: boolean;
  templates?: Array<Record<string, unknown>>;
  templateEntity?: Record<string, unknown> | null;
}

function build(options: BuildOptions = {}) {
  const {
    usageDetail: detail = usageDetail(),
    guardrailUsage = GUARDRAIL_USAGE,
    device = 'cuda',
    unmetered = false,
    ledgerThrows = false,
    templates = [],
    templateEntity = null,
  } = options;

  const httpService = {
    axiosRef: {
      post: vi.fn().mockResolvedValue({
        data: {
          task_id: 'text-task-1',
          status: 'completed',
          content: JSON.stringify(DNA_PROFILE),
          ...(detail ? { usage_detail: detail } : {}),
          ...(guardrailUsage ? { guardrail_usage: guardrailUsage } : {}),
        },
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
    compiledConfig: {
      resolvedPrompt: { source: 'inline', content: 'PLATFORM DNA INSTRUCTION' },
      parameters: { generation: {} },
      outputSchema: DNA_SCHEMA,
    },
    models: [],
  };

  const dnaReportRepository = {
    findLatestForDoctor: vi.fn().mockResolvedValue(null),
    create: vi.fn().mockResolvedValue({ id: 'report-1' }),
    update: vi.fn(),
    encryptFieldsIntoEntity: vi.fn().mockResolvedValue(undefined),
  };
  const dnaVersionRepository = {
    create: vi.fn().mockResolvedValue({ id: 'version-1' }),
    encryptFieldsIntoEntity: vi.fn().mockResolvedValue(undefined),
  };
  const dnaUsageRecordRepository = { create: vi.fn().mockResolvedValue({ id: 'usage-1' }) };
  const promptUsageRecordRepository = { create: vi.fn().mockResolvedValue({ id: 'prompt-usage-1' }) };

  const recordUsage = ledgerThrows
    ? vi.fn().mockRejectedValue(new Error('outbox unavailable'))
    : vi.fn().mockResolvedValue({ outboxIds: ['o1'], events: 3 });
  const usageLedgerService = { recordUsage };
  const computeDevice = { resolve: vi.fn().mockResolvedValue(device) };
  const unitOfWorkService = {
    runInTransaction: vi.fn(async (work: (tx: unknown) => Promise<unknown>) => work(TX)),
  };

  const processor = new DnaWritingStyleProcessor(
    { notifyProgress: vi.fn(), notifyComplete: vi.fn(), notifyFailed: vi.fn() } as never,
    { getValueWithDefault: vi.fn(<T>(_key: string, fallback: T): T => fallback) } as never,
    { findAll: vi.fn() } as never,
    { getVersionsByChangeReason: vi.fn().mockResolvedValue([]) } as never,
    dnaReportRepository as never,
    dnaVersionRepository as never,
    dnaUsageRecordRepository as never,
    promptUsageRecordRepository as never,
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
    makeCls() as never,
    undefined, // secretsService
    { resolveTextSelection: vi.fn().mockResolvedValue({ provider: 'tenant-provider', model: 'tenant-model' }) } as never,
    undefined, // configResolver
    { findById: vi.fn().mockResolvedValue(templateEntity) } as never,
    { redact: vi.fn(async (text: string) => text) } as never,
    new TextRequestEnrichmentService({ get: vi.fn().mockReturnValue(TENANT) } as never, undefined, undefined) as never,
    {
      findPlatformHiddenBySlug: vi
        .fn()
        .mockResolvedValue({ id: 'sys-agent-1', tenantId: SYSTEM_TENANT_ID, slug: DNA_WRITING_STYLE_ANALYST_SLUG, outputSchema: DNA_SCHEMA }),
    } as never,
    { resolve: vi.fn().mockResolvedValue(resolvedAgent) } as never,
    {
      resolveFromAgent: vi.fn().mockResolvedValue({
        agent: resolvedAgent,
        primary: {
          kind: 'primary',
          agent: { slug: DNA_WRITING_STYLE_ANALYST_SLUG, versionId: 'sys-agent-1', versionNumber: 4, tenantId: SYSTEM_TENANT_ID, source: 'explicit' },
          modelSlug: 'lms-gemma-4-e2b-it-qat',
          provider: 'lm-studio',
          model: 'gemma-4-e2b-it-qat',
          resolvedPrompt: { source: 'inline', content: 'PLATFORM DNA INSTRUCTION' },
          instruction: null,
          parameters: { generation: {} },
          tools: [],
          fundingTier: 'CLOUD',
          contextSchema: null,
        },
        fallback: { autoSwitch: true, chain: [] },
      }),
    } as never,
    { baseClient: { __base: true } } as never,
    // ─── TASK-974 §9.2 — the metering seam, `@Optional()` and TRAILING ──────────────
    unmetered ? undefined : (usageLedgerService as never),
    unmetered ? undefined : (computeDevice as never),
    unmetered ? undefined : (unitOfWorkService as never),
  );

  return {
    processor,
    recordUsage,
    computeDevice,
    unitOfWorkService,
    dnaReportRepository,
    dnaVersionRepository,
    dnaUsageRecordRepository,
    promptUsageRecordRepository,
  };
}

const job = (data: Record<string, unknown> = {}) =>
  ({
    id: JOB_ID,
    timestamp: Date.now(),
    progress: 0,
    updateProgress: vi.fn(),
    data: { jobId: JOB_ID, doctorId: DOCTOR, tenantId: TENANT, userId: 'user-1', textSamples: ['Chest pain, resolved.'], origin: 'ingest', ...data },
  }) as never;

/** Every batch handed to the ledger, in call order. */
const batches = (recordUsage: ReturnType<typeof vi.fn>): UsageEventBatchInput[] =>
  recordUsage.mock.calls.map((call) => call[0] as UsageEventBatchInput);

const byOperation = (recordUsage: ReturnType<typeof vi.fn>, operation: string): UsageEventBatchInput | undefined =>
  batches(recordUsage).find((batch) => batch.common.operation === operation);

const quantityOf = (batch: UsageEventBatchInput, unit: AiUsageUnit) => batch.units.find((u) => u.unit === unit)?.quantity;

beforeEach(() => vi.clearAllMocks());

describe('the analyst`s own call is metered as `dna.analyze`', () => {
  it('records ONE dna.analyze batch carrying the tokens TEXT reported', async () => {
    const { processor, recordUsage } = build();

    await processor.process(job());

    const analyze = byOperation(recordUsage, 'dna.analyze');
    expect(analyze).toBeDefined();
    expect(analyze!.common.capability).toBe('LLM');
    expect(analyze!.common.provider).toBe('lm-studio');
    expect(analyze!.common.model).toBe('gemma-4-e2b-it-qat');
    expect(quantityOf(analyze!, AiUsageUnit.INPUT_TOKEN)).toBe(12_000);
    expect(quantityOf(analyze!, AiUsageUnit.OUTPUT_TOKEN)).toBe(400);
  });

  it('attributes the row to the clinician, the TEXT task and the DNA job', async () => {
    const { processor, recordUsage } = build();

    await processor.process(job());

    const analyze = byOperation(recordUsage, 'dna.analyze')!;
    expect(analyze.common.doctorId).toBe(DOCTOR);
    // The TEXT task id, which is what makes a redelivered emission converge on one row.
    expect(analyze.common.requestId).toBe('text-task-1');
    expect(analyze.common.idempotencyKey).toBe('llm:text-task-1');
    // The DNA job, so every row this job produced can be read back together.
    expect(analyze.common.sessionId).toBe(JOB_ID);
    // No consultation and no department: a writing-style profile is cross-patient by construction.
    expect(analyze.common.consultationId ?? null).toBeNull();
    expect(analyze.common.departmentId ?? null).toBeNull();
  });

  it('stamps WHICH SURFACE asked, from the job payload', async () => {
    const { processor, recordUsage } = build();

    await processor.process(job({ origin: 'scheduler' }));

    expect(byOperation(recordUsage, 'dna.analyze')!.common.attributesJson).toMatchObject({ origin: 'scheduler' });
  });

  it('resolves the device for a SELF-HOSTED engine so the occupancy row is a GPU second', async () => {
    const { processor, recordUsage, computeDevice } = build({ device: 'cuda' });

    await processor.process(job());

    expect(computeDevice.resolve).toHaveBeenCalledWith(TENANT, 'lm-studio');
    const analyze = byOperation(recordUsage, 'dna.analyze')!;
    expect(quantityOf(analyze, AiUsageUnit.GPU_SECOND)).toBe('42.000');
  });

  it('never asks for a device on a CLOUD call — those seconds are HOPE`s own CPU', async () => {
    const { processor, computeDevice } = build({
      usageDetail: usageDetail({ provider: 'openai', model: 'gpt-4o', endpoint_kind: 'openai.chat' }),
      guardrailUsage: null,
    });

    await processor.process(job());

    expect(computeDevice.resolve).not.toHaveBeenCalled();
  });
});

describe('the guardrail call TEXT forwarded is its own COGS row', () => {
  it('records a guardrail.validate batch beside the analysis, on its own key and device', async () => {
    const { processor, recordUsage, computeDevice } = build();

    await processor.process(job());

    const guard = byOperation(recordUsage, 'guardrail.validate');
    expect(guard).toBeDefined();
    expect(guard!.common.provider).toBe('ollama');
    expect(guard!.common.idempotencyKey).toBe('guardrail:text-guard-1');
    expect(guard!.common.doctorId).toBe(DOCTOR);
    expect(guard!.common.sessionId).toBe(JOB_ID);
    // A tenant may screen on one engine and generate on another.
    expect(computeDevice.resolve).toHaveBeenCalledWith(TENANT, 'ollama');
  });
});

describe('the ledger write shares the report`s transaction', () => {
  it('runs every create AND every recordUsage inside ONE runInTransaction', async () => {
    const { processor, recordUsage, unitOfWorkService, dnaReportRepository, dnaVersionRepository, dnaUsageRecordRepository } = build();

    await processor.process(job());

    expect(unitOfWorkService.runInTransaction).toHaveBeenCalledTimes(1);
    // Usage that cannot be lost by a crash between "work done" and "usage recorded",
    // and can never be recorded for a report that rolled back.
    expect(dnaReportRepository.create).toHaveBeenCalledWith(expect.anything(), TX);
    expect(dnaVersionRepository.create).toHaveBeenCalledWith(expect.anything(), TX);
    expect(dnaUsageRecordRepository.create).toHaveBeenCalledWith(expect.anything(), TX);
    for (const call of recordUsage.mock.calls) expect(call[1]).toBe(TX);
  });

  it('writes the PromptUsageRecord in the same transaction when a tenant template served', async () => {
    const { processor, promptUsageRecordRepository } = build({
      templates: [{ id: 'tpl-1', content: 'TENANT DNA INSTRUCTION', currentVersionNumber: 3 }],
      templateEntity: { id: 'tpl-1', metaData: { promptConfig: { outputSchema: DNA_SCHEMA } } },
    });

    await processor.process(job());

    expect(promptUsageRecordRepository.create).toHaveBeenCalledWith(expect.anything(), TX);
  });

  it('rolls back and RE-PERSISTS the four rows unmetered when the ledger fails', async () => {
    const { processor, dnaReportRepository, dnaVersionRepository, dnaUsageRecordRepository } = build({ ledgerThrows: true });

    // The job still COMPLETES: the model already ran, and a failed job over a delivered
    // profile is strictly worse than a missing meter.
    await expect(processor.process(job())).resolves.toMatchObject({ reportId: 'report-1' });

    // Twice: once inside the rolled-back transaction, once on its own afterwards.
    expect(dnaReportRepository.create).toHaveBeenCalledTimes(2);
    expect(dnaReportRepository.create).toHaveBeenLastCalledWith(expect.anything(), undefined);
    expect(dnaVersionRepository.create).toHaveBeenLastCalledWith(expect.anything(), undefined);
    expect(dnaUsageRecordRepository.create).toHaveBeenLastCalledWith(expect.anything(), undefined);
  });
});

describe('metering is additive — an unwired ledger changes nothing', () => {
  it('writes the four rows with no transaction at all when no ledger is composed', async () => {
    const { processor, dnaReportRepository, dnaVersionRepository, dnaUsageRecordRepository } = build({ unmetered: true });

    await expect(processor.process(job())).resolves.toMatchObject({ reportId: 'report-1' });

    expect(dnaReportRepository.create).toHaveBeenCalledTimes(1);
    expect(dnaReportRepository.create).toHaveBeenCalledWith(expect.anything(), undefined);
    expect(dnaVersionRepository.create).toHaveBeenCalledWith(expect.anything(), undefined);
    expect(dnaUsageRecordRepository.create).toHaveBeenCalledWith(expect.anything(), undefined);
  });

  it('opens no transaction when TEXT reported no usage block at all', async () => {
    // An older TEXT, or a response that carried none: recording nothing beats guessing.
    const { processor, recordUsage, unitOfWorkService } = build({ usageDetail: null, guardrailUsage: null });

    await processor.process(job());

    expect(recordUsage).not.toHaveBeenCalled();
    expect(unitOfWorkService.runInTransaction).not.toHaveBeenCalled();
  });
});
