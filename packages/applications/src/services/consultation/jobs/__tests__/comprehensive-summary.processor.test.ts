/**
 * ComprehensiveSummaryProcessor Unit Tests
 *
 * Tests for the BullMQ processor that handles async comprehensive summary
 * generation jobs. The processor resolves linked consultations, gathers
 * sections and NER entities via ChainSummaryService, calls the SMR service,
 * and persists the result.
 *
 * Progress steps: 10% → 25% → 40% → 60% → 85% → 100%
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Job } from 'bullmq';
import { ComprehensiveSummaryProcessor } from '../processors/comprehensive-summary.processor';
import { GenerateComprehensiveSummaryJobPayload, ComprehensiveSummaryJobResult } from '../dto';

// Mock domain factories
vi.mock('@arcaai/domains', async () => {
  const actual = await vi.importActual('@arcaai/domains');
  return {
    ...actual,
    ContextItemFactory: {
      CreateRawSummary: vi.fn((tenantId, consultationId, content, dnaStyleId, createdBy) => ({
        id: 'ctx-comprehensive-1',
        tenantId,
        consultationId,
        content,
        dnaWritingStyleId: dnaStyleId,
        type: 'RAW_SUMMARY',
        createdBy,
        createdAt: new Date('2026-02-17T10:00:00Z'),
        updatedAt: new Date('2026-02-17T10:00:00Z'),
      })),
    },
    SummaryMetaFactory: {
      CreateSummaryMeta: vi.fn((props) => ({
        id: 'meta-comprehensive-1',
        ...props,
      })),
    },
  };
});

// ============================================
// Mock Factories
// ============================================

const createMockJobService = () => ({
  notifyProgress: vi.fn().mockResolvedValue(undefined),
  notifyComplete: vi.fn().mockResolvedValue(undefined),
  notifyFailed: vi.fn().mockResolvedValue(undefined),
});

const createMockChainSummaryService = () => ({
  resolveLinkedConsultations: vi.fn().mockResolvedValue([]),
  gatherSections: vi.fn().mockResolvedValue([]),
  gatherNamedEntities: vi.fn().mockResolvedValue({}),
});

const createMockContextItemRepository = () => ({
  create: vi.fn().mockImplementation((item) => Promise.resolve(item)),
  encryptContentIntoEntity: vi.fn().mockResolvedValue(undefined),
});

const createMockConsultationRepository = () => ({
  findById: vi.fn(),
});

const createMockSummaryMetaRepository = () => ({
  create: vi.fn().mockResolvedValue({ id: 'meta-comprehensive-1' }),
});

const createMockNamedEntityRepository = () => ({
  findByContextItem: vi.fn().mockResolvedValue([]),
});

const createMockHttpService = () => ({
  axiosRef: {
    post: vi.fn(),
  },
});

const createMockConfigService = () => ({
  get: vi.fn().mockImplementation((key: string) => {
    if (key === 'TEXT_URL') return 'http://smr:8862';
    return undefined;
  }),
});

const createMockPromptResolutionService = () => ({
  resolve: vi.fn().mockResolvedValue({
    template: 'comprehensive',
    promptId: 'prompt_default',
    contextVariables: {},
    resolvedFrom: 'default',
    resolutionTrace: { usedDefaults: ['template', 'promptId'] },
  }),
});

const createMockPromptAssemblyService = () => ({
  assemble: vi.fn().mockImplementation((params: { transcript?: string }) =>
    Promise.resolve({
      userPrompt: params.transcript ?? 'assembled prompt text',
      systemPrompt: '',
      hyperparameters: {},
      responseFormat: null,
      resolvedFrom: 'default',
    }),
  ),
});

const createMockJobMetrics = () => ({
  recordJobStart: vi.fn().mockReturnValue(vi.fn().mockReturnValue(5.0)),
  recordJobComplete: vi.fn(),
  recordJobFailed: vi.fn(),
  recordWaitingDuration: vi.fn(),
  recordSmrCallDuration: vi.fn(),
});

// Mock ClsService. See summary.processor.test.ts for the
// rationale.
const createMockClsService = () => {
  const store = new Map<string, unknown>();
  const mock = {
    run: vi.fn((...args: unknown[]) => {
      const callback = (args.length === 1 ? args[0] : args[1]) as () => unknown;
      return callback();
    }),
    runWith: vi.fn((seed: Record<string, unknown>, callback: () => unknown) => {
      for (const [k, v] of Object.entries(seed)) store.set(k, v);
      return callback();
    }),
    set: vi.fn((key: string, value: unknown) => {
      store.set(key, value);
    }),
    get: vi.fn((key?: string) => (key === undefined ? Object.fromEntries(store) : store.get(key))),
    has: vi.fn((key: string) => store.has(key)),
    isActive: vi.fn(() => true),
  };
  return mock;
};

// ============================================
// Test Helpers
// ============================================

const createMockJob = (data: GenerateComprehensiveSummaryJobPayload): Job<GenerateComprehensiveSummaryJobPayload> =>
  ({
    data,
    id: data.jobId,
    name: 'generate',
    timestamp: Date.now(),
  }) as unknown as Job<GenerateComprehensiveSummaryJobPayload>;

const createConsultation = (overrides: Record<string, unknown> = {}) => ({
  id: 'consultation-A',
  tenantId: 'tenant-1',
  patientId: 'patient-1',
  doctorId: 'doctor-A',
  departmentId: 'dept-general',
  appointmentDate: new Date('2026-02-17'),
  parentConsultationId: null,
  metadata: null,
  Doctor: { username: 'Dr. A' },
  Department: { name: 'General Medicine' },
  ...overrides,
});

const createSection = (overrides: Record<string, unknown> = {}) => ({
  consultationId: 'consultation-A',
  department: 'General Medicine',
  doctor: 'Dr. A',
  type: 'summary',
  content: 'Patient presents with headache.',
  createdAt: '2026-02-17T09:00:00.000Z',
  ...overrides,
});

const createDefaultPayload = (overrides: Partial<GenerateComprehensiveSummaryJobPayload> = {}): GenerateComprehensiveSummaryJobPayload => ({
  jobId: 'job-comp-001',
  consultationId: 'consultation-A',
  tenantId: 'tenant-1',
  userId: 'doctor-A',
  request: {
    includeNER: true,
    template: 'comprehensive',
  },
  ...overrides,
});

// ============================================
// Instantiate processor with mocks
// ============================================

function createProcessor() {
  const jobService = createMockJobService();
  const chainSummaryService = createMockChainSummaryService();
  const contextItemRepo = createMockContextItemRepository();
  const consultationRepo = createMockConsultationRepository();
  const summaryMetaRepo = createMockSummaryMetaRepository();
  const namedEntityRepo = createMockNamedEntityRepository();
  const httpService = createMockHttpService();
  const configService = createMockConfigService();
  const promptResolutionService = createMockPromptResolutionService();
  const jobMetrics = createMockJobMetrics();
  const clsService = createMockClsService();

  const promptAssemblyService = createMockPromptAssemblyService();
  const harnessPolicyService = {
    resolveSmrSelection: vi.fn().mockResolvedValue({ provider: 'lm-studio', model: 'resolved-medgemma' }),
  };
  // Doctor-preferred prompt id resolver. Default null keeps existing tests unaffected.
  const configResolver = { resolvePreferredPromptTemplateId: vi.fn().mockResolvedValue(null) };

  const processor = new ComprehensiveSummaryProcessor(
    jobService as any,
    chainSummaryService as any,
    contextItemRepo as any,
    consultationRepo as any,
    summaryMetaRepo as any,
    namedEntityRepo as any,
    httpService as any,
    configService as any,
    promptResolutionService as any,
    promptAssemblyService as any,
    jobMetrics as any,
    clsService as any,
    undefined, // secretsService (@Optional)
    harnessPolicyService as any, // HarnessPolicyService resolver
    configResolver as any, // ConfigResolver (doctor-preferred prompt id)
  );

  return {
    processor,
    jobService,
    chainSummaryService,
    contextItemRepo,
    consultationRepo,
    summaryMetaRepo,
    namedEntityRepo,
    httpService,
    configService,
    promptResolutionService,
    promptAssemblyService,
    jobMetrics,
    clsService,
    harnessPolicyService,
    configResolver,
  };
}

// ============================================
// Tests
// ============================================

describe('ComprehensiveSummaryProcessor', () => {
  let mocks: ReturnType<typeof createProcessor>;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks = createProcessor();
  });

  // ── the SMR call carries the cascade-resolved model ──
  describe('SMR selection', () => {
    it('posts the cascade-resolved provider+model when the request omits a model', async () => {
      const consultation = createConsultation();
      mocks.consultationRepo.findById.mockResolvedValue(consultation);
      mocks.chainSummaryService.resolveLinkedConsultations.mockResolvedValue([consultation]);
      mocks.chainSummaryService.gatherSections.mockResolvedValue([createSection()]);
      mocks.httpService.axiosRef.post.mockResolvedValue({ data: { summary: 'S', modelName: 'm' } });

      await mocks.processor.process(createMockJob(createDefaultPayload({ request: { includeNER: false } })));

      expect(mocks.harnessPolicyService.resolveSmrSelection).toHaveBeenCalled();
      const smrCall = mocks.httpService.axiosRef.post.mock.calls.find((c: unknown[]) => String(c[0]).includes('/api/v1/generate'))!;
      const body = smrCall[1] as { provider?: string; model?: string };
      expect(body.provider).toBe('lm-studio');
      expect(body.model).toBe('resolved-medgemma');
    });
  });

  // ===========================================================================
  // Successful Processing
  // ===========================================================================

  describe('Successful Job Processing', () => {
    const setupSuccessfulJob = (
      overrides: {
        consultations?: any[];
        sections?: any[];
        entities?: Record<string, any[]>;
        smrResponse?: Record<string, unknown>;
      } = {},
    ) => {
      const consultation = createConsultation();
      const consultations = overrides.consultations ?? [consultation];
      const sections = overrides.sections ?? [createSection()];
      const entities = overrides.entities ?? {};
      const smrResponse = overrides.smrResponse ?? {
        summary: 'Comprehensive summary generated.',
        modelName: 'gpt-4o',
        processingTimeMs: 5000,
        inputTokens: 1500,
        outputTokens: 500,
      };

      mocks.consultationRepo.findById.mockResolvedValue(consultation);
      mocks.chainSummaryService.resolveLinkedConsultations.mockResolvedValue(consultations);
      mocks.chainSummaryService.gatherSections.mockResolvedValue(sections);
      mocks.chainSummaryService.gatherNamedEntities.mockResolvedValue(entities);
      mocks.httpService.axiosRef.post.mockResolvedValue({ data: smrResponse });
    };

    it('should process comprehensive summary job end-to-end', async () => {
      const consultationA = createConsultation({ id: 'A' });
      const consultationB = createConsultation({ id: 'B', Department: { name: 'Hematology' }, Doctor: { username: 'Dr. B' } });

      setupSuccessfulJob({
        consultations: [consultationA, consultationB],
        sections: [
          createSection({ consultationId: 'A', content: 'Summary from Dr. A.' }),
          createSection({ consultationId: 'B', department: 'Hematology', doctor: 'Dr. B', content: 'Summary from Dr. B.' }),
        ],
        entities: {
          MEDICATION: [{ text: 'Aspirin 75mg', confidence: 0.95, sourceConsultationId: 'A' }],
          CONDITION: [{ text: 'Hypertension', confidence: 0.92, sourceConsultationId: 'B' }],
        },
      });

      const result = await mocks.processor.process(createMockJob(createDefaultPayload()));

      expect(result.contextItemId).toBe('ctx-comprehensive-1');
      expect(result.content).toBe('Comprehensive summary generated.');
      expect(result.sourceConsultationIds).toEqual(expect.arrayContaining(['A', 'B']));
      expect(result.sectionCount).toBe(2);
      expect(result.summaryMeta).toEqual({
        aiModelId: 'gpt-4o',
        processingTimeMs: 5000,
        inputTokens: 1500,
        outputTokens: 500,
      });
      expect(result.namedEntities).toEqual({
        MEDICATION: [{ text: 'Aspirin 75mg', confidence: 0.95, sourceConsultationId: 'A' }],
        CONDITION: [{ text: 'Hypertension', confidence: 0.92, sourceConsultationId: 'B' }],
      });
    });

    it('should notify progress at all 6 steps', async () => {
      setupSuccessfulJob();

      await mocks.processor.process(createMockJob(createDefaultPayload()));

      expect(mocks.jobService.notifyProgress).toHaveBeenCalledTimes(5); // steps 1-5 (100% is via notifyComplete)
      expect(mocks.jobService.notifyProgress).toHaveBeenNthCalledWith(1, 'job-comp-001', 10, 'Resolving linked consultations');
      expect(mocks.jobService.notifyProgress).toHaveBeenNthCalledWith(2, 'job-comp-001', 25, 'Gathering content from linked consultations');
      expect(mocks.jobService.notifyProgress).toHaveBeenNthCalledWith(3, 'job-comp-001', 40, 'Gathering named entities');
      expect(mocks.jobService.notifyProgress).toHaveBeenNthCalledWith(4, 'job-comp-001', 60, 'Generating comprehensive summary with AI');
      expect(mocks.jobService.notifyProgress).toHaveBeenNthCalledWith(5, 'job-comp-001', 85, 'Saving results');

      expect(mocks.jobService.notifyComplete).toHaveBeenCalledTimes(1);
    });

    it('should call notifyComplete with the full result', async () => {
      setupSuccessfulJob();

      const result = await mocks.processor.process(createMockJob(createDefaultPayload()));

      expect(mocks.jobService.notifyComplete).toHaveBeenCalledWith('job-comp-001', result);
    });

    it('should call SMR service with correct URL, payload, and 3-minute timeout', async () => {
      setupSuccessfulJob({
        sections: [
          createSection({ content: 'Section A content.' }),
          createSection({ consultationId: 'B', content: 'Section B content.', department: 'Hematology' }),
        ],
      });

      await mocks.processor.process(
        createMockJob(
          createDefaultPayload({
            request: { dnaStyleId: 'my-style', template: 'SOAP', includeNER: false },
          }),
        ),
      );

      const [url, payload, config] = mocks.httpService.axiosRef.post.mock.calls[0];

      expect(url).toBe('http://smr:8862/api/v1/generate');
      expect(payload.prompt).toContain('Section A content.');
      expect(payload.prompt).toContain('Section B content.');
      expect(payload.context).toEqual(
        expect.objectContaining({
          dnaStyleId: 'my-style',
          template: 'SOAP',
          includeNER: false,
          summaryType: 'summary',
          isComprehensiveSummary: true,
        }),
      );
      expect(config.timeout).toBe(180000);
    });

    it('should skip NER gathering when includeNER is false', async () => {
      setupSuccessfulJob();

      await mocks.processor.process(
        createMockJob(
          createDefaultPayload({
            request: { includeNER: false },
          }),
        ),
      );

      expect(mocks.chainSummaryService.gatherNamedEntities).not.toHaveBeenCalled();
    });

    it('should gather NER when includeNER is not explicitly false (default true)', async () => {
      setupSuccessfulJob();

      await mocks.processor.process(
        createMockJob(
          createDefaultPayload({
            request: {},
          }),
        ),
      );

      expect(mocks.chainSummaryService.gatherNamedEntities).toHaveBeenCalled();
    });

    it('should persist ContextItem and SummaryMeta', async () => {
      setupSuccessfulJob();

      await mocks.processor.process(createMockJob(createDefaultPayload()));

      expect(mocks.contextItemRepo.create).toHaveBeenCalledTimes(1);
      expect(mocks.summaryMetaRepo.create).toHaveBeenCalledTimes(1);
    });

    it('should use default SMR URL when not configured', async () => {
      mocks.configService.get.mockReturnValue(undefined);

      const processor = new ComprehensiveSummaryProcessor(
        mocks.jobService as any,
        mocks.chainSummaryService as any,
        mocks.contextItemRepo as any,
        mocks.consultationRepo as any,
        mocks.summaryMetaRepo as any,
        mocks.namedEntityRepo as any,
        mocks.httpService as any,
        mocks.configService as any,
        mocks.promptResolutionService as any,
        mocks.promptAssemblyService as any,
        mocks.jobMetrics as any,
        mocks.clsService as any,
      );

      const consultation = createConsultation();
      mocks.consultationRepo.findById.mockResolvedValue(consultation);
      mocks.chainSummaryService.resolveLinkedConsultations.mockResolvedValue([consultation]);
      mocks.chainSummaryService.gatherSections.mockResolvedValue([createSection()]);
      mocks.httpService.axiosRef.post.mockResolvedValue({
        data: { summary: 'Result.' },
      });

      await processor.process(createMockJob(createDefaultPayload({ request: { includeNER: false } })));

      expect(mocks.httpService.axiosRef.post).toHaveBeenCalledWith('http://localhost:8862/api/v1/generate', expect.any(Object), expect.any(Object));
    });

    it('should include section headers with department, doctor, type in SMR text', async () => {
      setupSuccessfulJob({
        sections: [
          createSection({
            department: 'Cardiology',
            doctor: 'Dr. Heart',
            type: 'transcript',
            content: 'Patient has chest pain.',
            createdAt: '2026-02-17T08:30:00Z',
          }),
        ],
      });

      await mocks.processor.process(createMockJob(createDefaultPayload({ request: { includeNER: false } })));

      const payload = mocks.httpService.axiosRef.post.mock.calls[0][1];
      expect(payload.prompt).toContain('--- Section 1 ---');
      expect(payload.prompt).toContain('Department: Cardiology');
      expect(payload.prompt).toContain('Doctor: Dr. Heart');
      expect(payload.prompt).toContain('Type: transcript');
      expect(payload.prompt).toContain('Date: 2026-02-17T08:30:00Z');
      expect(payload.prompt).toContain('Patient has chest pain.');
    });

    it('should append NER context block when entities exist', async () => {
      setupSuccessfulJob({
        entities: {
          MEDICATION: [
            { text: 'Aspirin 75mg', confidence: 0.95, sourceConsultationId: 'A' },
            { text: 'Metformin 500mg', confidence: 0.92, sourceConsultationId: 'B' },
          ],
          CONDITION: [{ text: 'Hypertension', confidence: 0.98, sourceConsultationId: 'A' }],
        },
      });

      await mocks.processor.process(createMockJob(createDefaultPayload()));

      const payload = mocks.httpService.axiosRef.post.mock.calls[0][1];
      expect(payload.prompt).toContain('--- Named Entities (auto-extracted) ---');
      expect(payload.prompt).toContain('MEDICATION: Aspirin 75mg, Metformin 500mg');
      expect(payload.prompt).toContain('CONDITION: Hypertension');
    });

    it('should default template to comprehensive when not specified', async () => {
      setupSuccessfulJob();

      await mocks.processor.process(
        createMockJob(
          createDefaultPayload({
            request: { includeNER: false },
          }),
        ),
      );

      const payload = mocks.httpService.axiosRef.post.mock.calls[0][1];
      expect(payload.context.template).toBe('comprehensive');
    });

    it('should pass sourceConsultationCount in options', async () => {
      const consultationA = createConsultation({ id: 'A' });
      const consultationB = createConsultation({ id: 'B' });
      const consultationC = createConsultation({ id: 'C' });

      setupSuccessfulJob({
        consultations: [consultationA, consultationB, consultationC],
        sections: [createSection({ consultationId: 'A' }), createSection({ consultationId: 'B' }), createSection({ consultationId: 'C' })],
      });

      await mocks.processor.process(createMockJob(createDefaultPayload({ request: { includeNER: false } })));

      const payload = mocks.httpService.axiosRef.post.mock.calls[0][1];
      expect(payload.context.sourceConsultationCount).toBe(3);
      expect(payload.context.sectionCount).toBe(3);
    });

    it('should handle SMR returning partial response (no modelName)', async () => {
      setupSuccessfulJob({
        smrResponse: { summary: 'Minimal response.' },
      });

      const result = await mocks.processor.process(createMockJob(createDefaultPayload({ request: { includeNER: false } })));

      expect(result.summaryMeta).toEqual({
        aiModelId: undefined,
        processingTimeMs: undefined,
        inputTokens: undefined,
        outputTokens: undefined,
      });
    });
  });

  // ===========================================================================
  // Error Handling
  // ===========================================================================

  describe('Error Handling', () => {
    it('should fail and notify when consultation not found', async () => {
      mocks.consultationRepo.findById.mockResolvedValue(null);

      const payload = createDefaultPayload();
      await expect(mocks.processor.process(createMockJob(payload))).rejects.toThrow('Consultation consultation-A not found');

      expect(mocks.jobService.notifyFailed).toHaveBeenCalledWith('job-comp-001', 'Consultation consultation-A not found');
    });

    it('should fail when no linked consultations found', async () => {
      mocks.consultationRepo.findById.mockResolvedValue(createConsultation());
      mocks.chainSummaryService.resolveLinkedConsultations.mockResolvedValue([]);

      await expect(mocks.processor.process(createMockJob(createDefaultPayload()))).rejects.toThrow(
        'No linked consultations found for comprehensive summary',
      );

      expect(mocks.jobService.notifyFailed).toHaveBeenCalledWith('job-comp-001', 'No linked consultations found for comprehensive summary');
    });

    it('should fail when no content available across consultations', async () => {
      mocks.consultationRepo.findById.mockResolvedValue(createConsultation());
      mocks.chainSummaryService.resolveLinkedConsultations.mockResolvedValue([createConsultation()]);
      mocks.chainSummaryService.gatherSections.mockResolvedValue([]);

      await expect(mocks.processor.process(createMockJob(createDefaultPayload()))).rejects.toThrow(
        'No content available across linked consultations',
      );

      expect(mocks.jobService.notifyFailed).toHaveBeenCalledWith('job-comp-001', 'No content available across linked consultations');
    });

    it('should fail when SMR service returns error', async () => {
      mocks.consultationRepo.findById.mockResolvedValue(createConsultation());
      mocks.chainSummaryService.resolveLinkedConsultations.mockResolvedValue([createConsultation()]);
      mocks.chainSummaryService.gatherSections.mockResolvedValue([createSection()]);
      mocks.httpService.axiosRef.post.mockRejectedValue(new Error('Connection refused'));

      await expect(mocks.processor.process(createMockJob(createDefaultPayload({ request: { includeNER: false } })))).rejects.toThrow(
        'Failed to generate comprehensive summary from AI service',
      );

      expect(mocks.jobService.notifyFailed).toHaveBeenCalledWith('job-comp-001', 'Failed to generate comprehensive summary from AI service');
    });

    it('should fail when SMR service times out', async () => {
      mocks.consultationRepo.findById.mockResolvedValue(createConsultation());
      mocks.chainSummaryService.resolveLinkedConsultations.mockResolvedValue([createConsultation()]);
      mocks.chainSummaryService.gatherSections.mockResolvedValue([createSection()]);
      mocks.httpService.axiosRef.post.mockRejectedValue({
        code: 'ETIMEDOUT',
        message: 'timeout of 180000ms exceeded',
      });

      await expect(mocks.processor.process(createMockJob(createDefaultPayload({ request: { includeNER: false } })))).rejects.toThrow(
        'Failed to generate comprehensive summary from AI service',
      );
    });

    it('should fail when context item creation fails', async () => {
      mocks.consultationRepo.findById.mockResolvedValue(createConsultation());
      mocks.chainSummaryService.resolveLinkedConsultations.mockResolvedValue([createConsultation()]);
      mocks.chainSummaryService.gatherSections.mockResolvedValue([createSection()]);
      mocks.httpService.axiosRef.post.mockResolvedValue({
        data: { summary: 'Result.' },
      });
      mocks.contextItemRepo.create.mockRejectedValue(new Error('Database connection lost'));

      await expect(mocks.processor.process(createMockJob(createDefaultPayload({ request: { includeNER: false } })))).rejects.toThrow(
        'Database connection lost',
      );

      expect(mocks.jobService.notifyFailed).toHaveBeenCalledWith('job-comp-001', 'Database connection lost');
    });

    it('should fail when summary meta creation fails', async () => {
      mocks.consultationRepo.findById.mockResolvedValue(createConsultation());
      mocks.chainSummaryService.resolveLinkedConsultations.mockResolvedValue([createConsultation()]);
      mocks.chainSummaryService.gatherSections.mockResolvedValue([createSection()]);
      mocks.httpService.axiosRef.post.mockResolvedValue({
        data: { summary: 'Result.' },
      });
      mocks.summaryMetaRepo.create.mockRejectedValue(new Error('Meta save failed'));

      await expect(mocks.processor.process(createMockJob(createDefaultPayload({ request: { includeNER: false } })))).rejects.toThrow(
        'Meta save failed',
      );
    });

    it('should not call notifyComplete when job fails', async () => {
      mocks.consultationRepo.findById.mockResolvedValue(null);

      await expect(mocks.processor.process(createMockJob(createDefaultPayload()))).rejects.toThrow();

      expect(mocks.jobService.notifyComplete).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // Edge Cases
  // ===========================================================================

  describe('Edge Cases', () => {
    it('should handle single consultation (no chain links)', async () => {
      const consultation = createConsultation();

      mocks.consultationRepo.findById.mockResolvedValue(consultation);
      mocks.chainSummaryService.resolveLinkedConsultations.mockResolvedValue([consultation]);
      mocks.chainSummaryService.gatherSections.mockResolvedValue([createSection({ content: 'Only one consultation.' })]);
      mocks.httpService.axiosRef.post.mockResolvedValue({
        data: { summary: 'Single consultation summary.' },
      });

      const result = await mocks.processor.process(createMockJob(createDefaultPayload({ request: { includeNER: false } })));

      expect(result.sourceConsultationIds).toEqual(['consultation-A']);
      expect(result.sectionCount).toBe(1);
    });

    it('should handle large chain (5+ consultations)', async () => {
      const consultations = Array.from({ length: 5 }, (_, i) => createConsultation({ id: `consultation-${i}`, Department: { name: `Dept-${i}` } }));
      const sections = consultations.map((c, i) =>
        createSection({ consultationId: c.id, content: `Content from dept ${i}.`, department: `Dept-${i}` }),
      );

      mocks.consultationRepo.findById.mockResolvedValue(consultations[0]);
      mocks.chainSummaryService.resolveLinkedConsultations.mockResolvedValue(consultations);
      mocks.chainSummaryService.gatherSections.mockResolvedValue(sections);
      mocks.httpService.axiosRef.post.mockResolvedValue({
        data: { summary: 'Large chain summary.' },
      });

      const result = await mocks.processor.process(createMockJob(createDefaultPayload({ request: { includeNER: false } })));

      expect(result.sourceConsultationIds).toHaveLength(5);
      expect(result.sectionCount).toBe(5);

      const payload = mocks.httpService.axiosRef.post.mock.calls[0][1];
      expect(payload.context.sourceConsultationCount).toBe(5);
    });

    it('should handle empty NER entities map', async () => {
      mocks.consultationRepo.findById.mockResolvedValue(createConsultation());
      mocks.chainSummaryService.resolveLinkedConsultations.mockResolvedValue([createConsultation()]);
      mocks.chainSummaryService.gatherSections.mockResolvedValue([createSection()]);
      mocks.chainSummaryService.gatherNamedEntities.mockResolvedValue({});
      mocks.httpService.axiosRef.post.mockResolvedValue({
        data: { summary: 'Result.' },
      });

      const result = await mocks.processor.process(createMockJob(createDefaultPayload()));

      // NER block should not appear in text when empty
      const payload = mocks.httpService.axiosRef.post.mock.calls[0][1];
      expect(payload.prompt).not.toContain('Named Entities');
      expect(result.namedEntities).toEqual({});
    });

    it('should pass custom options through to SMR service', async () => {
      mocks.consultationRepo.findById.mockResolvedValue(createConsultation());
      mocks.chainSummaryService.resolveLinkedConsultations.mockResolvedValue([createConsultation()]);
      mocks.chainSummaryService.gatherSections.mockResolvedValue([createSection()]);
      mocks.httpService.axiosRef.post.mockResolvedValue({
        data: { summary: 'Result.' },
      });

      await mocks.processor.process(
        createMockJob(
          createDefaultPayload({
            request: {
              includeNER: false,
              options: { maxTokens: 4000, temperature: 0.7, customField: 'test' },
            },
          }),
        ),
      );

      const payload = mocks.httpService.axiosRef.post.mock.calls[0][1];
      expect(payload.context.maxTokens).toBe(4000);
      expect(payload.context.temperature).toBe(0.7);
      expect(payload.context.customField).toBe('test');
      expect(payload.context.isComprehensiveSummary).toBe(true);
    });

    it('should pass correct dnaStyleId to ContextItemFactory', async () => {
      const { ContextItemFactory } = await import('@arcaai/domains');

      mocks.consultationRepo.findById.mockResolvedValue(createConsultation());
      mocks.chainSummaryService.resolveLinkedConsultations.mockResolvedValue([createConsultation()]);
      mocks.chainSummaryService.gatherSections.mockResolvedValue([createSection()]);
      mocks.httpService.axiosRef.post.mockResolvedValue({
        data: { summary: 'Custom style result.' },
      });

      await mocks.processor.process(
        createMockJob(
          createDefaultPayload({
            request: {
              dnaStyleId: 'style_DNA_dept_hematology',
              includeNER: false,
            },
          }),
        ),
      );

      expect(ContextItemFactory.CreateRawSummary).toHaveBeenCalledWith(
        'tenant-1',
        'consultation-A',
        'Custom style result.',
        'style_DNA_dept_hematology',
        'doctor-A',
      );
    });

    it('should handle non-Error thrown by chain summary service', async () => {
      mocks.consultationRepo.findById.mockResolvedValue(createConsultation());
      mocks.chainSummaryService.resolveLinkedConsultations.mockRejectedValue('string error');

      await expect(mocks.processor.process(createMockJob(createDefaultPayload()))).rejects.toBe('string error');

      expect(mocks.jobService.notifyFailed).toHaveBeenCalledWith('job-comp-001', 'string error');
    });
  });

  // ===========================================================================
  // PromptResolutionService Fallback
  // ===========================================================================

  describe('PromptResolutionService Fallback', () => {
    const setupForFallbackTest = () => {
      const consultation = createConsultation();
      mocks.consultationRepo.findById.mockResolvedValue(consultation);
      mocks.chainSummaryService.resolveLinkedConsultations.mockResolvedValue([consultation]);
      mocks.chainSummaryService.gatherSections.mockResolvedValue([createSection()]);
      mocks.httpService.axiosRef.post.mockResolvedValue({
        data: { summary: 'Result with fallback.' },
      });
    };

    it('should call PromptResolutionService when template not provided', async () => {
      setupForFallbackTest();
      mocks.promptResolutionService.resolve.mockResolvedValue({
        template: 'narrative',
        promptId: 'prompt_default',
        contextVariables: {},
        resolvedFrom: 'department',
        resolutionTrace: { usedDefaults: [] },
      });

      await mocks.processor.process(
        createMockJob(
          createDefaultPayload({
            request: { includeNER: false },
          }),
        ),
      );

      expect(mocks.promptResolutionService.resolve).toHaveBeenCalledWith(
        expect.objectContaining({
          departmentId: 'dept-general',
          explicitTemplate: undefined,
        }),
      );
      expect(mocks.promptResolutionService.resolve).toHaveBeenCalledTimes(1);

      const textPayload = mocks.httpService.axiosRef.post.mock.calls[0][1];
      expect(textPayload.context?.template).toBe('narrative');
    });

    it('should not call PromptResolutionService when template is provided', async () => {
      setupForFallbackTest();

      await mocks.processor.process(
        createMockJob(
          createDefaultPayload({
            request: { dnaStyleId: 'explicit-style', template: 'SOAP', includeNER: false },
          }),
        ),
      );

      expect(mocks.promptResolutionService.resolve).not.toHaveBeenCalled();

      const textPayload = mocks.httpService.axiosRef.post.mock.calls[0][1];
      expect(textPayload.context).toEqual(
        expect.objectContaining({
          dnaStyleId: 'explicit-style',
          template: 'SOAP',
        }),
      );
    });

    it('should resolve template from PromptResolutionService when not provided', async () => {
      setupForFallbackTest();
      mocks.promptResolutionService.resolve.mockResolvedValue({
        template: 'narrative',
        promptId: 'prompt_default',
        contextVariables: {},
        resolvedFrom: 'department',
        resolutionTrace: { usedDefaults: [] },
      });

      await mocks.processor.process(
        createMockJob(
          createDefaultPayload({
            request: { includeNER: false },
          }),
        ),
      );

      const textPayload = mocks.httpService.axiosRef.post.mock.calls[0][1];
      expect(textPayload.context?.template).toBe('narrative');
    });
  });

  // ===========================================================================
  // Realistic Multi-Department Workflow
  // ===========================================================================

  describe('Realistic Multi-Department Workflow', () => {
    it('should process a 3-department consultation chain', async () => {
      const consultationA = createConsultation({ id: 'A', Department: { name: 'General Medicine' } });
      const consultationB = createConsultation({ id: 'B', Department: { name: 'Hematology' }, Doctor: { username: 'Dr. B' } });
      const consultationC = createConsultation({ id: 'C', Department: { name: 'Laboratory' }, Doctor: { username: 'Lab Tech' } });

      mocks.consultationRepo.findById.mockResolvedValue(consultationA);
      mocks.chainSummaryService.resolveLinkedConsultations.mockResolvedValue([consultationA, consultationB, consultationC]);
      mocks.chainSummaryService.gatherSections.mockResolvedValue([
        createSection({ consultationId: 'A', department: 'General Medicine', type: 'summary', content: 'Summary from Gen Med.' }),
        createSection({ consultationId: 'B', department: 'Hematology', type: 'summary', content: 'Hematology findings.' }),
        createSection({ consultationId: 'C', department: 'Laboratory', type: 'transcript', content: 'Lab results: CBC normal.' }),
        createSection({ consultationId: 'A', department: 'General Medicine', type: 'case_note', content: 'Previous visit notes.' }),
      ]);
      mocks.chainSummaryService.gatherNamedEntities.mockResolvedValue({
        MEDICATION: [
          { text: 'Aspirin 75mg', confidence: 0.95, sourceConsultationId: 'A' },
          { text: 'Metformin 500mg', confidence: 0.92, sourceConsultationId: 'B' },
        ],
        CONDITION: [
          { text: 'Hypertension', confidence: 0.98, sourceConsultationId: 'A' },
          { text: 'Type 2 Diabetes', confidence: 0.96, sourceConsultationId: 'B' },
        ],
        PROCEDURE: [{ text: 'CBC', confidence: 0.99, sourceConsultationId: 'C' }],
      });

      mocks.httpService.axiosRef.post.mockResolvedValue({
        data: {
          summary: 'Comprehensive multi-department summary covering General Medicine, Hematology, and Lab findings.',
          modelName: 'gpt-4o',
          processingTimeMs: 8500,
          inputTokens: 3000,
          outputTokens: 800,
        },
      });

      const result = await mocks.processor.process(createMockJob(createDefaultPayload()));

      // Verify result
      expect(result.sourceConsultationIds).toHaveLength(3);
      expect(result.sectionCount).toBe(4);
      expect(result.content).toContain('multi-department');
      expect(result.namedEntities?.MEDICATION).toHaveLength(2);
      expect(result.namedEntities?.CONDITION).toHaveLength(2);
      expect(result.namedEntities?.PROCEDURE).toHaveLength(1);
      expect(result.summaryMeta?.aiModelId).toBe('gpt-4o');
      expect(result.summaryMeta?.processingTimeMs).toBe(8500);

      // Verify SMR was called with all sections
      const textPayload = mocks.httpService.axiosRef.post.mock.calls[0][1];
      expect(textPayload.prompt).toContain('Summary from Gen Med.');
      expect(textPayload.prompt).toContain('Hematology findings.');
      expect(textPayload.prompt).toContain('Lab results: CBC normal.');
      expect(textPayload.prompt).toContain('Previous visit notes.');
      expect(textPayload.prompt).toContain('MEDICATION: Aspirin 75mg, Metformin 500mg');
      expect(textPayload.prompt).toContain('PROCEDURE: CBC');

      // Verify full progress lifecycle
      expect(mocks.jobService.notifyProgress).toHaveBeenCalledTimes(5);
      expect(mocks.jobService.notifyComplete).toHaveBeenCalledTimes(1);
      expect(mocks.jobService.notifyFailed).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // CLS rebind + tenant assert + fail-closed guard
  // ===========================================================================

  describe('CLS rebind + tenant assert', () => {
    const setupSuccessfulJob = (consultationOverrides: Record<string, unknown> = {}) => {
      const consultation = createConsultation(consultationOverrides);
      mocks.consultationRepo.findById.mockResolvedValue(consultation);
      mocks.chainSummaryService.resolveLinkedConsultations.mockResolvedValue([consultation]);
      mocks.chainSummaryService.gatherSections.mockResolvedValue([createSection()]);
      mocks.httpService.axiosRef.post.mockResolvedValue({
        data: { summary: 'Comprehensive summary' },
      });
    };

    it('wraps process() in cls.run with tenantId + user set before any work runs', async () => {
      setupSuccessfulJob({ tenantId: 'tenant-A' });
      const setOrder: Array<[string, unknown]> = [];
      mocks.clsService.set.mockImplementation((key: string, value: unknown) => {
        setOrder.push([key, value]);
      });

      await mocks.processor.process(
        createMockJob(
          createDefaultPayload({
            tenantId: 'tenant-A',
            userId: 'user-A',
            request: { includeNER: false },
          }),
        ),
      );

      expect(mocks.clsService.run).toHaveBeenCalledTimes(1);
      const keys = setOrder.map(([k]) => k);
      expect(keys).toContain('tenantId');
      expect(keys).toContain('user');
      const tenantEntry = setOrder.find(([k]) => k === 'tenantId');
      expect(tenantEntry?.[1]).toBe('tenant-A');
      const userEntry = setOrder.find(([k]) => k === 'user');
      expect(userEntry?.[1]).toMatchObject({ id: 'user-A', tenantId: 'tenant-A' });
    });

    it('throws fail-closed when job.data.tenantId is missing', async () => {
      const payload = {
        jobId: 'job-no-tenant',
        consultationId: 'consultation-A',
        userId: 'user-1',
        request: { includeNER: false },
      } as unknown as GenerateComprehensiveSummaryJobPayload;

      await expect(mocks.processor.process(createMockJob(payload))).rejects.toThrow(/tenantId/i);
      expect(mocks.consultationRepo.findById).not.toHaveBeenCalled();
    });

    it('throws when loaded consultation.tenantId differs from job.data.tenantId', async () => {
      setupSuccessfulJob({ tenantId: 'tenant-OTHER' });

      await expect(
        mocks.processor.process(
          createMockJob(
            createDefaultPayload({
              tenantId: 'tenant-A',
              userId: 'user-A',
              request: { includeNER: false },
            }),
          ),
        ),
      ).rejects.toThrow();

      expect(mocks.contextItemRepo.create).not.toHaveBeenCalled();
      expect(mocks.jobService.notifyFailed).toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // Thread the requesting doctor's preferred prompt template id into
  // BOTH prompt resolution and assembly (this async path previously dropped it).
  // ===========================================================================

  describe('preferred-prompt threading', () => {
    const setupSuccessfulJob = () => {
      const consultation = createConsultation();
      mocks.consultationRepo.findById.mockResolvedValue(consultation);
      mocks.chainSummaryService.resolveLinkedConsultations.mockResolvedValue([consultation]);
      mocks.chainSummaryService.gatherSections.mockResolvedValue([createSection()]);
      mocks.httpService.axiosRef.post.mockResolvedValue({ data: { summary: 'Result.' } });
    };

    it('threads the preferred prompt id into promptResolutionService.resolve when template is omitted', async () => {
      setupSuccessfulJob();
      mocks.configResolver.resolvePreferredPromptTemplateId.mockResolvedValue('tpl-preferred');

      // request omits `template`, so the resolve() branch runs.
      await mocks.processor.process(createMockJob(createDefaultPayload({ request: { includeNER: false } })));

      expect(mocks.promptResolutionService.resolve).toHaveBeenCalledWith(expect.objectContaining({ preferredPromptTemplateId: 'tpl-preferred' }));
    });

    it('threads the preferred prompt id into promptAssemblyService.assemble', async () => {
      setupSuccessfulJob();
      mocks.configResolver.resolvePreferredPromptTemplateId.mockResolvedValue('tpl-preferred');

      await mocks.processor.process(createMockJob(createDefaultPayload({ request: { includeNER: false } })));

      expect(mocks.promptAssemblyService.assemble).toHaveBeenCalledWith(expect.objectContaining({ preferredPromptTemplateId: 'tpl-preferred' }));
    });

    it('resolves the preferred prompt id from the requesting consultation doctorId', async () => {
      setupSuccessfulJob();
      mocks.configResolver.resolvePreferredPromptTemplateId.mockResolvedValue('tpl-preferred');

      await mocks.processor.process(createMockJob(createDefaultPayload({ request: { includeNER: false } })));

      expect(mocks.configResolver.resolvePreferredPromptTemplateId).toHaveBeenCalledWith('doctor-A');
    });
  });

  // ── F-031 remainder: the comprehensive-summary ContextItem must be
  // encrypted before persist, or its clinical text silently vanishes at rest
  // (the plaintext `content` column was dropped; only `encryptedContent` persists).
  describe('comprehensive summary content encryption-at-rest (F-031)', () => {
    const secretsStub = { encrypt: vi.fn(), decrypt: vi.fn(), getSecretOptional: vi.fn().mockResolvedValue('') };

    function createProcessorWithSecrets() {
      const jobService = createMockJobService();
      const chainSummaryService = createMockChainSummaryService();
      const contextItemRepo = createMockContextItemRepository();
      const consultationRepo = createMockConsultationRepository();
      const summaryMetaRepo = createMockSummaryMetaRepository();
      const namedEntityRepo = createMockNamedEntityRepository();
      const httpService = createMockHttpService();
      const configService = createMockConfigService();
      const promptResolutionService = createMockPromptResolutionService();
      const jobMetrics = createMockJobMetrics();
      const clsService = createMockClsService();
      const promptAssemblyService = createMockPromptAssemblyService();

      const processor = new ComprehensiveSummaryProcessor(
        jobService as any,
        chainSummaryService as any,
        contextItemRepo as any,
        consultationRepo as any,
        summaryMetaRepo as any,
        namedEntityRepo as any,
        httpService as any,
        configService as any,
        promptResolutionService as any,
        promptAssemblyService as any,
        jobMetrics as any,
        clsService as any,
        secretsStub as any,
      );

      return { processor, contextItemRepo, consultationRepo, chainSummaryService, httpService };
    }

    it('encrypts the generated comprehensive-summary content before persisting', async () => {
      const withSecrets = createProcessorWithSecrets();
      withSecrets.consultationRepo.findById.mockResolvedValue(createConsultation());
      withSecrets.chainSummaryService.resolveLinkedConsultations.mockResolvedValue([createConsultation()]);
      withSecrets.chainSummaryService.gatherSections.mockResolvedValue([createSection()]);
      withSecrets.chainSummaryService.gatherNamedEntities.mockResolvedValue({});
      withSecrets.httpService.axiosRef.post.mockResolvedValue({
        data: { summary: 'Comprehensive summary generated.', modelName: 'gpt-4o' },
      });

      await withSecrets.processor.process(createMockJob(createDefaultPayload()));

      expect(withSecrets.contextItemRepo.encryptContentIntoEntity).toHaveBeenCalledTimes(1);
      const [entityArg, secretsArg] = withSecrets.contextItemRepo.encryptContentIntoEntity.mock.calls[0];
      expect(entityArg.content).toBe('Comprehensive summary generated.');
      expect(secretsArg).toBe(secretsStub);
      const encOrder = withSecrets.contextItemRepo.encryptContentIntoEntity.mock.invocationCallOrder[0];
      const createOrder = withSecrets.contextItemRepo.create.mock.invocationCallOrder[0];
      expect(encOrder).toBeLessThan(createOrder);
      expect(withSecrets.contextItemRepo.create.mock.calls[0][0]).toBe(entityArg);
    });

    it('still persists (without ciphertext) when no SecretsService is wired', async () => {
      mocks.consultationRepo.findById.mockResolvedValue(createConsultation());
      mocks.chainSummaryService.resolveLinkedConsultations.mockResolvedValue([createConsultation()]);
      mocks.chainSummaryService.gatherSections.mockResolvedValue([createSection()]);
      mocks.chainSummaryService.gatherNamedEntities.mockResolvedValue({});
      mocks.httpService.axiosRef.post.mockResolvedValue({
        data: { summary: 'No cipher wired.', modelName: 'gpt-4o' },
      });

      await mocks.processor.process(createMockJob(createDefaultPayload()));

      expect(mocks.contextItemRepo.encryptContentIntoEntity).not.toHaveBeenCalled();
    });
  });

  // ── TASK-704 — comprehensive-summary has no harness equivalent; the seam
  // call is logging-only and never blocks/short-circuits generation ──
  describe('TASK-704 NoteGenerationService seam', () => {
    const buildProcessorWithSeam = (noteGenerationService: { generate: ReturnType<typeof vi.fn> } | undefined) => {
      const jobService = createMockJobService();
      const chainSummaryService = createMockChainSummaryService();
      const contextItemRepo = createMockContextItemRepository();
      const consultationRepo = createMockConsultationRepository();
      const summaryMetaRepo = createMockSummaryMetaRepository();
      const namedEntityRepo = createMockNamedEntityRepository();
      const httpService = createMockHttpService();
      const configService = createMockConfigService();
      const promptResolutionService = createMockPromptResolutionService();
      const jobMetrics = createMockJobMetrics();
      const clsService = createMockClsService();
      const promptAssemblyService = createMockPromptAssemblyService();

      const processor = new ComprehensiveSummaryProcessor(
        jobService as any,
        chainSummaryService as any,
        contextItemRepo as any,
        consultationRepo as any,
        summaryMetaRepo as any,
        namedEntityRepo as any,
        httpService as any,
        configService as any,
        promptResolutionService as any,
        promptAssemblyService as any,
        jobMetrics as any,
        clsService as any,
        undefined, // secretsService
        undefined, // harnessPolicyService
        undefined, // configResolver
        undefined, // usageLedgerService
        undefined, // unitOfWorkService
        noteGenerationService as any,
      );

      return { processor, chainSummaryService, contextItemRepo, consultationRepo, httpService };
    };

    const primeLegacyGeneration = (mocks: ReturnType<typeof buildProcessorWithSeam>) => {
      mocks.consultationRepo.findById.mockResolvedValue(createConsultation());
      mocks.chainSummaryService.resolveLinkedConsultations.mockResolvedValue([createConsultation()]);
      mocks.chainSummaryService.gatherSections.mockResolvedValue([createSection()]);
      mocks.chainSummaryService.gatherNamedEntities.mockResolvedValue({});
      mocks.httpService.axiosRef.post.mockResolvedValue({ data: { summary: 'Result.', modelName: 'gpt-4o' } });
    };

    it('calls the seam with COMPREHENSIVE_SUMMARY and generates unaffected by the decision', async () => {
      const noteGenerationService = { generate: vi.fn().mockResolvedValue({ generator: 'legacy', reason: 'harness-not-supported-for-trigger' }) };
      const seamMocks = buildProcessorWithSeam(noteGenerationService);
      primeLegacyGeneration(seamMocks);

      const result = await seamMocks.processor.process(createMockJob(createDefaultPayload()));

      expect(noteGenerationService.generate).toHaveBeenCalledWith(
        'COMPREHENSIVE_SUMMARY',
        expect.objectContaining({ consultationId: 'consultation-A', tenantId: 'tenant-1' }),
      );
      expect(result.contextItemId).toBe('ctx-comprehensive-1');
    });

    it('falls back to legacy generation when noteGenerationService is not wired (pre-TASK-704 fixtures)', async () => {
      const seamMocks = buildProcessorWithSeam(undefined);
      primeLegacyGeneration(seamMocks);

      const result = await seamMocks.processor.process(createMockJob(createDefaultPayload()));

      expect(result.contextItemId).toBe('ctx-comprehensive-1');
    });
  });
});
