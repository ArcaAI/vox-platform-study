/**
 * DnaWritingStyleProcessor Unit Tests
 *
 * Tests the BullMQ processor that calls TEXT to generate DNA reports.
 * Mocks at boundaries: HTTP service (TEXT), repositories, job service.
 * Verifies actual processor behavior: text gathering, TEXT call, storage, error handling.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DnaWritingStyleProcessor } from '../dna-writing-style.processor';

// ─── Mock Factories ─────────────────────────────────────────────────

const createMockJobService = () => ({
  notifyProgress: vi.fn(),
  notifyComplete: vi.fn(),
  notifyFailed: vi.fn(),
});

const createMockContextItemRepository = () => ({
  findAll: vi.fn(),
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

// ─── Tests ──────────────────────────────────────────────────────────

describe('DnaWritingStyleProcessor', () => {
  let processor: DnaWritingStyleProcessor;
  let mockJobService: ReturnType<typeof createMockJobService>;
  let mockAppSettings: ReturnType<typeof createMockAppSettingsService>;
  let mockContextItemRepo: ReturnType<typeof createMockContextItemRepository>;
  let mockDnaReportRepo: ReturnType<typeof createMockDnaReportRepository>;
  let mockDnaVersionRepo: ReturnType<typeof createMockDnaVersionRepository>;
  let mockDnaUsageRepo: ReturnType<typeof createMockDnaUsageRecordRepository>;
  let mockPromptUsageRepo: ReturnType<typeof createMockPromptUsageRecordRepository>;
  let mockPromptService: ReturnType<typeof createMockPromptManagementService>;
  let mockHttpService: ReturnType<typeof createMockHttpService>;
  let mockConfigService: ReturnType<typeof createMockConfigService>;
  let mockJobMetrics: ReturnType<typeof createMockJobMetrics>;
  let mockClsService: ReturnType<typeof createMockClsService>;
  let mockContextItemVersionRepo: ReturnType<typeof createMockContextItemVersionRepository>;
  let mockHarnessPolicyService: { resolveTextSelection: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.clearAllMocks();

    mockJobService = createMockJobService();
    mockAppSettings = createMockAppSettingsService();
    mockContextItemRepo = createMockContextItemRepository();
    mockDnaReportRepo = createMockDnaReportRepository();
    mockDnaVersionRepo = createMockDnaVersionRepository();
    mockDnaUsageRepo = createMockDnaUsageRecordRepository();
    mockPromptUsageRepo = createMockPromptUsageRecordRepository();
    mockPromptService = createMockPromptManagementService();
    mockHttpService = createMockHttpService();
    mockConfigService = createMockConfigService();
    mockJobMetrics = createMockJobMetrics();
    mockClsService = createMockClsService();
    // Default to "everything approved" so the legacy
    // tests below continue to exercise the success path.
    mockContextItemVersionRepo = createMockContextItemVersionRepository();
    mockContextItemVersionRepo.getVersionsByChangeReason.mockImplementation(async (contextItemId: string, changeReason: string) =>
      changeReason === 'approved' ? [{ id: 'v', contextItemId, changeReason: 'approved', versionNumber: 1 }] : [],
    );
    mockHarnessPolicyService = {
      resolveTextSelection: vi.fn().mockResolvedValue({ provider: 'lm-studio', model: 'resolved-medgemma' }),
    };

    processor = new DnaWritingStyleProcessor(
      mockJobService as never,
      mockAppSettings as never,
      mockContextItemRepo as never,
      mockContextItemVersionRepo as never,
      mockDnaReportRepo as never,
      mockDnaVersionRepo as never,
      mockDnaUsageRepo as never,
      mockPromptUsageRepo as never,
      mockPromptService as never,
      mockHttpService as never,
      mockConfigService as never,
      mockJobMetrics as never,
      mockClsService as never,
      undefined, // secretsService (@Optional)
      mockHarnessPolicyService as never, // HarnessPolicyService resolver
      undefined, // configResolver (@Optional)
      undefined, // promptTemplateRepository (@Optional)
      createPassThroughPhiRedactor() as never, // phiRedactor (REQUIRED)
    );
  });

  // ─── Successful Processing ──────────────────────────────────

  describe('Successful Processing', () => {
    it('should process DNA report with provided text samples and return result', async () => {
      mockPromptService.listPromptTemplates.mockResolvedValue([{ id: 'tpl-1', content: 'Analyze writing samples.', category: 'DNA_ANALYSIS' }]);
      mockHttpService.axiosRef.post.mockResolvedValue(
        createAxiosTextResponse(
          JSON.stringify({
            reportData: { formality: 'high', sentenceLength: 'medium' },
            styleText: 'Doctor writes in a formal, concise style.',
          }),
        ),
      );
      mockDnaReportRepo.findLatestForDoctor.mockResolvedValue(null);
      mockDnaReportRepo.create.mockResolvedValue({
        id: 'new-report-id',
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      mockDnaVersionRepo.create.mockResolvedValue({ id: 'new-version-id' });
      mockDnaUsageRepo.create.mockResolvedValue({ id: 'new-usage-id' });

      const result = await processor.process(createMockJob({ textSamples: ['Sample summary 1', 'Sample summary 2'] }) as never);

      expect(result.reportId).toBe('new-report-id');
      expect(result.styleText).toBe('Doctor writes in a formal, concise style.');
      expect(result.reportData).toEqual({ formality: 'high', sentenceLength: 'medium' });
    });

    it('should call TEXT POST /api/v1/generate with stream: false', async () => {
      mockPromptService.listPromptTemplates.mockResolvedValue([{ id: 'tpl-1', content: 'Analyze writing.', category: 'DNA_ANALYSIS' }]);
      mockHttpService.axiosRef.post.mockResolvedValue(createAxiosTextResponse('{"reportData":{},"styleText":"Style"}'));
      mockDnaReportRepo.findLatestForDoctor.mockResolvedValue(null);
      mockDnaReportRepo.create.mockResolvedValue({
        id: 'r',
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      mockDnaVersionRepo.create.mockResolvedValue({});
      mockDnaUsageRepo.create.mockResolvedValue({});

      await processor.process(createMockJob({ textSamples: ['sample'] }) as never);

      // The TEXT gateway now requires an explicit provider+model,
      // resolved via the HarnessPolicy cascade and merged into the payload.
      expect(mockHarnessPolicyService.resolveTextSelection).toHaveBeenCalled();
      expect(mockHttpService.axiosRef.post).toHaveBeenCalledWith(
        'http://localhost:8862/api/v1/generate',
        {
          prompt: 'sample',
          system_prompt: 'Analyze writing.',
          stream: false,
          provider: 'lm-studio',
          model: 'resolved-medgemma',
        },
        {
          timeout: 120000,
          headers: {
            'Content-Type': 'application/json',
            'X-Service-Token': '',
            // Tenant-less work DECLARES itself rather than omitting the header
            // (owner directive 2026-08-16): the DNA job envelope carries no
            // tenant column, and an ABSENT `X-Tenant-Id` is indistinguishable
            // from one dropped in transit. See `common/internal-service-headers.ts`.
            'X-Tenant-Id': 'tenantless:job-queue',
          },
        },
      );
    });

    it('sends the job’s real tenant id as X-Tenant-Id when CLS holds one ', async () => {
      // Regression guard: `processWithContext` sets `tenantId` into CLS from the
      // job payload (`this.clsService.set('tenantId', tenantId)`), and `callText`
      // reads it back for the mandatory `X-Tenant-Id` header. The test above uses
      // the bare `vi.fn()` CLS mock (which never echoes `.set` back through
      // `.get`), so it only proves the tenant-less-fallback path — it can never
      // catch a regression where the real tenant is dropped. This test makes the
      // mock CLS stateful, mirroring real `nestjs-cls` request-scoped storage, so
      // the header is asserted against the ACTUAL job tenant, not the fallback.
      const clsStore = new Map<string, unknown>();
      mockClsService.set.mockImplementation((key: string, value: unknown) => clsStore.set(key, value));
      mockClsService.get.mockImplementation((key: string) => clsStore.get(key));

      mockPromptService.listPromptTemplates.mockResolvedValue([{ id: 'tpl-1', content: 'Analyze writing.', category: 'DNA_ANALYSIS' }]);
      mockHttpService.axiosRef.post.mockResolvedValue(createAxiosTextResponse('{"reportData":{},"styleText":"Style"}'));
      mockDnaReportRepo.findLatestForDoctor.mockResolvedValue(null);
      mockDnaReportRepo.create.mockResolvedValue({
        id: 'r',
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      mockDnaVersionRepo.create.mockResolvedValue({});
      mockDnaUsageRepo.create.mockResolvedValue({});

      await processor.process(createMockJob({ tenantId: 'tenant-real-789', textSamples: ['sample'] }) as never);

      expect(mockHttpService.axiosRef.post).toHaveBeenCalledWith(
        'http://localhost:8862/api/v1/generate',
        expect.any(Object),
        {
          timeout: 120000,
          headers: {
            'Content-Type': 'application/json',
            'X-Service-Token': '',
            'X-Tenant-Id': 'tenant-real-789',
          },
        },
      );
    });

    it('should succeed gathering from ContextItems when no textSamples provided', async () => {
      mockContextItemRepo.findAll.mockResolvedValue([
        { id: 'ci-1', content: 'Doctor summary text 1', text: null, type: 'RAW_SUMMARY' },
        { id: 'ci-2', content: null, text: 'Doctor summary text 2', type: 'MODIFIED_SUMMARY' },
      ]);
      mockPromptService.listPromptTemplates.mockResolvedValue([{ id: 'tpl-1', content: 'Analyze.', category: 'DNA_ANALYSIS' }]);
      mockHttpService.axiosRef.post.mockResolvedValue(createAxiosTextResponse('{"reportData":{},"styleText":"From context"}'));
      mockDnaReportRepo.findLatestForDoctor.mockResolvedValue(null);
      mockDnaReportRepo.create.mockResolvedValue({
        id: 'r',
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      mockDnaVersionRepo.create.mockResolvedValue({});
      mockDnaUsageRepo.create.mockResolvedValue({});

      const result = await processor.process(createMockJob({}) as never);

      expect(mockContextItemRepo.findAll).toHaveBeenCalled();
      const [, requestBody] = mockHttpService.axiosRef.post.mock.calls[0];
      expect(requestBody.prompt).toContain('Doctor summary text 1');
      expect(result.styleText).toBe('From context');
    });

    it('should handle TEXT JSON response with reportData and styleText', async () => {
      mockPromptService.listPromptTemplates.mockResolvedValue([{ id: 'tpl-1', content: 'Analyze.', category: 'DNA_ANALYSIS' }]);
      mockHttpService.axiosRef.post.mockResolvedValue(
        createAxiosTextResponse(
          JSON.stringify({
            reportData: { formality: 'high', tone: 'formal' },
            styleText: 'Formal medical writing style.',
          }),
        ),
      );
      mockDnaReportRepo.findLatestForDoctor.mockResolvedValue(null);
      mockDnaReportRepo.create.mockResolvedValue({
        id: 'r',
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      mockDnaVersionRepo.create.mockResolvedValue({});
      mockDnaUsageRepo.create.mockResolvedValue({});

      const result = await processor.process(createMockJob({ textSamples: ['sample'] }) as never);

      expect(result.reportData).toEqual({ formality: 'high', tone: 'formal' });
      expect(result.styleText).toBe('Formal medical writing style.');
    });

    // (Task 1 RED test 1 / PHI containment): a schema-mismatched TEXT
    // response must never be persisted verbatim. Pre-fix, this test asserted
    // the OPPOSITE (silent fallback to raw content) — flipped here so the
    // suite pins the fixed behavior;  for the RED-run
    // evidence captured before this assertion was updated.
    it('fails the job (never persists verbatim) when TEXT returns non-JSON content', async () => {
      mockPromptService.listPromptTemplates.mockResolvedValue([{ id: 'tpl-1', content: 'Analyze.', category: 'DNA_ANALYSIS' }]);
      mockHttpService.axiosRef.post.mockResolvedValue(createAxiosTextResponse('This is plain text analysis, not JSON.'));
      mockDnaReportRepo.findLatestForDoctor.mockResolvedValue(null);

      await expect(processor.process(createMockJob({ textSamples: ['sample'] }) as never)).rejects.toThrow(/unparseable or non-conforming/i);

      expect(mockJobService.notifyFailed).toHaveBeenCalledWith('job-1', expect.stringContaining('unparseable or non-conforming'));
      expect(mockDnaReportRepo.create).not.toHaveBeenCalled();
    });

    it('should handle TEXT JSON without styleText key — uses content as styleText', async () => {
      mockPromptService.listPromptTemplates.mockResolvedValue([{ id: 'tpl-1', content: 'Analyze.', category: 'DNA_ANALYSIS' }]);
      const jsonContent = JSON.stringify({
        reportData: { formality: 'medium' },
      });
      mockHttpService.axiosRef.post.mockResolvedValue(createAxiosTextResponse(jsonContent));
      mockDnaReportRepo.findLatestForDoctor.mockResolvedValue(null);
      mockDnaReportRepo.create.mockResolvedValue({
        id: 'r',
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      mockDnaVersionRepo.create.mockResolvedValue({});
      mockDnaUsageRepo.create.mockResolvedValue({});

      const result = await processor.process(createMockJob({ textSamples: ['sample'] }) as never);

      expect(result.reportData).toEqual({ formality: 'medium' });
      expect(result.styleText).toBe(jsonContent);
    });

    it('should still process when ContextItems exist but all have empty content', async () => {
      mockContextItemRepo.findAll.mockResolvedValue([
        { id: 'ci-empty-1', content: '', text: null, type: 'RAW_SUMMARY' },
        { id: 'ci-empty-2', content: null, text: '', type: 'MODIFIED_SUMMARY' },
      ]);
      mockPromptService.listPromptTemplates.mockResolvedValue([{ id: 'tpl-1', content: 'Analyze.', category: 'DNA_ANALYSIS' }]);
      mockHttpService.axiosRef.post.mockResolvedValue(createAxiosTextResponse('{"reportData":{},"styleText":"Minimal analysis"}'));
      mockDnaReportRepo.findLatestForDoctor.mockResolvedValue(null);
      mockDnaReportRepo.create.mockResolvedValue({
        id: 'r',
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      mockDnaVersionRepo.create.mockResolvedValue({});
      mockDnaUsageRepo.create.mockResolvedValue({});

      const result = await processor.process(createMockJob({}) as never);

      expect(result.styleText).toBe('Minimal analysis');
      const [, requestBody] = mockHttpService.axiosRef.post.mock.calls[0];
      expect(requestBody.prompt).toBe('');
    });

    it('should use default prompt when no DNA_ANALYSIS template exists', async () => {
      mockPromptService.listPromptTemplates.mockResolvedValue([]);
      mockHttpService.axiosRef.post.mockResolvedValue(createAxiosTextResponse('{"reportData":{},"styleText":"Fallback"}'));
      mockDnaReportRepo.findLatestForDoctor.mockResolvedValue(null);
      mockDnaReportRepo.create.mockResolvedValue({
        id: 'r',
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      mockDnaVersionRepo.create.mockResolvedValue({});
      mockDnaUsageRepo.create.mockResolvedValue({});

      await processor.process(createMockJob({ textSamples: ['sample'] }) as never);

      const [, requestBody] = mockHttpService.axiosRef.post.mock.calls[0];
      expect(requestBody.system_prompt).toContain('Analyze the following text samples');
    });

    it('should unmark previous latest report before creating new one', async () => {
      const previousReport = {
        id: 'old-report',
        isLatest: true,
      };
      mockDnaReportRepo.findLatestForDoctor.mockResolvedValue(previousReport);
      mockDnaReportRepo.update.mockResolvedValue(previousReport);
      mockPromptService.listPromptTemplates.mockResolvedValue([{ id: 'tpl-1', content: 'Analyze.', category: 'DNA_ANALYSIS' }]);
      mockHttpService.axiosRef.post.mockResolvedValue(createAxiosTextResponse('{"reportData":{},"styleText":"Style"}'));
      mockDnaReportRepo.create.mockResolvedValue({
        id: 'new-report',
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      mockDnaVersionRepo.create.mockResolvedValue({});
      mockDnaUsageRepo.create.mockResolvedValue({});

      await processor.process(createMockJob({ textSamples: ['sample'] }) as never);

      expect(previousReport.isLatest).toBe(false);
      expect(mockDnaReportRepo.update).toHaveBeenCalledWith('old-report', previousReport);
    });

    it('should skip unmark step when no previous latest report exists', async () => {
      mockDnaReportRepo.findLatestForDoctor.mockResolvedValue(null);
      mockPromptService.listPromptTemplates.mockResolvedValue([{ id: 'tpl-1', content: 'Analyze.', category: 'DNA_ANALYSIS' }]);
      mockHttpService.axiosRef.post.mockResolvedValue(createAxiosTextResponse('{"reportData":{},"styleText":"Style"}'));
      mockDnaReportRepo.create.mockResolvedValue({
        id: 'new-report',
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      mockDnaVersionRepo.create.mockResolvedValue({});
      mockDnaUsageRepo.create.mockResolvedValue({});

      await processor.process(createMockJob({ textSamples: ['sample'] }) as never);

      expect(mockDnaReportRepo.update).not.toHaveBeenCalled();
    });

    it('should create report, version, DNA usage record, and prompt usage record (silent)', async () => {
      mockPromptService.listPromptTemplates.mockResolvedValue([
        { id: 'tpl-1', content: 'Analyze.', category: 'DNA_ANALYSIS', currentVersionNumber: 2 },
      ]);
      mockHttpService.axiosRef.post.mockResolvedValue(createAxiosTextResponse('{"reportData":{"key":"val"},"styleText":"Style"}'));
      mockDnaReportRepo.findLatestForDoctor.mockResolvedValue(null);
      mockDnaReportRepo.create.mockResolvedValue({
        id: 'new-report',
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      mockDnaVersionRepo.create.mockResolvedValue({ id: 'new-version' });
      mockDnaUsageRepo.create.mockResolvedValue({ id: 'new-dna-usage' });
      mockPromptUsageRepo.create.mockResolvedValue({ id: 'new-prompt-usage' });

      await processor.process(createMockJob({ textSamples: ['sample'] }) as never);

      expect(mockDnaReportRepo.create).toHaveBeenCalledTimes(1);
      expect(mockDnaVersionRepo.create).toHaveBeenCalledTimes(1);
      expect(mockDnaUsageRepo.create).toHaveBeenCalledTimes(1);
      expect(mockPromptUsageRepo.create).toHaveBeenCalledTimes(1);
    });

    it('should record PromptUsageRecord with correct template ID and version when DNA_ANALYSIS template is consumed', async () => {
      const { PromptUsageRecordFactory } = await import('@arcaai/domains');

      mockPromptService.listPromptTemplates.mockResolvedValue([
        { id: 'dna-tpl-42', content: 'Analyze style.', category: 'DNA_ANALYSIS', currentVersionNumber: 3 },
      ]);
      mockHttpService.axiosRef.post.mockResolvedValue(createAxiosTextResponse('{"reportData":{},"styleText":"Style"}'));
      mockDnaReportRepo.findLatestForDoctor.mockResolvedValue(null);
      mockDnaReportRepo.create.mockResolvedValue({
        id: 'r',
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      mockDnaVersionRepo.create.mockResolvedValue({});
      mockDnaUsageRepo.create.mockResolvedValue({});
      mockPromptUsageRepo.create.mockResolvedValue({});

      await processor.process(
        createMockJob({
          doctorId: 'doctor-77',
          tenantId: 'tenant-88',
          textSamples: ['sample'],
        }) as never,
      );

      expect(PromptUsageRecordFactory.CreatePromptUsageRecord).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: 'tenant-88',
          doctorId: 'doctor-77',
          promptTemplateId: 'dna-tpl-42',
          promptVersionNumber: 3,
        }),
      );
      expect(mockPromptUsageRepo.create).toHaveBeenCalledTimes(1);
    });

    it('should NOT record PromptUsageRecord when no DNA_ANALYSIS template is found (fallback prompt used)', async () => {
      mockPromptService.listPromptTemplates.mockResolvedValue([]);
      mockHttpService.axiosRef.post.mockResolvedValue(createAxiosTextResponse('{"reportData":{},"styleText":"Fallback"}'));
      mockDnaReportRepo.findLatestForDoctor.mockResolvedValue(null);
      mockDnaReportRepo.create.mockResolvedValue({
        id: 'r',
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      mockDnaVersionRepo.create.mockResolvedValue({});
      mockDnaUsageRepo.create.mockResolvedValue({});

      await processor.process(createMockJob({ textSamples: ['sample'] }) as never);

      expect(mockPromptUsageRepo.create).not.toHaveBeenCalled();
    });

    it('should report progress at all 5 steps (10, 20, 40, 80, 100)', async () => {
      mockPromptService.listPromptTemplates.mockResolvedValue([{ id: 'tpl-1', content: 'Analyze.', category: 'DNA_ANALYSIS' }]);
      mockHttpService.axiosRef.post.mockResolvedValue(createAxiosTextResponse('{"reportData":{},"styleText":"Style"}'));
      mockDnaReportRepo.findLatestForDoctor.mockResolvedValue(null);
      mockDnaReportRepo.create.mockResolvedValue({
        id: 'r',
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      mockDnaVersionRepo.create.mockResolvedValue({});
      mockDnaUsageRepo.create.mockResolvedValue({});

      await processor.process(createMockJob({ textSamples: ['sample'] }) as never);

      const progressValues = mockJobService.notifyProgress.mock.calls.map((call: unknown[]) => (call as [string, number])[1]);
      expect(progressValues).toEqual([10, 20, 40, 80, 100]);
    });

    it('should call notifyComplete with reportId', async () => {
      mockPromptService.listPromptTemplates.mockResolvedValue([{ id: 'tpl-1', content: 'Analyze.', category: 'DNA_ANALYSIS' }]);
      mockHttpService.axiosRef.post.mockResolvedValue(createAxiosTextResponse('{"reportData":{},"styleText":"Style"}'));
      mockDnaReportRepo.findLatestForDoctor.mockResolvedValue(null);
      mockDnaReportRepo.create.mockResolvedValue({
        id: 'saved-report-123',
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      mockDnaVersionRepo.create.mockResolvedValue({});
      mockDnaUsageRepo.create.mockResolvedValue({});

      await processor.process(createMockJob({ textSamples: ['sample'] }) as never);

      expect(mockJobService.notifyComplete).toHaveBeenCalledWith('job-1', {
        reportId: 'saved-report-123',
      });
    });

    it('should use custom TEXT URL from ConfigService', async () => {
      const customConfig = createMockConfigService();
      customConfig.get.mockReturnValue('http://custom-text:9000');
      const customProcessor = new DnaWritingStyleProcessor(
        mockJobService as never,
        mockAppSettings as never,
        mockContextItemRepo as never,
        mockContextItemVersionRepo as never,
        mockDnaReportRepo as never,
        mockDnaVersionRepo as never,
        mockDnaUsageRepo as never,
        mockPromptUsageRepo as never,
        mockPromptService as never,
        mockHttpService as never,
        customConfig as never,
        mockJobMetrics as never,
        mockClsService as never,
        undefined, // secretsService (@Optional)
        undefined, // harnessPolicyService (@Optional)
        undefined, // configResolver (@Optional)
        undefined, // promptTemplateRepository (@Optional)
        createPassThroughPhiRedactor() as never, // phiRedactor (REQUIRED)
      );

      mockPromptService.listPromptTemplates.mockResolvedValue([]);
      mockHttpService.axiosRef.post.mockResolvedValue(createAxiosTextResponse('{"reportData":{},"styleText":"Style"}'));
      mockDnaReportRepo.findLatestForDoctor.mockResolvedValue(null);
      mockDnaReportRepo.create.mockResolvedValue({
        id: 'r',
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      mockDnaVersionRepo.create.mockResolvedValue({});
      mockDnaUsageRepo.create.mockResolvedValue({});

      await customProcessor.process(createMockJob({ textSamples: ['sample'] }) as never);

      expect(mockHttpService.axiosRef.post).toHaveBeenCalledWith('http://custom-text:9000/api/v1/generate', expect.any(Object), expect.any(Object));
    });

    it('should use default TEXT URL when config returns undefined', async () => {
      const noConfig = createMockConfigService();
      noConfig.get.mockReturnValue(undefined);
      const fallbackProcessor = new DnaWritingStyleProcessor(
        mockJobService as never,
        mockAppSettings as never,
        mockContextItemRepo as never,
        mockContextItemVersionRepo as never,
        mockDnaReportRepo as never,
        mockDnaVersionRepo as never,
        mockDnaUsageRepo as never,
        mockPromptUsageRepo as never,
        mockPromptService as never,
        mockHttpService as never,
        noConfig as never,
        mockJobMetrics as never,
        mockClsService as never,
        undefined, // secretsService (@Optional)
        undefined, // harnessPolicyService (@Optional)
        undefined, // configResolver (@Optional)
        undefined, // promptTemplateRepository (@Optional)
        createPassThroughPhiRedactor() as never, // phiRedactor (REQUIRED)
      );

      mockPromptService.listPromptTemplates.mockResolvedValue([]);
      mockHttpService.axiosRef.post.mockResolvedValue(createAxiosTextResponse('{"reportData":{},"styleText":"Style"}'));
      mockDnaReportRepo.findLatestForDoctor.mockResolvedValue(null);
      mockDnaReportRepo.create.mockResolvedValue({
        id: 'r',
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      mockDnaVersionRepo.create.mockResolvedValue({});
      mockDnaUsageRepo.create.mockResolvedValue({});

      await fallbackProcessor.process(createMockJob({ textSamples: ['sample'] }) as never);

      expect(mockHttpService.axiosRef.post).toHaveBeenCalledWith('http://localhost:8862/api/v1/generate', expect.any(Object), expect.any(Object));
    });

    it('should call DnaUsageRecordFactory with correct params', async () => {
      const { DnaUsageRecordFactory } = await import('@arcaai/domains');

      mockPromptService.listPromptTemplates.mockResolvedValue([{ id: 'tpl-1', content: 'Analyze.', category: 'DNA_ANALYSIS' }]);
      mockHttpService.axiosRef.post.mockResolvedValue(createAxiosTextResponse('{"reportData":{},"styleText":"Style"}'));
      mockDnaReportRepo.findLatestForDoctor.mockResolvedValue(null);
      mockDnaReportRepo.create.mockResolvedValue({
        id: 'report-xyz',
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      mockDnaVersionRepo.create.mockResolvedValue({});
      mockDnaUsageRepo.create.mockResolvedValue({});

      await processor.process(
        createMockJob({
          doctorId: 'doctor-99',
          tenantId: 'tenant-42',
          textSamples: ['sample text'],
        }) as never,
      );

      expect(DnaUsageRecordFactory.CreateDnaUsageRecord).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: 'tenant-42',
          doctorId: 'doctor-99',
          dnaReportId: 'report-xyz',
          dnaVersionNumber: 1,
        }),
      );
    });
  });

  // ─── Context Limits (AppSettings) ─────────────────────────────

  describe('Context Limits from AppSettings', () => {
    it('should pass max-samples as limit to contextItemRepository.findAll', async () => {
      const limitedSettings = createMockAppSettingsService({ 'dna-regen.max-samples': 10 });
      const limitedProcessor = new DnaWritingStyleProcessor(
        mockJobService as never,
        limitedSettings as never,
        mockContextItemRepo as never,
        mockContextItemVersionRepo as never,
        mockDnaReportRepo as never,
        mockDnaVersionRepo as never,
        mockDnaUsageRepo as never,
        mockPromptUsageRepo as never,
        mockPromptService as never,
        mockHttpService as never,
        mockConfigService as never,
        mockJobMetrics as never,
        mockClsService as never,
        undefined, // secretsService (@Optional)
        undefined, // harnessPolicyService (@Optional)
        undefined, // configResolver (@Optional)
        undefined, // promptTemplateRepository (@Optional)
        createPassThroughPhiRedactor() as never, // phiRedactor (REQUIRED)
      );

      mockContextItemRepo.findAll.mockResolvedValue([{ id: 'ci-1', content: 'text-1', text: null, type: 'RAW_SUMMARY' }]);
      mockPromptService.listPromptTemplates.mockResolvedValue([]);
      mockHttpService.axiosRef.post.mockResolvedValue(createAxiosTextResponse('{"reportData":{},"styleText":"OK"}'));
      mockDnaReportRepo.findLatestForDoctor.mockResolvedValue(null);
      mockDnaReportRepo.create.mockResolvedValue({
        id: 'r',
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      mockDnaVersionRepo.create.mockResolvedValue({});
      mockDnaUsageRepo.create.mockResolvedValue({});

      await limitedProcessor.process(createMockJob({}) as never);

      expect(mockContextItemRepo.findAll).toHaveBeenCalledWith(expect.objectContaining({ limit: 10 }));
    });

    it('should truncate joined samples when exceeding max-context-chars', async () => {
      const tinyLimit = createMockAppSettingsService({ 'dna-regen.max-context-chars': 20 });
      const limitedProcessor = new DnaWritingStyleProcessor(
        mockJobService as never,
        tinyLimit as never,
        mockContextItemRepo as never,
        mockContextItemVersionRepo as never,
        mockDnaReportRepo as never,
        mockDnaVersionRepo as never,
        mockDnaUsageRepo as never,
        mockPromptUsageRepo as never,
        mockPromptService as never,
        mockHttpService as never,
        mockConfigService as never,
        mockJobMetrics as never,
        mockClsService as never,
        undefined, // secretsService (@Optional)
        undefined, // harnessPolicyService (@Optional)
        undefined, // configResolver (@Optional)
        undefined, // promptTemplateRepository (@Optional)
        createPassThroughPhiRedactor() as never, // phiRedactor (REQUIRED)
      );

      mockPromptService.listPromptTemplates.mockResolvedValue([]);
      mockHttpService.axiosRef.post.mockResolvedValue(createAxiosTextResponse('{"reportData":{},"styleText":"Truncated"}'));
      mockDnaReportRepo.findLatestForDoctor.mockResolvedValue(null);
      mockDnaReportRepo.create.mockResolvedValue({
        id: 'r',
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      mockDnaVersionRepo.create.mockResolvedValue({});
      mockDnaUsageRepo.create.mockResolvedValue({});

      const longSamples = ['A'.repeat(50), 'B'.repeat(50)];
      await limitedProcessor.process(createMockJob({ textSamples: longSamples }) as never);

      const [, requestBody] = mockHttpService.axiosRef.post.mock.calls[0];
      expect(requestBody.prompt.length).toBeLessThanOrEqual(20);
    });

    it('should not truncate when samples are within max-context-chars', async () => {
      mockPromptService.listPromptTemplates.mockResolvedValue([]);
      mockHttpService.axiosRef.post.mockResolvedValue(createAxiosTextResponse('{"reportData":{},"styleText":"OK"}'));
      mockDnaReportRepo.findLatestForDoctor.mockResolvedValue(null);
      mockDnaReportRepo.create.mockResolvedValue({
        id: 'r',
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      mockDnaVersionRepo.create.mockResolvedValue({});
      mockDnaUsageRepo.create.mockResolvedValue({});

      await processor.process(createMockJob({ textSamples: ['short text'] }) as never);

      const [, requestBody] = mockHttpService.axiosRef.post.mock.calls[0];
      expect(requestBody.prompt).toBe('short text');
    });

    it('should use default limits when AppSettings has no values', async () => {
      const emptySettings = createMockAppSettingsService({});
      emptySettings.getValueWithDefault.mockImplementation(<T>(_key: string, defaultValue: T): T => defaultValue);
      const defaultProcessor = new DnaWritingStyleProcessor(
        mockJobService as never,
        emptySettings as never,
        mockContextItemRepo as never,
        mockContextItemVersionRepo as never,
        mockDnaReportRepo as never,
        mockDnaVersionRepo as never,
        mockDnaUsageRepo as never,
        mockPromptUsageRepo as never,
        mockPromptService as never,
        mockHttpService as never,
        mockConfigService as never,
        mockJobMetrics as never,
        mockClsService as never,
        undefined, // secretsService (@Optional)
        undefined, // harnessPolicyService (@Optional)
        undefined, // configResolver (@Optional)
        undefined, // promptTemplateRepository (@Optional)
        createPassThroughPhiRedactor() as never, // phiRedactor (REQUIRED)
      );

      mockContextItemRepo.findAll.mockResolvedValue([{ id: 'ci-x', content: 'text', text: null, type: 'RAW_SUMMARY' }]);
      mockPromptService.listPromptTemplates.mockResolvedValue([]);
      mockHttpService.axiosRef.post.mockResolvedValue(createAxiosTextResponse('{"reportData":{},"styleText":"OK"}'));
      mockDnaReportRepo.findLatestForDoctor.mockResolvedValue(null);
      mockDnaReportRepo.create.mockResolvedValue({
        id: 'r',
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      mockDnaVersionRepo.create.mockResolvedValue({});
      mockDnaUsageRepo.create.mockResolvedValue({});

      await defaultProcessor.process(createMockJob({}) as never);

      expect(mockContextItemRepo.findAll).toHaveBeenCalledWith(expect.objectContaining({ limit: 50 }));
    });
  });

  // ─── Error Handling ─────────────────────────────────────────

  describe('Error Handling', () => {
    it('should notify failed and re-throw when TEXT call fails', async () => {
      mockPromptService.listPromptTemplates.mockResolvedValue([{ id: 'tpl-1', content: 'Analyze.', category: 'DNA_ANALYSIS' }]);
      mockHttpService.axiosRef.post.mockRejectedValue(new Error('Connection refused'));

      await expect(processor.process(createMockJob({ textSamples: ['sample'] }) as never)).rejects.toThrow('Connection refused');

      expect(mockJobService.notifyFailed).toHaveBeenCalledWith('job-1', expect.stringContaining('Connection refused'));
    });

    it('should notify failed and re-throw on TEXT timeout', async () => {
      mockPromptService.listPromptTemplates.mockResolvedValue([{ id: 'tpl-1', content: 'Analyze.', category: 'DNA_ANALYSIS' }]);
      mockHttpService.axiosRef.post.mockRejectedValue(new Error('timeout of 120000ms exceeded'));

      await expect(processor.process(createMockJob({ textSamples: ['sample'] }) as never)).rejects.toThrow('timeout');

      expect(mockJobService.notifyFailed).toHaveBeenCalledWith('job-1', expect.stringContaining('timeout'));
    });

    it('should throw when no text samples and no ContextItems found', async () => {
      mockContextItemRepo.findAll.mockResolvedValue([]);

      await expect(processor.process(createMockJob({}) as never)).rejects.toThrow('No text samples available for DNA analysis');

      expect(mockJobService.notifyFailed).toHaveBeenCalledWith('job-1', expect.stringContaining('No text samples'));
    });

    it('should notify failed with correct jobId from payload', async () => {
      mockContextItemRepo.findAll.mockResolvedValue([]);

      try {
        await processor.process(createMockJob({ jobId: 'specific-job-42' }) as never);
      } catch {
        // expected
      }

      expect(mockJobService.notifyFailed).toHaveBeenCalledWith('specific-job-42', expect.any(String));
    });
  });

  // ─── CLS Context Propagation ─────────────────────────────────

  describe('CLS Context Propagation', () => {
    it('should set tenantId in CLS context from job payload before calling services', async () => {
      mockPromptService.listPromptTemplates.mockResolvedValue([]);
      mockHttpService.axiosRef.post.mockResolvedValue(createAxiosTextResponse('{"reportData":{},"styleText":"Style"}'));
      mockDnaReportRepo.findLatestForDoctor.mockResolvedValue(null);
      mockDnaReportRepo.create.mockResolvedValue({
        id: 'r',
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      mockDnaVersionRepo.create.mockResolvedValue({});
      mockDnaUsageRepo.create.mockResolvedValue({});

      await processor.process(createMockJob({ tenantId: 'tenant-from-job', textSamples: ['sample'] }) as never);

      expect(mockClsService.set).toHaveBeenCalledWith('tenantId', 'tenant-from-job');
    });

    it('should set userId in CLS context from job payload', async () => {
      mockPromptService.listPromptTemplates.mockResolvedValue([]);
      mockHttpService.axiosRef.post.mockResolvedValue(createAxiosTextResponse('{"reportData":{},"styleText":"Style"}'));
      mockDnaReportRepo.findLatestForDoctor.mockResolvedValue(null);
      mockDnaReportRepo.create.mockResolvedValue({
        id: 'r',
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      mockDnaVersionRepo.create.mockResolvedValue({});
      mockDnaUsageRepo.create.mockResolvedValue({});

      await processor.process(createMockJob({ userId: 'user-from-job', textSamples: ['sample'] }) as never);

      expect(mockClsService.set).toHaveBeenCalledWith('user', expect.objectContaining({ id: 'user-from-job' }));
    });
  });

  // ─── APPROVED-only learning corpus ──────────────────

  describe('APPROVED-only learning corpus', () => {
    it('excludes non-approved summaries from the corpus and only feeds approved ones to TEXT', async () => {
      mockContextItemVersionRepo.getVersionsByChangeReason.mockImplementation(async (contextItemId: string, changeReason: string) => {
        if (changeReason !== 'approved') return [];
        return contextItemId === 'ci-approved' ? [{ id: 'v-1', contextItemId, changeReason: 'approved', versionNumber: 1 }] : [];
      });

      mockContextItemRepo.findAll.mockResolvedValue([
        { id: 'ci-approved', content: 'Approved summary body', type: 'RAW_SUMMARY' },
        { id: 'ci-pending', content: 'Pending summary body', type: 'RAW_SUMMARY' },
        { id: 'ci-modified-pending', content: 'Modified but not approved', type: 'MODIFIED_SUMMARY' },
      ]);
      mockPromptService.listPromptTemplates.mockResolvedValue([{ id: 'tpl-1', content: 'Analyze.', category: 'DNA_ANALYSIS' }]);
      mockHttpService.axiosRef.post.mockResolvedValue(createAxiosTextResponse('{"reportData":{},"styleText":"Style"}'));
      mockDnaReportRepo.findLatestForDoctor.mockResolvedValue(null);
      mockDnaReportRepo.create.mockResolvedValue({
        id: 'r',
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      mockDnaVersionRepo.create.mockResolvedValue({});
      mockDnaUsageRepo.create.mockResolvedValue({});

      await processor.process(createMockJob({}) as never);

      const [, requestBody] = mockHttpService.axiosRef.post.mock.calls[0];
      expect(requestBody.prompt).toContain('Approved summary body');
      expect(requestBody.prompt).not.toContain('Pending summary body');
      expect(requestBody.prompt).not.toContain('Modified but not approved');
    });

    it('persists source contextItemIds inside reportData for explainability', async () => {
      const { DnaWritingStyleReportFactory } = await import('@arcaai/domains');

      mockContextItemVersionRepo.getVersionsByChangeReason.mockImplementation(async (contextItemId: string, changeReason: string) => {
        if (changeReason !== 'approved') return [];
        return contextItemId === 'ci-a' || contextItemId === 'ci-c' ? [{ id: 'v', contextItemId, changeReason: 'approved', versionNumber: 1 }] : [];
      });

      mockContextItemRepo.findAll.mockResolvedValue([
        { id: 'ci-a', content: 'A', type: 'RAW_SUMMARY' },
        { id: 'ci-b', content: 'B', type: 'RAW_SUMMARY' },
        { id: 'ci-c', content: 'C', type: 'MODIFIED_SUMMARY' },
      ]);
      mockPromptService.listPromptTemplates.mockResolvedValue([{ id: 'tpl-1', content: 'Analyze.', category: 'DNA_ANALYSIS' }]);
      mockHttpService.axiosRef.post.mockResolvedValue(createAxiosTextResponse('{"reportData":{"x":1},"styleText":"Style"}'));
      mockDnaReportRepo.findLatestForDoctor.mockResolvedValue(null);
      mockDnaReportRepo.create.mockResolvedValue({
        id: 'r',
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      mockDnaVersionRepo.create.mockResolvedValue({});
      mockDnaUsageRepo.create.mockResolvedValue({});

      await processor.process(createMockJob({}) as never);

      expect(DnaWritingStyleReportFactory.CreateDnaWritingStyleReport).toHaveBeenCalledWith(
        expect.objectContaining({
          reportData: expect.objectContaining({
            sourceContextItemIds: ['ci-a', 'ci-c'],
          }),
        }),
      );
    });

    it('skips non-final-summary context items (e.g. PRE_SUMMARY, TRANSCRIPT) even when approved', async () => {
      mockContextItemVersionRepo.getVersionsByChangeReason.mockImplementation(async (_contextItemId: string, changeReason: string) =>
        changeReason === 'approved' ? [{ id: 'v', contextItemId: _contextItemId, changeReason: 'approved', versionNumber: 1 }] : [],
      );

      mockContextItemRepo.findAll.mockResolvedValue([
        { id: 'ci-final', content: 'Final summary', type: 'RAW_SUMMARY' },
        { id: 'ci-pre', content: 'Pre summary', type: 'PRE_SUMMARY' },
        { id: 'ci-tx', content: 'Transcript', type: 'TRANSCRIPT' },
      ]);
      mockPromptService.listPromptTemplates.mockResolvedValue([{ id: 'tpl-1', content: 'Analyze.', category: 'DNA_ANALYSIS' }]);
      mockHttpService.axiosRef.post.mockResolvedValue(createAxiosTextResponse('{"reportData":{},"styleText":"Style"}'));
      mockDnaReportRepo.findLatestForDoctor.mockResolvedValue(null);
      mockDnaReportRepo.create.mockResolvedValue({
        id: 'r',
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      mockDnaVersionRepo.create.mockResolvedValue({});
      mockDnaUsageRepo.create.mockResolvedValue({});

      await processor.process(createMockJob({}) as never);

      const [, requestBody] = mockHttpService.axiosRef.post.mock.calls[0];
      expect(requestBody.prompt).toContain('Final summary');
      expect(requestBody.prompt).not.toContain('Pre summary');
      expect(requestBody.prompt).not.toContain('Transcript');
    });

    it('fails the job when no approved summaries exist (no textSamples override)', async () => {
      mockContextItemVersionRepo.getVersionsByChangeReason.mockResolvedValue([]);
      mockContextItemRepo.findAll.mockResolvedValue([
        { id: 'ci-1', content: 'Unapproved', type: 'RAW_SUMMARY' },
        { id: 'ci-2', content: 'Unapproved 2', type: 'MODIFIED_SUMMARY' },
      ]);

      await expect(processor.process(createMockJob({}) as never)).rejects.toThrow(/no.*approved.*samples|No text samples available/i);

      expect(mockJobService.notifyFailed).toHaveBeenCalled();
    });

    it('bypasses the approval filter when explicit textSamples are supplied (admin/migration path)', async () => {
      mockContextItemVersionRepo.getVersionsByChangeReason.mockResolvedValue([]);
      mockPromptService.listPromptTemplates.mockResolvedValue([{ id: 'tpl-1', content: 'Analyze.', category: 'DNA_ANALYSIS' }]);
      mockHttpService.axiosRef.post.mockResolvedValue(createAxiosTextResponse('{"reportData":{},"styleText":"Style"}'));
      mockDnaReportRepo.findLatestForDoctor.mockResolvedValue(null);
      mockDnaReportRepo.create.mockResolvedValue({
        id: 'r',
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      mockDnaVersionRepo.create.mockResolvedValue({});
      mockDnaUsageRepo.create.mockResolvedValue({});

      await processor.process(createMockJob({ textSamples: ['Explicit text sample bypassing approval'] }) as never);

      const [, requestBody] = mockHttpService.axiosRef.post.mock.calls[0];
      expect(requestBody.prompt).toContain('Explicit text sample bypassing approval');
    });
  });

  // ─── draft↔approved pairs + DNA gating ──────────
  describe('Phase 6 — draft↔approved learning pairs', () => {
    const createMockConfigResolver = () => ({
      resolveEffectiveDnaStyleEnabled: vi.fn().mockResolvedValue({ effective: true, tenantEnabled: true, doctorToggle: null }),
    });

    const buildProcessorWithResolver = (configResolver: unknown) =>
      new DnaWritingStyleProcessor(
        mockJobService as never,
        mockAppSettings as never,
        mockContextItemRepo as never,
        mockContextItemVersionRepo as never,
        mockDnaReportRepo as never,
        mockDnaVersionRepo as never,
        mockDnaUsageRepo as never,
        mockPromptUsageRepo as never,
        mockPromptService as never,
        mockHttpService as never,
        mockConfigService as never,
        mockJobMetrics as never,
        mockClsService as never,
        undefined, // secretsService
        mockHarnessPolicyService as never, // harnessPolicyService
        configResolver as never, // configResolver
        undefined, // promptTemplateRepository (@Optional)
        createPassThroughPhiRedactor() as never, // phiRedactor (REQUIRED)
      );

    const primeStorageMocks = () => {
      mockPromptService.listPromptTemplates.mockResolvedValue([{ id: 'tpl-1', content: 'Analyze.', category: 'DNA_ANALYSIS' }]);
      mockHttpService.axiosRef.post.mockResolvedValue(createAxiosTextResponse('{"reportData":{},"styleText":"Style"}'));
      mockDnaReportRepo.findLatestForDoctor.mockResolvedValue(null);
      mockDnaReportRepo.create.mockResolvedValue({ id: 'r', createdAt: new Date(), updatedAt: new Date() });
      mockDnaVersionRepo.create.mockResolvedValue({});
      mockDnaUsageRepo.create.mockResolvedValue({});
    };

    it('pairs the ai_draft_v1 snapshot with the approved final when both exist (AI DRAFT → DOCTOR APPROVED)', async () => {
      mockContextItemVersionRepo.getVersionsByChangeReason.mockImplementation(async (id: string, reason: string) => {
        if (reason === 'approved') return [{ id: 'v', contextItemId: id, changeReason: 'approved', versionNumber: 2 }];
        if (reason === 'ai_draft_v1')
          return [{ id: 'd', contextItemId: id, changeReason: 'ai_draft_v1', versionNumber: 1, content: 'AI DRAFT BODY' }];
        return [];
      });
      mockContextItemRepo.findAll.mockResolvedValue([{ id: 'ci-1', content: 'DOCTOR APPROVED BODY', type: 'RAW_SUMMARY' }]);
      primeStorageMocks();

      await processor.process(createMockJob({}) as never);

      const [, requestBody] = mockHttpService.axiosRef.post.mock.calls[0];
      expect(requestBody.prompt).toContain('AI DRAFT:');
      expect(requestBody.prompt).toContain('AI DRAFT BODY');
      expect(requestBody.prompt).toContain('DOCTOR APPROVED:');
      expect(requestBody.prompt).toContain('DOCTOR APPROVED BODY');
    });

    it('falls back to final-only (no AI DRAFT block) for a legacy consult with no v1 snapshot', async () => {
      // default mock: approved → present, ai_draft_v1 → [] (legacy)
      mockContextItemRepo.findAll.mockResolvedValue([{ id: 'ci-1', content: 'DOCTOR APPROVED BODY', type: 'RAW_SUMMARY' }]);
      primeStorageMocks();

      await processor.process(createMockJob({}) as never);

      const [, requestBody] = mockHttpService.axiosRef.post.mock.calls[0];
      expect(requestBody.prompt).toContain('DOCTOR APPROVED BODY');
      expect(requestBody.prompt).not.toContain('AI DRAFT:');
    });

    it('keeps the callText transport boundary stable (payload still {prompt, system_prompt, stream:false, provider, model})', async () => {
      mockContextItemVersionRepo.getVersionsByChangeReason.mockImplementation(async (id: string, reason: string) => {
        if (reason === 'approved') return [{ id: 'v', contextItemId: id, changeReason: 'approved', versionNumber: 2 }];
        if (reason === 'ai_draft_v1')
          return [{ id: 'd', contextItemId: id, changeReason: 'ai_draft_v1', versionNumber: 1, content: 'AI DRAFT BODY' }];
        return [];
      });
      mockContextItemRepo.findAll.mockResolvedValue([{ id: 'ci-1', content: 'DOCTOR APPROVED BODY', type: 'RAW_SUMMARY' }]);
      primeStorageMocks();

      await processor.process(createMockJob({}) as never);

      const [url, requestBody] = mockHttpService.axiosRef.post.mock.calls[0];
      expect(url).toBe('http://localhost:8862/api/v1/generate');
      expect(requestBody).toEqual(expect.objectContaining({ prompt: expect.any(String), system_prompt: expect.any(String), stream: false }));
      expect(Object.keys(requestBody).sort()).toEqual(['model', 'prompt', 'provider', 'stream', 'system_prompt']);
    });

    it('GATES the automatic corpus: a doctor with effective DNA = false is not learned-from (job fails)', async () => {
      const configResolver = createMockConfigResolver();
      configResolver.resolveEffectiveDnaStyleEnabled.mockResolvedValue({ effective: false, tenantEnabled: true, doctorToggle: false });
      const gatedProcessor = buildProcessorWithResolver(configResolver);

      await expect(gatedProcessor.process(createMockJob({}) as never)).rejects.toThrow(/disabled/i);

      expect(configResolver.resolveEffectiveDnaStyleEnabled).toHaveBeenCalledWith(
        expect.objectContaining({ tenantId: 'tenant-1', doctorId: 'doctor-1' }),
      );
      expect(mockJobService.notifyFailed).toHaveBeenCalledWith('job-1', expect.stringContaining('disabled'));
      // gated out BEFORE the corpus is even fetched
      expect(mockContextItemRepo.findAll).not.toHaveBeenCalled();
    });

    // (Task 1 RED test 2 / PHI containment): the opt-out gate now
    // applies to BOTH paths — an admin/migration `textSamples` call can no
    // longer override a doctor's (or tenant's) opt-out. Pre-fix, this test
    // asserted the bypass SUCCEEDED; flipped here to pin the fixed gating.
    it('GATES the explicit textSamples path too, when effective DNA = false (admin/migration can no longer bypass opt-out)', async () => {
      const configResolver = createMockConfigResolver();
      configResolver.resolveEffectiveDnaStyleEnabled.mockResolvedValue({ effective: false, tenantEnabled: false, doctorToggle: null });
      const gatedProcessor = buildProcessorWithResolver(configResolver);
      primeStorageMocks();

      await expect(gatedProcessor.process(createMockJob({ textSamples: ['Explicit override sample'] }) as never)).rejects.toThrow(/disabled/i);

      expect(configResolver.resolveEffectiveDnaStyleEnabled).toHaveBeenCalledWith(
        expect.objectContaining({ tenantId: 'tenant-1', doctorId: 'doctor-1' }),
      );
      expect(mockJobService.notifyFailed).toHaveBeenCalledWith('job-1', expect.stringContaining('disabled'));
      expect(mockHttpService.axiosRef.post).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // hop 2 — PHI redaction before the corpus reaches TEXT
  // ===========================================================================

  describe('PHI redaction (hop 2)', () => {
    const buildProcessorWithPhiRedactor = (phiRedactor: unknown) =>
      new DnaWritingStyleProcessor(
        mockJobService as never,
        mockAppSettings as never,
        mockContextItemRepo as never,
        mockContextItemVersionRepo as never,
        mockDnaReportRepo as never,
        mockDnaVersionRepo as never,
        mockDnaUsageRepo as never,
        mockPromptUsageRepo as never,
        mockPromptService as never,
        mockHttpService as never,
        mockConfigService as never,
        mockJobMetrics as never,
        mockClsService as never,
        undefined, // secretsService
        mockHarnessPolicyService as never, // harnessPolicyService
        undefined, // configResolver
        undefined, // promptTemplateRepository
        phiRedactor as never, // phiRedactor
      );

    const primeStorageMocks = () => {
      mockPromptService.listPromptTemplates.mockResolvedValue([{ id: 'tpl-1', content: 'Analyze.', category: 'DNA_ANALYSIS' }]);
      mockHttpService.axiosRef.post.mockResolvedValue(createAxiosTextResponse('{"reportData":{},"styleText":"Style"}'));
      mockDnaReportRepo.findLatestForDoctor.mockResolvedValue(null);
      mockDnaReportRepo.create.mockResolvedValue({ id: 'r', createdAt: new Date(), updatedAt: new Date() });
      mockDnaVersionRepo.create.mockResolvedValue({});
      mockDnaUsageRepo.create.mockResolvedValue({});
    };

    it("calls redact(samples, 'full') and posts the REDACTED corpus to TEXT — the raw sample never reaches the mocked TEXT client", async () => {
      const rawSample = 'Patient John Smith, DOB 1985-02-03, prescribed lisinopril.';
      const redactedSample = '[REDACTED] prescribed lisinopril.';
      const phiRedactor = { redact: vi.fn().mockResolvedValue(redactedSample) };
      const proc = buildProcessorWithPhiRedactor(phiRedactor);
      primeStorageMocks();

      await proc.process(createMockJob({ textSamples: [rawSample] }) as never);

      expect(phiRedactor.redact).toHaveBeenCalledWith(rawSample, 'full');
      const [, requestBody] = mockHttpService.axiosRef.post.mock.calls[0];
      expect(requestBody.prompt).toBe(redactedSample);
      expect(requestBody.prompt).not.toContain('John Smith');
      expect(requestBody.prompt).not.toContain('1985-02-03');
    });

    it('FAIL-CLOSED: a throwing redactor aborts the job — TEXT is never called with the unredacted corpus', async () => {
      const phiRedactor = { redact: vi.fn().mockRejectedValue(new Error('guardrail unreachable')) };
      const proc = buildProcessorWithPhiRedactor(phiRedactor);
      primeStorageMocks();

      await expect(proc.process(createMockJob({ textSamples: ['Patient John Smith.'] }) as never)).rejects.toThrow();

      expect(mockHttpService.axiosRef.post).not.toHaveBeenCalled();
      expect(mockJobService.notifyFailed).toHaveBeenCalledWith('job-1', expect.stringContaining('guardrail unreachable'));
    });

    /**
     * (re-opened), owner directive D-A. This assertion is INVERTED
     * from what it said before: an unwired redactor used to mean "post the raw
     * corpus unchanged", guarded by `if (this.phiRedactor)`. That is the exact
     * shape by which hop 1 silently lost its redaction when deleted
     * `ner.processor.ts` — a dependency whose absence is indistinguishable from
     * "nothing to redact". The dependency is now REQUIRED (Nest fails at boot
     * without `PhiRedactionServiceModule`) and the call site aborts.
 */
    it('FAIL-CLOSED: an unwired redactor aborts the job — the raw corpus is never posted to TEXT', async () => {
      const proc = buildProcessorWithPhiRedactor(undefined);
      primeStorageMocks();

      await expect(proc.process(createMockJob({ textSamples: ['Patient John Smith.'] }) as never)).rejects.toThrow(/redact/i);

      expect(mockHttpService.axiosRef.post).not.toHaveBeenCalled();
    });
  });
});
