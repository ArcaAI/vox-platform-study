/**
 * ComprehensiveSummaryProcessor.callTextService — explicit tenant id
 *
 * `resolveTextSelection()` used to be called with NO tenantId, relying on
 * `HarnessPolicyService`'s own CLS fallback. `callTextService` now takes the
 * job's already fail-closed-validated `tenantId` as an EXPLICIT parameter
 * (TypeScript-required, no longer optional/implicit) and passes it straight
 * through to `resolveTextSelection(tenantId, 'finalize')`.
 */

import { describe, it, expect, vi } from 'vitest';
import { Job } from 'bullmq';
import { ComprehensiveSummaryProcessor } from '../processors/comprehensive-summary.processor';
import { GenerateComprehensiveSummaryJobPayload } from '../dto';

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
    SummaryMetaFactory: { CreateSummaryMeta: vi.fn((props) => ({ id: 'meta-comprehensive-1', ...props })) },
  };
});

const createMockClsService = () => {
  const store = new Map<string, unknown>();
  return {
    run: vi.fn((...args: unknown[]) => {
      const callback = (args.length === 1 ? args[0] : args[1]) as () => unknown;
      return callback();
    }),
    set: vi.fn((key: string, value: unknown) => store.set(key, value)),
    get: vi.fn((key?: string) => (key === undefined ? Object.fromEntries(store) : store.get(key))),
    has: vi.fn((key: string) => store.has(key)),
    isActive: vi.fn(() => true),
  };
};

const createMockJob = (data: GenerateComprehensiveSummaryJobPayload): Job<GenerateComprehensiveSummaryJobPayload> =>
  ({ data, id: data.jobId, name: 'generate', timestamp: Date.now() }) as unknown as Job<GenerateComprehensiveSummaryJobPayload>;

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

describe('ComprehensiveSummaryProcessor.callTextService — explicit tenant id (B-04)', () => {
  it('resolves the TEXT selection with the job tenantId + finalize task passed explicitly', async () => {
    const jobService = { notifyProgress: vi.fn(), notifyComplete: vi.fn(), notifyFailed: vi.fn() };
    const chainSummaryService = {
      resolveLinkedConsultations: vi.fn().mockResolvedValue([createConsultation()]),
      gatherSections: vi.fn().mockResolvedValue([
        {
          consultationId: 'consultation-A',
          department: 'General Medicine',
          doctor: 'Dr. A',
          type: 'summary',
          content: 'Patient presents with headache.',
          createdAt: '2026-02-17T09:00:00.000Z',
        },
      ]),
      gatherNamedEntities: vi.fn().mockResolvedValue({}),
    };
    const contextItemRepo = { create: vi.fn().mockImplementation((item) => Promise.resolve(item)), encryptContentIntoEntity: vi.fn().mockResolvedValue(undefined) };
    const consultationRepo = { findById: vi.fn().mockResolvedValue(createConsultation()) };
    const summaryMetaRepo = {
      create: vi.fn().mockResolvedValue({ id: 'meta-comprehensive-1' }),
      encryptFieldsIntoEntity: vi.fn().mockResolvedValue(undefined),
    };
    const namedEntityRepo = { findByContextItem: vi.fn().mockResolvedValue([]) };
    const httpService = { axiosRef: { post: vi.fn().mockResolvedValue({ data: { summary: 'S', modelName: 'm' } }) } };
    const configService = { get: vi.fn().mockImplementation((key: string) => (key === 'TEXT_URL' ? 'http://text:8862' : undefined)) };
    const promptResolutionService = {
      resolve: vi.fn().mockResolvedValue({ template: 'comprehensive', promptId: 'p', contextVariables: {}, resolvedFrom: 'default' }),
    };
    const promptAssemblyService = {
      assemble: vi.fn().mockResolvedValue({ userPrompt: 'p', systemPrompt: '', hyperparameters: {}, responseFormat: null, resolvedFrom: 'default' }),
    };
    const jobMetrics = {
      recordJobStart: vi.fn().mockReturnValue(vi.fn()),
      recordJobComplete: vi.fn(),
      recordJobFailed: vi.fn(),
      recordWaitingDuration: vi.fn(),
      recordTextCallDuration: vi.fn(),
    };
    const clsService = createMockClsService();
    const harnessPolicyService = { resolveTextSelection: vi.fn().mockResolvedValue({ provider: 'lm-studio', model: 'resolved-medgemma' }) };
    const configResolver = { resolvePreferredPromptTemplateId: vi.fn().mockResolvedValue(null) };
    const secretsStub = { encrypt: vi.fn(), decrypt: vi.fn(), getSecretOptional: vi.fn().mockResolvedValue('') };

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
      secretsStub as any, // secretsService
      harnessPolicyService as any,
      configResolver as any,
    );

    await processor.process(
      createMockJob({
        jobId: 'job-comp-001',
        consultationId: 'consultation-A',
        tenantId: 'tenant-1',
        userId: 'doctor-A',
        request: { includeNER: false, template: 'comprehensive' },
      } as unknown as GenerateComprehensiveSummaryJobPayload),
    );

    expect(harnessPolicyService.resolveTextSelection).toHaveBeenCalledWith('tenant-1', 'finalize');
  });
});
