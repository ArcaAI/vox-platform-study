/* TASK-1034 — the processor's merged corpus. Fixtures copied from dna-writing-style.processor.test.ts. */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DnaWritingStyleProcessor } from '../dna-writing-style.processor';

// ─── Mock Factories ─────────────────────────────────────────────────

const createMockJobService = () => ({
  notifyProgress: vi.fn(),
  notifyComplete: vi.fn(),
  notifyFailed: vi.fn(),
});

// The corpus read is a DEDICATED repository method, not a generic `findAll`
// with a filter object: `ContextItem` has no `doctorId` column, and the type +
// row-budget bounds only mean anything when the DATABASE applies them. The
// mock is named after the real method so a call site that drifts back to
// `findAll` fails loudly instead of silently querying nothing.
const createMockContextItemRepository = () => ({
  findFinalSummariesByDoctor: vi.fn(),
});

// Approval check via ContextItemVersion (changeReason='approved').
const createMockContextItemVersionRepository = () => ({
  getVersionsByChangeReason: vi.fn(),
});

const createMockDnaReportRepository = () => ({
  findLatestForDoctor: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
});

const createMockDnaVersionRepository = () => ({
  create: vi.fn(),
});

const createMockDnaUsageRecordRepository = () => ({
  create: vi.fn(),
});

const createMockPromptUsageRecordRepository = () => ({
  create: vi.fn(),
});

const createMockPromptManagementService = () => ({
  listPromptTemplates: vi.fn(),
});

const createMockHttpService = () => ({
  axiosRef: {
    post: vi.fn(),
  },
});

const createMockConfigService = () => ({
  get: vi.fn().mockReturnValue('http://localhost:8862'),
});

const createMockClsService = () => ({
  get: vi.fn(),
  set: vi.fn(),
  run: vi.fn(<T>(fn: () => T): T => fn()),
});

/**
 * (re-opened) — `IPhiRedactor` is now a REQUIRED dependency of this
 * processor (owner directive D-A): an absent redactor ABORTS the job instead of
 * silently posting the raw cross-patient corpus to TEXT. Every fixture below
 * therefore supplies a pass-through double, which keeps each pre-existing
 * assertion about the posted prompt byte-identical while exercising the new
 * mandatory call. The dedicated redaction specs supply their own doubles.
 */
const createPassThroughPhiRedactor = () => ({ redact: vi.fn(async (text: string) => text) });

const createMockJobMetrics = () => ({
  recordJobStart: vi.fn().mockReturnValue(vi.fn().mockReturnValue(5.0)),
  recordJobComplete: vi.fn(),
  recordJobFailed: vi.fn(),
  recordWaitingDuration: vi.fn(),
  recordTextCallDuration: vi.fn(),
});

const createMockAppSettingsService = (overrides: Record<string, unknown> = {}) => {
  const settings: Record<string, unknown> = {
    'dna-regen.max-samples': 50,
    'dna-regen.max-context-chars': 100000,
    ...overrides,
  };
  return {
    getValueWithDefault: vi.fn(<T>(key: string, defaultValue: T): T => {
      return key in settings ? (settings[key] as T) : defaultValue;
    }),
  };
};

// Mock domain factories
vi.mock('@arcaai/domains', async () => {
  const actual = await vi.importActual('@arcaai/domains');
  const DnaUsageRecordFactory = {
    CreateDnaUsageRecord: vi.fn((data: Record<string, unknown>) => ({
      ...data,
      id: 'new-usage-id',
      createdAt: new Date('2026-02-18T10:00:00Z'),
    })),
  };
  return {
    ...actual,
    DnaWritingStyleReportFactory: {
      CreateDnaWritingStyleReport: vi.fn((data: Record<string, unknown>) => ({
        ...data,
        id: 'new-report-id',
        isLatest: true,
        currentVersionNumber: 1,
        createdAt: new Date('2026-02-18T10:00:00Z'),
        updatedAt: new Date('2026-02-18T10:00:00Z'),
      })),
    },
    DnaWritingStyleVersionFactory: {
      CreateDnaWritingStyleVersion: vi.fn((data: Record<string, unknown>) => ({
        ...data,
        id: 'new-version-id',
        createdAt: new Date('2026-02-18T10:00:00Z'),
      })),
    },
    DnaUsageRecordFactory,
    PromptUsageRecordFactory: {
      CreatePromptUsageRecord: vi.fn((data: Record<string, unknown>) => ({
        ...data,
        id: 'new-prompt-usage-id',
        createdAt: new Date('2026-02-18T10:00:00Z'),
      })),
    },
  };
});

