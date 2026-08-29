/**
 * PreSummaryProcessor — the async native Vox SDK v2 pre-summary path.
 *
 * Covers the wiring:
 *  - the tenant reaches BOTH resolutions (the pre-summary chain has no
 *    department axis, so a consultation with no department would otherwise skip
 *    the tenant tier and land on the SYSTEM default or a 503);
 *  - the consultation's visit type reaches assembly for v1's `{visit_type}`.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TenantSettingsService } from '../../../../settings-registry/tenant-settings.service';
import { CONSULTATION_VISIT_TYPES_KEY } from '../../../visit-type/visit-type.catalogue';
import { VisitTypeService } from '../../../visit-type/visit-type.service';
import { PreSummaryProcessor } from '../pre-summary.processor';

const CONSULTATION = {
  id: 'consult-1',
  tenantId: 'tenant-1',
  departmentId: null as string | null,
  parentConsultationId: null as string | null,
  doctorId: 'doctor-1',
};

function createProcessor(consultation: Record<string, unknown>, visitTypes?: VisitTypeService) {
  const promptResolutionService = {
    resolve: vi.fn().mockResolvedValue({ resolvedFrom: 'tenant', template: 'Pre-Summary', promptId: 'p1' }),
  };
  const promptAssemblyService = {
    assemble: vi.fn().mockResolvedValue({
      userPrompt: 'assembled',
      systemPrompt: 'system',
      hyperparameters: {},
      responseFormat: null,
      resolvedFrom: 'tenant',
    }),
  };
  const jobService = {
    notifyProgress: vi.fn().mockResolvedValue(undefined),
    notifyComplete: vi.fn().mockResolvedValue(undefined),
    notifyFailed: vi.fn().mockResolvedValue(undefined),
  };
  const contextItemRepository = {
    findByConsultation: vi.fn().mockResolvedValue([{ id: 'note-1', content: 'Chest pain for three days.' }]),
    findById: vi.fn(),
    create: vi.fn().mockImplementation(async (entity: any) => ({ id: 'ctx-1', content: entity.content })),
    encryptContentIntoEntity: vi.fn(),
  };
  const consultationRepository = { findById: vi.fn().mockResolvedValue(consultation) };
  const httpService = { axiosRef: { post: vi.fn().mockResolvedValue({ data: { summary: 'PRE-SUMMARY' } }) } };
  const configService = { get: vi.fn(() => 'http://text.test') };
  const jobMetrics = {
    recordJobStart: vi.fn(() => () => 1),
    recordWaitingDuration: vi.fn(),
    recordJobComplete: vi.fn(),
    recordJobFailed: vi.fn(),
    recordTextCallDuration: vi.fn(),
  };
  const cls = { run: vi.fn(async (fn: () => Promise<unknown>) => fn()), set: vi.fn(), get: vi.fn() };

  const processor = new PreSummaryProcessor(
    jobService as any,
    contextItemRepository as any,
    consultationRepository as any,
    httpService as any,
    configService as any,
    promptResolutionService as any,
    promptAssemblyService as any,
    jobMetrics as any,
    cls as any,
    // 9-13: secretsService, harnessPolicyService, configResolver,
    // noteGenerationService, textRequestEnrichment — all @Optional().
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    // 14: the tenant's visit-type catalogue. Omitted ⇒ the two shipped types.
    visitTypes as any,
  );

  return { processor, promptResolutionService, promptAssemblyService };
}

const job = () =>
  ({
    id: 'bull-1',
    timestamp: Date.now(),
    data: {
      jobId: 'job-1',
      consultationId: 'consult-1',
      tenantId: 'tenant-1',
      userId: 'user-1',
      request: { options: { conversationLanguage: 'ml' } },
    },
  }) as any;

describe('PreSummaryProcessor', () => {
  beforeEach(() => vi.clearAllMocks());

  it("passes the consultation's tenant to prompt resolution", async () => {
    const { processor, promptResolutionService } = createProcessor({ ...CONSULTATION });
    await processor.process(job());

    expect(promptResolutionService.resolve).toHaveBeenCalledWith(expect.objectContaining({ tenantId: 'tenant-1', promptType: 'pre-summary' }));
  });

  /*
   * TASK-815 §11 row 3. These three cases used to assert the LITERALS
   * `'revisit'` / `'new-visit'` — one of the two disagreeing vocabularies the
   * ruling retired (the summary path spelled the same concept
   * `'new-patient'`). What is asserted now is the SOURCE: `{visit_type}` is
   * filled from the visit type the tenant's `consultation.visitTypes`
   * catalogue supplies, and `parentConsultationId` still chooses between them.
   */
  it("passes the tenant and the consultation's visit type to prompt assembly", async () => {
    const { processor, promptAssemblyService } = createProcessor({ ...CONSULTATION, parentConsultationId: 'consult-0' });
    await processor.process(job());

    expect(promptAssemblyService.assemble).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 'tenant-1', visitType: 'Revisit', conversationLanguage: 'ml' }),
    );
  });

  it('reports an initial visit (no parent consultation) as a new visit', async () => {
    const { processor, promptAssemblyService } = createProcessor({ ...CONSULTATION });
    await processor.process(job());

    expect(promptAssemblyService.assemble).toHaveBeenCalledWith(expect.objectContaining({ visitType: 'New patient' }));
  });

  it("renders the TENANT's own visit-type label into {visit_type}, not a platform literal", async () => {
    const { processor, promptAssemblyService } = createProcessor(
      { ...CONSULTATION, parentConsultationId: 'consult-0' },
      new VisitTypeService(
        new TenantSettingsService({
          getValueFromCache: () => null,
          getTenantValueFromCache: (tenantId: string, key: string) =>
            tenantId === 'tenant-1' && key === CONSULTATION_VISIT_TYPES_KEY
              ? [
                  { key: 'walk-in', label: 'Walk-in', aliases: [], promptSlot: 'new-patient' },
                  { key: 'clinic-review', label: 'Clinic review (same day)', aliases: [], promptSlot: 'revisit' },
                ]
              : null,
        } as never),
      ),
    );
    await processor.process(job());

    expect(promptAssemblyService.assemble).toHaveBeenCalledWith(expect.objectContaining({ visitType: 'Clinic review (same day)' }));
  });
});
