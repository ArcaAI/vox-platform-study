/**
 * PreSummaryProcessor Unit Tests
 *
 * Tests for the PreSummaryProcessor that handles async pre-summary generation jobs.
 * The processor gathers case notes from a consultation and calls the SMR service.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Job } from 'bullmq';
import { PreSummaryProcessor } from '../processors/pre-summary.processor';
import { GeneratePreSummaryJobPayload, PreSummaryJobResult } from '../dto';
import { ContextItemType } from '@arcaai/domains';

// Mock consultation job service
const createMockJobService = () => ({
  notifyProgress: vi.fn().mockResolvedValue(undefined),
  notifyComplete: vi.fn().mockResolvedValue(undefined),
  notifyFailed: vi.fn().mockResolvedValue(undefined),
});

// Mock repositories
const createMockContextItemRepository = () => ({
  findById: vi.fn(),
  findByConsultation: vi.fn(),
  create: vi.fn(),
  encryptContentIntoEntity: vi.fn().mockResolvedValue(undefined),
});

const createMockConsultationRepository = () => ({
  findById: vi.fn(),
});

// Mock HTTP service
const createMockHttpService = () => ({
  axiosRef: {
    post: vi.fn(),
  },
});

// Mock config service
const createMockConfigService = () => ({
  get: vi.fn().mockImplementation((key: string) => {
    if (key === 'SMR_URL') return 'http://localhost:8862';
    return undefined;
  }),
});

// Mock PromptResolutionService
const createMockPromptResolutionService = () => ({
  resolve: vi.fn().mockResolvedValue({
    template: 'SOAP',
    promptId: 'prompt_default',
    contextVariables: {},
    resolvedFrom: 'default',
    resolutionTrace: { usedDefaults: ['template', 'promptId', 'contextVariables'] },
  }),
});

// Mock PromptAssemblyService
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

// Mock JobMetricsService
const createMockJobMetrics = () => ({
  recordJobStart: vi.fn().mockReturnValue(vi.fn().mockReturnValue(5.0)),
  recordJobComplete: vi.fn(),
  recordJobFailed: vi.fn(),
  recordWaitingDuration: vi.fn(),
  recordSmrCallDuration: vi.fn(),
});

// Mock ClsService. See summary.processor.test.ts for the
// rationale; this mock runs the cls.run callback inline so existing tests
// stay synchronous and exposes spies for the new D.9 assertions.
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

// Mock ConfigResolver (doctor-preferred prompt id threading).
const createMockConfigResolver = () => ({ resolvePreferredPromptTemplateId: vi.fn().mockResolvedValue(null) });

// =============================================================================
// Realistic Mock Data Factories - These match actual SMR service responses
// =============================================================================

/**
 * Creates a realistic SMR service response that matches the actual API structure.
 * This prevents Anti-Pattern #4: Incomplete Mocks
 */
const createRealisticSmrResponse = (
  overrides: Partial<{
    summary: string;
    llmProvider: string;
    modelName: string;
    processingTimeMs: number;
    inputTokens: number;
    outputTokens: number;
    requestId: string;
    timestamp: string;
  }> = {},
) => ({
  summary: overrides.summary ?? 'Patient presents with chronic headaches. History includes migraines since age 25. Current treatment: Ibuprofen PRN.',
  llmProvider: overrides.llmProvider ?? 'openai',
  modelName: overrides.modelName ?? 'gpt-4-turbo',
  processingTimeMs: overrides.processingTimeMs ?? 2847,
  inputTokens: overrides.inputTokens ?? 156,
  outputTokens: overrides.outputTokens ?? 78,
  requestId: overrides.requestId ?? 'req-abc123',
  timestamp: overrides.timestamp ?? new Date().toISOString(),
});

/**
 * Creates realistic case note content that matches actual medical documentation
 */