// ─── Job Helper ─────────────────────────────────────────────────────
// Complete mock matching BullMQ Job<GenerateDnaReportJobPayload>

const createMockJob = (overrides: Record<string, unknown> = {}) => ({
  data: {
    jobId: overrides.jobId ?? 'job-1',
    doctorId: overrides.doctorId ?? 'doctor-1',
    tenantId: overrides.tenantId ?? 'tenant-1',
    userId: overrides.userId ?? 'user-1',
    textSamples: overrides.textSamples ?? undefined,
    samples: overrides.samples ?? undefined,
    sampleIds: overrides.sampleIds ?? undefined,
    origin: overrides.origin ?? undefined,
  },
  id: overrides.jobId ?? 'job-1',
  progress: 0,
  timestamp: Date.now(),
  updateProgress: vi.fn().mockResolvedValue(undefined),
});

// ─── TEXT Response Helper ─────────────────────────────────────────
// Complete mock matching real TEXT GenerateResponse (stream: false)

const createTextResponse = (content: string) => ({
  task_id: 'task-text-1',
  status: 'completed' as const,
  content,
  provider: 'openai',
  model: 'gpt-4',
  usage: { prompt_tokens: 500, completion_tokens: 200, total_tokens: 700 },
  latency_ms: 3200,
  finish_reason: 'stop' as const,
  created_at: '2026-02-18T10:00:00Z',
});

// Axios returns { data: response }
const createAxiosTextResponse = (content: string) => ({
  data: createTextResponse(content),
});

// ─── TASK-1034 — one corpus: approved summaries ∪ DNA memory samples ───────────

const secrets = {
  encrypt: vi.fn(),
  decrypt: vi.fn(async (ct: string) => Buffer.from(ct.replace('ct:', ''), 'utf8')),
  getSecretOptional: vi.fn().mockResolvedValue(''),
  getSecret: vi.fn().mockResolvedValue(''),
};
const ct = (text: string) => Buffer.from(`ct:${text}`, 'utf8');

