/**
 * SummaryProcessor.callSmrService — explicit tenant id
 *
 * `resolveSmrSelection()` used to be called with NO tenantId, relying on
 * `HarnessPolicyService`'s own CLS fallback. `callSmrService` now takes the
 * job's already fail-closed-validated `tenantId` as an EXPLICIT parameter
 * (TypeScript-required, no longer optional/implicit) and passes it straight
 * through to `resolveSmrSelection(tenantId, 'finalize')`.
 */

import { describe, it, expect, vi } from 'vitest';
import { Job } from 'bullmq';
import { SummaryProcessor } from '../processors/summary.processor';
import { GenerateSummaryJobPayload } from '../dto';

const createMockClsService = () => {
  const store = new Map<string, unknown>();
  return {
    run: vi.fn((callback: () => unknown) => callback()),
    runWith: vi.fn((seed: Record<string, unknown>, callback: () => unknown) => {
      for (const [k, v] of Object.entries(seed)) store.set(k, v);
      return callback();
    }),
    set: vi.fn((key: string, value: unknown) => store.set(key, value)),
    get: vi.fn((key?: string) => (key === undefined ? Object.fromEntries(store) : store.get(key))),
    has: vi.fn((key: string) => store.has(key)),
    isActive: vi.fn(() => true),
  };
};

const createMockJob = (data: GenerateSummaryJobPayload): Job<GenerateSummaryJobPayload> =>
  ({ data, id: data.jobId, name: 'generate', timestamp: Date.now() }) as unknown as Job<GenerateSummaryJobPayload>;

describe('SummaryProcessor.callSmrService — explicit tenant id (B-04)', () => {
  it('resolves the SMR selection with the job tenantId + finalize task passed explicitly', async () => {
    const mockJobService = { notifyProgress: vi.fn(), notifyComplete: vi.fn(), notifyFailed: vi.fn() };
    const mockContextItemRepository = {
      findById: vi.fn(),
      findTranscripts: vi.fn().mockResolvedValue([{ content: 'transcript text' }]),
      findLatestPreSummary: vi.fn().mockResolvedValue(null),
      // The processor now reads the warm start through the
      // decrypting, subType-aware accessor (B-02/B-06 parity with SummaryService).
      findLatestPreSummaryWithDecryptedContent: vi.fn().mockResolvedValue({ entity: null, plaintext: null }),
      create: vi.fn().mockResolvedValue({ id: 'sid', content: 'S' }),
      encryptContentIntoEntity: vi.fn().mockResolvedValue(undefined),
    };
    const mockConsultationRepository = { findById: vi.fn().mockResolvedValue({ id: 'consultation-123', tenantId: 'tenant-1' }) };
    const mockHttpService = { axiosRef: { post: vi.fn().mockResolvedValue({ data: { summary: 'S', modelName: 'm' } }) } };
    const mockConfigService = { get: vi.fn().mockImplementation((k: string) => (k === 'SMR_URL' ? 'http://localhost:8862' : undefined)) };
    const mockEventEmitter = { emit: vi.fn() };
    const mockPromptResolutionService = {
      resolve: vi.fn().mockResolvedValue({ template: 'SOAP', promptId: 'p', contextVariables: {}, resolvedFrom: 'default' }),
    };
    const mockPromptAssemblyService = {
      assemble: vi.fn().mockResolvedValue({ userPrompt: 'p', systemPrompt: '', hyperparameters: {}, responseFormat: null, resolvedFrom: 'default' }),
    };
    const mockJobMetrics = { recordJobStart: vi.fn().mockReturnValue(vi.fn()), recordJobComplete: vi.fn(), recordJobFailed: vi.fn(), recordWaitingDuration: vi.fn(), recordSmrCallDuration: vi.fn() };
    const mockClsService = createMockClsService();
    const mockHarnessPolicyService = { resolveSmrSelection: vi.fn().mockResolvedValue({ provider: 'lm-studio', model: 'resolved-medgemma' }) };
    const secretsStub = { encrypt: vi.fn(), decrypt: vi.fn(), getSecretOptional: vi.fn().mockResolvedValue('') };

    const processor = new SummaryProcessor(
      mockJobService as any,
      mockContextItemRepository as any,
      mockConsultationRepository as any,
      mockHttpService as any,
      mockConfigService as any,
      mockEventEmitter as any,
      mockPromptResolutionService as any,
      mockPromptAssemblyService as any,
      mockJobMetrics as any,
      mockClsService as any,
      secretsStub as any, // secretsService
      undefined, // namedEntityRepository
      mockHarnessPolicyService as any,
    );

    await processor.process(
      createMockJob({
        jobId: 'job-1',
        consultationId: 'consultation-123',
        tenantId: 'tenant-1',
        userId: 'user-1',
        request: {},
      } as unknown as GenerateSummaryJobPayload),
    );

    expect(mockHarnessPolicyService.resolveSmrSelection).toHaveBeenCalledWith('tenant-1', 'finalize');
  });
});