const createRealisticCaseNoteContent = (type: 'subjective' | 'objective' | 'assessment' | 'plan' = 'subjective') => {
  const contents: Record<string, string> = {
    subjective:
      'Patient reports persistent headaches for the past 3 weeks. Pain is described as throbbing, primarily in the frontal region. Rates pain as 6/10. Worse in the morning, improves with rest. Denies nausea, vomiting, or visual disturbances.',
    objective:
      'Vitals: BP 128/82, HR 76, Temp 98.6°F. Neurological exam: Alert and oriented x3. Pupils equal and reactive. No focal deficits. Cranial nerves II-XII intact.',
    assessment: 'Tension-type headache, likely stress-related. Differential includes migraine without aura, cervicogenic headache.',
    plan: 'Start ibuprofen 400mg TID with food. Recommend stress management techniques. Follow-up in 2 weeks if no improvement. Return precautions discussed.',
  };
  return contents[type];
};

// Helper to create mock job
const createMockJob = (data: GeneratePreSummaryJobPayload): Job<GeneratePreSummaryJobPayload> =>
  ({
    data,
    id: data.jobId,
    name: 'generate',
    timestamp: Date.now(),
  }) as unknown as Job<GeneratePreSummaryJobPayload>;

// Helper to create mock consultation
const createMockConsultation = (overrides: Partial<any> = {}) => ({
  id: overrides.id ?? 'consultation-123',
  tenantId: overrides.tenantId ?? 'tenant-1',
  patientId: overrides.patientId ?? 'patient-1',
  doctorId: overrides.doctorId ?? 'doctor-1',
  ...overrides,
});

// Helper to create mock context item (case note)
const createMockContextItem = (overrides: Partial<any> = {}) => ({
  id: overrides.id ?? 'ctx-item-123',
  consultationId: overrides.consultationId ?? 'consultation-123',
  type: overrides.type ?? ContextItemType.CASE_NOTE,
  content: overrides.content ?? 'Patient presents with symptoms...',
  tenantId: overrides.tenantId ?? 'tenant-1',
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
});