describe('DnaWritingStyleProcessor — merged memory corpus (TASK-1034)', () => {
  const sampleRepo = {
    findForCorpus: vi.fn(),
    markConsumed: vi.fn().mockResolvedValue(1),
    decryptText: vi.fn(async (_s: unknown, buf: Buffer) => buf.toString('utf8').replace('ct:', '')),
  };
  let contextItemRepo: ReturnType<typeof createMockContextItemRepository>;
  let versionRepo: ReturnType<typeof createMockContextItemVersionRepository>;
  let reportRepo: ReturnType<typeof createMockDnaReportRepository>;
  let http: ReturnType<typeof createMockHttpService>;
  let processor: DnaWritingStyleProcessor;

  beforeEach(() => {
    vi.clearAllMocks();
    contextItemRepo = createMockContextItemRepository();
    versionRepo = createMockContextItemVersionRepository();
    reportRepo = createMockDnaReportRepository();
    http = createMockHttpService();
    const prompts = createMockPromptManagementService();
    prompts.listPromptTemplates.mockResolvedValue([{ id: 'tpl-1', content: 'Analyze.', category: 'DNA_ANALYSIS' }]);
    http.axiosRef.post.mockResolvedValue(createAxiosTextResponse('{"reportData":{},"styleText":"Style"}'));
    reportRepo.findLatestForDoctor.mockResolvedValue(null);
    reportRepo.create.mockResolvedValue({ id: 'report-9' });
    Object.assign(reportRepo, { encryptFieldsIntoEntity: vi.fn() });
    versionRepo.getVersionsByChangeReason.mockImplementation(async (id: string, reason: string) =>
      reason === 'approved' ? [{ id: 'v', contextItemId: id }] : [],
    );
    contextItemRepo.findFinalSummariesByDoctor.mockResolvedValue([
      { id: 'ci-old', type: 'RAW_SUMMARY', content: 'APPROVED OLD', createdAt: new Date('2026-09-01T00:00:00Z'), updatedAt: new Date('2026-09-01T00:00:00Z') },
    ]);
    sampleRepo.findForCorpus.mockResolvedValue([
      { id: 's-new', source: 'EDIT', textCiphertext: ct('MEMORY NEW'), aiDraftCiphertext: null, writtenAt: new Date('2026-09-20T00:00:00Z') },
      { id: 's-mid', source: 'INGEST', textCiphertext: ct('MEMORY MID'), aiDraftCiphertext: null, writtenAt: new Date('2026-09-10T00:00:00Z') },
      // A SIGNOFF capture of the very note already in the summary corpus is not read twice.
      { id: 's-dup', source: 'SIGNOFF', textCiphertext: ct('APPROVED OLD'), aiDraftCiphertext: null, writtenAt: new Date('2026-09-02T00:00:00Z') },
    ]);

    processor = new DnaWritingStyleProcessor(
      createMockJobService() as never,
      createMockAppSettingsService() as never,
      contextItemRepo as never,
      versionRepo as never,
      reportRepo as never,
      { create: vi.fn().mockResolvedValue({}), encryptFieldsIntoEntity: vi.fn() } as never,
      { create: vi.fn().mockResolvedValue({}) } as never,
      { create: vi.fn().mockResolvedValue({}) } as never,
      prompts as never,
      http as never,
      createMockConfigService() as never,
      createMockJobMetrics() as never,
      createMockClsService() as never,
      secrets as never,
      { resolveTextSelection: vi.fn().mockResolvedValue({ provider: 'p', model: 'm' }) } as never,
      undefined,
      undefined,
      createPassThroughPhiRedactor() as never,
      undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      sampleRepo as never,
    );
  });

  const prompt = () => (http.axiosRef.post.mock.calls[0]![1] as { prompt: string }).prompt;

  it('merges approved summaries and memory samples, newest first, and marks the samples consumed', async () => {
    const result = await processor.process(createMockJob() as never);

    const p = prompt();
    expect(p.indexOf('MEMORY NEW')).toBeGreaterThanOrEqual(0);
    expect(p.indexOf('MEMORY NEW')).toBeLessThan(p.indexOf('MEMORY MID'));
    expect(p.indexOf('MEMORY MID')).toBeLessThan(p.indexOf('APPROVED OLD'));
    expect(p.split('APPROVED OLD').length - 1).toBe(1);
    expect(sampleRepo.findForCorpus).toHaveBeenCalledWith('tenant-1', 'doctor-1', 50);
    expect(sampleRepo.markConsumed).toHaveBeenCalledWith('tenant-1', expect.arrayContaining(['s-new', 's-mid', 's-dup']), result.reportId);
  });

  it('respects the max-samples cap across both sources', async () => {
    processor = Object.assign(processor, {});
    (processor as unknown as { appSettingsService: unknown }).appSettingsService = createMockAppSettingsService({ 'dna-regen.max-samples': 2 });
    await processor.process(createMockJob() as never);
    const p = prompt();
    expect(p).toContain('MEMORY NEW');
    expect(p).toContain('MEMORY MID');
    expect(p).not.toContain('APPROVED OLD');
  });

  it('memory alone is enough — a clinician with no approved summary still gets a profile', async () => {
    contextItemRepo.findFinalSummariesByDoctor.mockResolvedValue([]);
    const result = await processor.process(createMockJob() as never);
    expect(result.reportId).toBe('report-9');
    expect(prompt()).toContain('MEMORY NEW');
  });

  it('an ingest job marks the samples it carried consumed', async () => {
    await processor.process(
      createMockJob({ samples: [{ text: 'x', writtenAt: '2026-09-01T00:00:00.000Z', kind: 'OTHER' }], sampleIds: ['s-a'], origin: 'ingest' }) as never,
    );
    expect(sampleRepo.findForCorpus).not.toHaveBeenCalled();
    expect(sampleRepo.markConsumed).toHaveBeenCalledWith('tenant-1', ['s-a'], 'report-9');
  });
});
