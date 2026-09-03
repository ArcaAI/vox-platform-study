/**
 * Tier-1b's VISIT-TYPE AXIS is tenant-configured data.
 *
 * `PromptResolutionService` used to pick the department prompt column with a
 * literal — `params.promptType === 'revisit' ? revisitPromptId :
 * newPatientPromptId`. It now asks the tenant's `consultation.visitTypes`
 * catalogue which SLOT the value names, so a tenant that defines "Clinic
 * review" gets the revisit prompt for it.
 *
 * Two things are pinned here, and the first matters as much as the second:
 * a tenant with NO catalogue of its own must resolve byte-identically to the
 * literal this replaced.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DepartmentEntity } from '@arcaai/domains';
import { TenantSettingsService } from '../../../settings-registry/tenant-settings.service';
import { CONSULTATION_VISIT_TYPES_KEY, type VisitTypeDefinition } from '../../visit-type/visit-type.catalogue';
import { VisitTypeService } from '../../visit-type/visit-type.service';
import { PromptResolutionService } from '../prompt-resolution.service';

const TENANT = 'tenant-1';

const DEPARTMENT = {
  id: 'dept-1',
  tenantId: TENANT,
  defaultSummaryTemplate: 'SOAP',
  newPatientPromptId: 'prompt-new-patient',
  revisitPromptId: 'prompt-revisit',
  promptConfig: null,
} as unknown as DepartmentEntity;

const departmentRepository = { findById: vi.fn() };
const promptTemplateRepository = { findById: vi.fn(), findAll: vi.fn() };
const promptVersionRepository = { findByVersionNumber: vi.fn(), findLatestVersion: vi.fn() };

function visitTypeService(tenantCatalogue?: VisitTypeDefinition[]): VisitTypeService {
  return new VisitTypeService(
    new TenantSettingsService({
      getValueFromCache: () => null,
      getTenantValueFromCache: (tenantId: string, key: string) =>
        tenantId === TENANT && key === CONSULTATION_VISIT_TYPES_KEY ? (tenantCatalogue ?? null) : null,
    } as never),
  );
}

function createService(tenantCatalogue?: VisitTypeDefinition[]): PromptResolutionService {
  return new PromptResolutionService(
    departmentRepository as never,
    promptTemplateRepository as never,
    promptVersionRepository as never,
    // No governing workflow definition ⇒ tier-1a is skipped and tier-1b (the
    // department column) is what answers, which is the tier under test.
    undefined,
    undefined,
    visitTypeService(tenantCatalogue),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  departmentRepository.findById.mockResolvedValue(DEPARTMENT);
  // Tier-1b only serves a department column whose template is APPROVED.
  promptTemplateRepository.findById.mockImplementation(async (id: string) => ({ id, status: 'APPROVED' }));
  promptTemplateRepository.findAll.mockResolvedValue({ data: [] });
  promptVersionRepository.findLatestVersion.mockResolvedValue(null);
  promptVersionRepository.findByVersionNumber.mockResolvedValue(null);
});

describe('a tenant with no catalogue of its own', () => {
  it('resolves the two shipped keys onto exactly the columns the literal did', async () => {
    const service = createService();
    await expect(service.resolve({ departmentId: 'dept-1', promptType: 'revisit' })).resolves.toMatchObject({
      promptId: 'prompt-revisit',
      resolvedFrom: 'department',
    });
    await expect(service.resolve({ departmentId: 'dept-1', promptType: 'new-patient' })).resolves.toMatchObject({
      promptId: 'prompt-new-patient',
      resolvedFrom: 'department',
    });
  });

  it('still treats an omitted prompt type as the new-patient column', async () => {
    await expect(createService().resolve({ departmentId: 'dept-1' })).resolves.toMatchObject({ promptId: 'prompt-new-patient' });
  });
});

describe('a tenant that defines its own visit types', () => {
  const OWN: VisitTypeDefinition[] = [
    { key: 'walk-in', label: 'Walk-in', aliases: ['new visit'], promptSlot: 'new-patient' },
    { key: 'clinic-review', label: 'Clinic review', aliases: ['review same-day'], promptSlot: 'revisit' },
  ];

  it("serves the revisit column for the tenant's OWN follow-up visit type", async () => {
    await expect(createService(OWN).resolve({ departmentId: 'dept-1', promptType: 'clinic-review' })).resolves.toMatchObject({
      promptId: 'prompt-revisit',
    });
  });

  it("serves the new-patient column for the tenant's OWN initial visit type", async () => {
    await expect(createService(OWN).resolve({ departmentId: 'dept-1', promptType: 'walk-in' })).resolves.toMatchObject({
      promptId: 'prompt-new-patient',
    });
  });

  it('resolves an ALIAS the tenant declared, not just the key', async () => {
    await expect(createService(OWN).resolve({ departmentId: 'dept-1', promptType: 'review same-day' })).resolves.toMatchObject({
      promptId: 'prompt-revisit',
    });
  });

  it('does not leak the tenant’s vocabulary to another tenant', async () => {
    // `clinic-review` means nothing outside `tenant-1`; an unknown value carries
    // no visit-type opinion and reads the new-patient column, as before.
    departmentRepository.findById.mockResolvedValue({ ...DEPARTMENT, tenantId: 'tenant-2' } as unknown as DepartmentEntity);
    await expect(createService(OWN).resolve({ departmentId: 'dept-1', promptType: 'clinic-review' })).resolves.toMatchObject({
      promptId: 'prompt-new-patient',
    });
  });
});

const OWN_FALLBACK: VisitTypeDefinition[] = [{ key: 'walk-in', label: 'Walk-in', aliases: [], promptSlot: 'new-patient' }];

describe('the PHASE axis is not a visit type', () => {
  it('leaves `live` on the summary chain’s new-patient column, never on a tenant lookup miss path of its own', async () => {
    // `'live'` selects the LIVE chain, which has no department visit-type
    // column; it must not be interpretable as a visit-type key.
    const service = createService([
      { key: 'live', label: 'Live (a tenant should not be able to shadow a phase)', aliases: [], promptSlot: 'revisit' },
      ...OWN_FALLBACK,
    ]);
    const resolved = await service.resolve({ departmentId: 'dept-1', promptType: 'live' });
    expect(resolved.resolvedCapability).toBe('live');
  });
});