describe('PreSummaryProcessor', () => {
  let processor: PreSummaryProcessor;
  let mockJobService: ReturnType<typeof createMockJobService>;
  let mockContextItemRepository: ReturnType<typeof createMockContextItemRepository>;
  let mockConsultationRepository: ReturnType<typeof createMockConsultationRepository>;
  let mockHttpService: ReturnType<typeof createMockHttpService>;
  let mockConfigService: ReturnType<typeof createMockConfigService>;
  let mockPromptResolutionService: ReturnType<typeof createMockPromptResolutionService>;
  let mockPromptAssemblyService: ReturnType<typeof createMockPromptAssemblyService>;
  let mockJobMetrics: ReturnType<typeof createMockJobMetrics>;
  let mockClsService: ReturnType<typeof createMockClsService>;
  let mockHarnessPolicyService: { resolveSmrSelection: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.clearAllMocks();

    mockJobService = createMockJobService();
    mockContextItemRepository = createMockContextItemRepository();
    mockConsultationRepository = createMockConsultationRepository();
    mockHttpService = createMockHttpService();
    mockConfigService = createMockConfigService();
    mockPromptResolutionService = createMockPromptResolutionService();
    mockPromptAssemblyService = createMockPromptAssemblyService();
    mockJobMetrics = createMockJobMetrics();
    mockClsService = createMockClsService();
    mockHarnessPolicyService = {
      resolveSmrSelection: vi.fn().mockResolvedValue({ provider: 'lm-studio', model: 'resolved-medgemma' }),
    };

    processor = new PreSummaryProcessor(
      mockJobService as any,
      mockContextItemRepository as any,
      mockConsultationRepository as any,
      mockHttpService as any,
      mockConfigService as any,
      mockPromptResolutionService as any,
      mockPromptAssemblyService as any,
      mockJobMetrics as any,
      mockClsService as any,
      undefined, // secretsService (@Optional)
      mockHarnessPolicyService as any, // HarnessPolicyService resolver
    );
  });

  // ── the pre-summary BullMQ path threads the preferred prompt id ──
  describe('preferred-prompt threading', () => {
    let mockConfigResolver: ReturnType<typeof createMockConfigResolver>;
    let processorWithResolver: PreSummaryProcessor;

    beforeEach(() => {
      mockConfigResolver = createMockConfigResolver();
      processorWithResolver = new PreSummaryProcessor(
        mockJobService as any,
        mockContextItemRepository as any,
        mockConsultationRepository as any,
        mockHttpService as any,
        mockConfigService as any,
        mockPromptResolutionService as any,
        mockPromptAssemblyService as any,
        mockJobMetrics as any,
        mockClsService as any,
        undefined, // secretsService
        mockHarnessPolicyService as any,
        mockConfigResolver as any, // ConfigResolver
      );

      mockConsultationRepository.findById.mockResolvedValue(createMockConsultation({ doctorId: 'dr-1' }));
      mockContextItemRepository.findByConsultation.mockResolvedValue([createMockContextItem({ content: 'case note content' })]);
      mockHttpService.axiosRef.post.mockResolvedValue({ data: { summary: 'S', modelName: 'm' } });
      mockContextItemRepository.create.mockResolvedValue({ id: 'pre-sum-id', content: 'S' });
    });

    it('threads the doctor preferred prompt id into resolve + assemble', async () => {
      mockConfigResolver.resolvePreferredPromptTemplateId.mockResolvedValue('tpl-preferred');

      await processorWithResolver.process(
        createMockJob({
          jobId: 'job-pref',
          consultationId: 'c-1',
          tenantId: 'tenant-1',
          userId: 'user-1',
          request: {},
        } as GeneratePreSummaryJobPayload),
      );

      expect(mockConfigResolver.resolvePreferredPromptTemplateId).toHaveBeenCalledWith('dr-1');
      expect(mockPromptResolutionService.resolve).toHaveBeenCalledWith(expect.objectContaining({ preferredPromptTemplateId: 'tpl-preferred' }));
      expect(mockPromptAssemblyService.assemble).toHaveBeenCalledWith(expect.objectContaining({ preferredPromptTemplateId: 'tpl-preferred' }));
    });
  });

  // ── the SMR call carries the cascade-resolved model ──
  describe('SMR selection', () => {
    it('posts the cascade-resolved provider+model when the request omits a model', async () => {
      mockConsultationRepository.findById.mockResolvedValue(createMockConsultation());
      mockContextItemRepository.findByConsultation.mockResolvedValue([createMockContextItem({ content: 'case note content' })]);
      mockHttpService.axiosRef.post.mockResolvedValue({ data: { summary: 'S', modelName: 'm' } });
      mockContextItemRepository.create.mockResolvedValue({ id: 'pre-sum-1', content: 'S' });

      await processor.process(
        createMockJob({
          jobId: 'job-1',
          consultationId: 'c-1',
          tenantId: 'tenant-1',
          userId: 'user-1',
          request: {},
        } as GeneratePreSummaryJobPayload),
      );

      expect(mockHarnessPolicyService.resolveSmrSelection).toHaveBeenCalled();
      const smrCall = mockHttpService.axiosRef.post.mock.calls.find((c: unknown[]) => String(c[0]).includes('/api/v1/generate'))!;
      const body = smrCall[1] as { provider?: string; model?: string };
      expect(body.provider).toBe('lm-studio');
      expect(body.model).toBe('resolved-medgemma');
    });
  });

  // ===========================================================================
  // Successful Processing Tests
  // ===========================================================================

  describe('Successful Job Processing', () => {
    it('should process pre-summary job with specific caseNoteIds', async () => {
      const caseNote1 = createMockContextItem({ id: 'case-1', content: 'Case note 1 content' });
      const caseNote2 = createMockContextItem({ id: 'case-2', content: 'Case note 2 content' });

      mockConsultationRepository.findById.mockResolvedValue(createMockConsultation());
      mockContextItemRepository.findById.mockResolvedValueOnce(caseNote1).mockResolvedValueOnce(caseNote2);
      mockHttpService.axiosRef.post.mockResolvedValue({
        data: {
          summary: 'Generated pre-summary text',
          modelName: 'gpt-4',
          processingTimeMs: 2500,
          inputTokens: 150,
          outputTokens: 75,
        },
      });
      mockContextItemRepository.create.mockResolvedValue({
        id: 'new-pre-summary-id',
        content: 'Generated pre-summary text',
      });

      const payload: GeneratePreSummaryJobPayload = {
        jobId: 'job-123',
        consultationId: 'consultation-123',
        tenantId: 'tenant-1',
        userId: 'user-1',
        request: {
          caseNoteIds: ['case-1', 'case-2'],
          dnaStyleId: 'style-1',
        },
      };

      const result = await processor.process(createMockJob(payload));

      expect(result).toEqual({
        contextItemId: 'new-pre-summary-id',
        content: 'Generated pre-summary text',
        summaryMeta: {
          aiModelId: 'gpt-4',
          processingTimeMs: 2500,
          inputTokens: 150,
          outputTokens: 75,
        },
      });

      expect(mockJobService.notifyProgress).toHaveBeenCalledTimes(3);
      expect(mockJobService.notifyComplete).toHaveBeenCalledWith('job-123', result);
    });

    it('should process pre-summary job using all case notes when no caseNoteIds provided', async () => {
      const caseNotes = [
        createMockContextItem({ id: 'case-1', content: 'Content 1' }),
        createMockContextItem({ id: 'case-2', content: 'Content 2' }),
        createMockContextItem({ id: 'case-3', content: 'Content 3' }),
      ];

      mockConsultationRepository.findById.mockResolvedValue(createMockConsultation());
      mockContextItemRepository.findByConsultation.mockResolvedValue(caseNotes);
      mockHttpService.axiosRef.post.mockResolvedValue({
        data: {
          summary: 'Generated summary from all notes',
          modelName: 'claude-3',
          processingTimeMs: 3000,
        },
      });
      mockContextItemRepository.create.mockResolvedValue({
        id: 'new-pre-summary-id',
        content: 'Generated summary from all notes',
      });

      const payload: GeneratePreSummaryJobPayload = {
        jobId: 'job-456',
        consultationId: 'consultation-123',
        tenantId: 'tenant-1',
        userId: 'user-1',
        request: {},
      };

      await processor.process(createMockJob(payload));

      expect(mockContextItemRepository.findByConsultation).toHaveBeenCalledWith('consultation-123', { type: ContextItemType.CASE_NOTE });
    });

    it('should send correct payload to SMR service', async () => {
      const caseNote = createMockContextItem({ content: 'Patient symptoms: fever, cough' });

      mockConsultationRepository.findById.mockResolvedValue(createMockConsultation());
      mockContextItemRepository.findByConsultation.mockResolvedValue([caseNote]);
      mockHttpService.axiosRef.post.mockResolvedValue({
        data: { summary: 'Pre-summary', modelName: 'gpt-4' },
      });
      mockContextItemRepository.create.mockResolvedValue({
        id: 'ctx-id',
        content: 'Pre-summary',
      });

      const payload: GeneratePreSummaryJobPayload = {
        jobId: 'job-789',
        consultationId: 'consultation-123',
        tenantId: 'tenant-1',
        userId: 'user-1',
        request: {
          dnaStyleId: 'custom-style',
          options: { temperature: 0.7 },
        },
      };

      await processor.process(createMockJob(payload));

      expect(mockHttpService.axiosRef.post).toHaveBeenCalledWith(
        'http://localhost:8862/api/v1/generate',
        expect.objectContaining({
          prompt: 'Patient symptoms: fever, cough',
          temperature: 0.7,
          context: expect.objectContaining({
            dnaStyleId: 'custom-style',
            summaryType: 'pre-summary',
            temperature: 0.7,
          }),
        }),
        {
          timeout: 120000,
          headers: {
            'Content-Type': 'application/json',
            'X-Service-Token': '',
            'X-Request-ID': 'job-789',
          },
        },
      );
    });

    it('should notify progress at each step', async () => {
      mockConsultationRepository.findById.mockResolvedValue(createMockConsultation());
      mockContextItemRepository.findByConsultation.mockResolvedValue([createMockContextItem({ content: 'Test content' })]);
      mockHttpService.axiosRef.post.mockResolvedValue({
        data: { summary: 'Summary', modelName: 'gpt-4' },
      });
      mockContextItemRepository.create.mockResolvedValue({
        id: 'ctx-id',
        content: 'Summary',
      });

      const payload: GeneratePreSummaryJobPayload = {
        jobId: 'job-progress',
        consultationId: 'consultation-123',
        tenantId: 'tenant-1',
        userId: 'user-1',
        request: {},
      };

      await processor.process(createMockJob(payload));

      expect(mockJobService.notifyProgress).toHaveBeenNthCalledWith(1, 'job-progress', 10, 'Gathering case notes');
      expect(mockJobService.notifyProgress).toHaveBeenNthCalledWith(2, 'job-progress', 30, 'Generating pre-summary with AI');
      expect(mockJobService.notifyProgress).toHaveBeenNthCalledWith(3, 'job-progress', 70, 'Saving results');
    });

    it('should join multiple case notes with double newlines', async () => {
      const caseNotes = [
        createMockContextItem({ content: 'First case note' }),
        createMockContextItem({ content: 'Second case note' }),
        createMockContextItem({ content: 'Third case note' }),
      ];

      mockConsultationRepository.findById.mockResolvedValue(createMockConsultation());
      mockContextItemRepository.findByConsultation.mockResolvedValue(caseNotes);
      mockHttpService.axiosRef.post.mockResolvedValue({
        data: { summary: 'Combined summary', modelName: 'gpt-4' },
      });
      mockContextItemRepository.create.mockResolvedValue({
        id: 'ctx-id',
        content: 'Combined summary',
      });

      const payload: GeneratePreSummaryJobPayload = {
        jobId: 'job-multi',
        consultationId: 'consultation-123',
        tenantId: 'tenant-1',
        userId: 'user-1',
        request: {},
      };

      await processor.process(createMockJob(payload));

      expect(mockHttpService.axiosRef.post).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          prompt: 'First case note\n\nSecond case note\n\nThird case note',
        }),
        expect.any(Object),
      );
    });

    it('should handle partial SMR response without optional metadata', async () => {
      mockConsultationRepository.findById.mockResolvedValue(createMockConsultation());
      mockContextItemRepository.findByConsultation.mockResolvedValue([createMockContextItem({ content: 'Test content' })]);
      mockHttpService.axiosRef.post.mockResolvedValue({
        data: {
          summary: 'Minimal summary',
        },
      });
      mockContextItemRepository.create.mockResolvedValue({
        id: 'ctx-id',
        content: 'Minimal summary',
      });

      const payload: GeneratePreSummaryJobPayload = {
        jobId: 'job-partial-response',
        consultationId: 'consultation-123',
        tenantId: 'tenant-1',
        userId: 'user-1',
        request: {},
      };

      const result = await processor.process(createMockJob(payload));

      expect(result.summaryMeta).toEqual({
        aiModelId: undefined,
        processingTimeMs: undefined,
        inputTokens: undefined,
        outputTokens: undefined,
      });
    });

    it('should handle empty caseNoteIds array', async () => {
      const caseNotes = [createMockContextItem({ content: 'Default case note' })];

      mockConsultationRepository.findById.mockResolvedValue(createMockConsultation());
      mockContextItemRepository.findByConsultation.mockResolvedValue(caseNotes);
      mockHttpService.axiosRef.post.mockResolvedValue({
        data: { summary: 'Summary', modelName: 'gpt-4' },
      });
      mockContextItemRepository.create.mockResolvedValue({
        id: 'ctx-id',
        content: 'Summary',
      });

      const payload: GeneratePreSummaryJobPayload = {
        jobId: 'job-empty-ids',
        consultationId: 'consultation-123',
        tenantId: 'tenant-1',
        userId: 'user-1',
        request: {
          caseNoteIds: [],
        },
      };

      await processor.process(createMockJob(payload));

      expect(mockContextItemRepository.findByConsultation).toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // Behavior Verification Tests (Anti-Pattern #1 Prevention)
  // These tests verify actual output behavior, not just mock interactions
  // ===========================================================================
  // (Behavior verification tests for PreSummaryProcessor can be added here.)

  // ===========================================================================
  // CLS rebind + tenant assert + fail-closed guard
  // ===========================================================================

  describe('CLS rebind + tenant assert', () => {
    const setupSuccessfulJob = (consultationOverrides: Record<string, unknown> = {}) => {
      mockConsultationRepository.findById.mockResolvedValue(createMockConsultation(consultationOverrides));
      mockContextItemRepository.findByConsultation.mockResolvedValue([createMockContextItem({ content: 'case note content' })]);
      mockHttpService.axiosRef.post.mockResolvedValue({
        data: { summary: 'Generated pre-summary', modelName: 'gpt-4' },
      });
      mockContextItemRepository.create.mockResolvedValue({
        id: 'pre-sum-ctx-001',
        content: 'Generated pre-summary',
      });
    };

    it('wraps process() in cls.run with tenantId + user set before any work runs', async () => {
      setupSuccessfulJob({ tenantId: 'tenant-A' });
      const setOrder: Array<[string, unknown]> = [];
      mockClsService.set.mockImplementation((key: string, value: unknown) => {
        setOrder.push([key, value]);
      });

      const payload: GeneratePreSummaryJobPayload = {
        jobId: 'job-cls-1',
        consultationId: 'consultation-123',
        tenantId: 'tenant-A',
        userId: 'user-A',
        request: {},
      };

      await processor.process(createMockJob(payload));

      expect(mockClsService.run).toHaveBeenCalledTimes(1);
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
        consultationId: 'consultation-123',
        userId: 'user-1',
        request: {},
      } as unknown as GeneratePreSummaryJobPayload;

      await expect(processor.process(createMockJob(payload))).rejects.toThrow(/tenantId/i);
      expect(mockConsultationRepository.findById).not.toHaveBeenCalled();
    });

    it('throws when loaded consultation.tenantId differs from job.data.tenantId', async () => {
      setupSuccessfulJob({ tenantId: 'tenant-OTHER' });

      const payload: GeneratePreSummaryJobPayload = {
        jobId: 'job-mismatch',
        consultationId: 'consultation-123',
        tenantId: 'tenant-A',
        userId: 'user-A',
        request: {},
      };

      await expect(processor.process(createMockJob(payload))).rejects.toThrow();
      expect(mockContextItemRepository.create).not.toHaveBeenCalled();
      expect(mockJobService.notifyFailed).toHaveBeenCalled();
    });
  });

  // ── F-031 remainder: the pre-summary ContextItem must be encrypted
  // before persist, or its clinical text silently vanishes at rest (the
  // plaintext `content` column was dropped; only `encryptedContent` persists).
  describe('pre-summary content encryption-at-rest (F-031)', () => {
    const secretsStub = { encrypt: vi.fn(), decrypt: vi.fn(), getSecretOptional: vi.fn().mockResolvedValue('') };

    it('encrypts the generated pre-summary content before persisting', async () => {
      const processorWithSecrets = new PreSummaryProcessor(
        mockJobService as any,
        mockContextItemRepository as any,
        mockConsultationRepository as any,
        mockHttpService as any,
        mockConfigService as any,
        mockPromptResolutionService as any,
        mockPromptAssemblyService as any,
        mockJobMetrics as any,
        mockClsService as any,
        secretsStub as any,
      );

      mockConsultationRepository.findById.mockResolvedValue(createMockConsultation());
      mockContextItemRepository.findByConsultation.mockResolvedValue([createMockContextItem({ content: 'Case note content' })]);
      mockHttpService.axiosRef.post.mockResolvedValue({
        data: { summary: 'Generated pre-summary text', modelName: 'gpt-4' },
      });
      mockContextItemRepository.create.mockResolvedValue({
        id: 'enc-pre-summary-id',
        content: 'Generated pre-summary text',
      });

      await processorWithSecrets.process(
        createMockJob({
          jobId: 'job-enc-1',
          consultationId: 'consultation-123',
          tenantId: 'tenant-1',
          userId: 'user-1',
          request: {},
        }),
      );

      expect(mockContextItemRepository.encryptContentIntoEntity).toHaveBeenCalledTimes(1);
      const [entityArg, secretsArg] = mockContextItemRepository.encryptContentIntoEntity.mock.calls[0];
      expect(entityArg.content).toBe('Generated pre-summary text');
      expect(secretsArg).toBe(secretsStub);
      const encOrder = mockContextItemRepository.encryptContentIntoEntity.mock.invocationCallOrder[0];
      const createOrder = mockContextItemRepository.create.mock.invocationCallOrder[0];
      expect(encOrder).toBeLessThan(createOrder);
      expect(mockContextItemRepository.create.mock.calls[0][0]).toBe(entityArg);
    });

    it('still persists (without ciphertext) when no SecretsService is wired', async () => {
      mockConsultationRepository.findById.mockResolvedValue(createMockConsultation());
      mockContextItemRepository.findByConsultation.mockResolvedValue([createMockContextItem({ content: 'Case note content' })]);
      mockHttpService.axiosRef.post.mockResolvedValue({
        data: { summary: 'No cipher wired', modelName: 'gpt-4' },
      });
      mockContextItemRepository.create.mockResolvedValue({ id: 'no-sec-id', content: 'No cipher wired' });

      await processor.process(
        createMockJob({
          jobId: 'job-no-sec',
          consultationId: 'consultation-123',
          tenantId: 'tenant-1',
          userId: 'user-1',
          request: {},
        }),
      );

      expect(mockContextItemRepository.encryptContentIntoEntity).not.toHaveBeenCalled();
    });
  });

  // ── TASK-704 — pre-summary has no harness equivalent; the seam call is
  // logging-only and never blocks/short-circuits generation ──
  describe('TASK-704 NoteGenerationService seam', () => {
    const createMockNoteGenerationService = () => ({ generate: vi.fn(), resolveConfig: vi.fn() });

    const primeLegacyGeneration = () => {
      mockConsultationRepository.findById.mockResolvedValue(createMockConsultation());
      mockContextItemRepository.findByConsultation.mockResolvedValue([createMockContextItem({ content: 'case note content' })]);
      mockHttpService.axiosRef.post.mockResolvedValue({ data: { summary: 'S', modelName: 'm' } });
      mockContextItemRepository.create.mockResolvedValue({ id: 'pre-sum-seam-id', content: 'S' });
    };

    it('calls the seam with PRE_SUMMARY and generates unaffected by the decision', async () => {
      const mockNoteGenerationService = createMockNoteGenerationService();
      mockNoteGenerationService.generate.mockResolvedValue({ generator: 'legacy', reason: 'harness-not-supported-for-trigger' });
      const processorWithSeam = new PreSummaryProcessor(
        mockJobService as any,
        mockContextItemRepository as any,
        mockConsultationRepository as any,
        mockHttpService as any,
        mockConfigService as any,
        mockPromptResolutionService as any,
        mockPromptAssemblyService as any,
        mockJobMetrics as any,
        mockClsService as any,
        undefined, // secretsService
        undefined, // harnessPolicyService
        undefined, // configResolver
        mockNoteGenerationService as any,
      );
      primeLegacyGeneration();

      const result = await processorWithSeam.process(
        createMockJob({ jobId: 'job-seam', consultationId: 'consultation-123', tenantId: 'tenant-1', userId: 'user-1', request: {} }),
      );

      expect(mockNoteGenerationService.generate).toHaveBeenCalledWith(
        'PRE_SUMMARY',
        expect.objectContaining({ consultationId: 'consultation-123', tenantId: 'tenant-1', userId: 'user-1' }),
      );
      expect(result.contextItemId).toBe('pre-sum-seam-id');
    });

    it('falls back to legacy generation when noteGenerationService is not wired (pre-TASK-704 fixtures)', async () => {
      primeLegacyGeneration();

      // `processor` (top-level beforeEach) has no noteGenerationService.
      const result = await processor.process(
        createMockJob({ jobId: 'job-no-seam', consultationId: 'consultation-123', tenantId: 'tenant-1', userId: 'user-1', request: {} }),
      );

      expect(result.contextItemId).toBe('pre-sum-seam-id');
    });
  });
});
