/**
 * Tier-1b's VISIT-TYPE AXIS — the platform's two-way slot map.
 *
 * `PromptResolutionService` used to pick the department prompt column with a
 * literal — `params.promptType === 'revisit' ? revisitPromptId :
 * newPatientPromptId`. It asks `VisitTypeService.promptSlot` which SLOT the
 * value names. TASK-882 made the vocabulary platform data (the tenant catalogue
 * retired), so what is pinned here is that the two shipped keys — and their
 * aliases — resolve byte-identically to the literal this replaced.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DepartmentEntity } from '@arcaai/domains';
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
// TASK-890 §3.4 (OD-M) — a `SYSTEM_DEFAULTS.*` pointer resolves the TENANT's clone of that
// platform template, matched on `sourceTemplateId`. These fixtures model a PROVISIONED tenant,
// where the clone stands in for the pointer, so the chain assertions below are unchanged; the
// unprovisioned case (`PROMPT_DEFAULT_NOT_PROVISIONED`) is pinned in
// `prompt-resolution.reference-set.task890.test.ts`.
const provisionedClone = async (_tenantId: string, sourceTemplateId: string) => ({ id: sourceTemplateId });
const promptTemplateRepository = { findById: vi.fn(), findAll: vi.fn(), findByTenantAndSourceTemplateId: vi.fn(provisionedClone) };
const promptVersionRepository = { findByVersionNumber: vi.fn(), findLatestVersion: vi.fn() };

function createService(): PromptResolutionService {
  return new PromptResolutionService(
    departmentRepository as never,
    promptTemplateRepository as never,
    promptVersionRepository as never,
    // No governing workflow definition ⇒ tier-1a is skipped and tier-1b (the
    // department column) is what answers, which is the tier under test.
    undefined,
    undefined,
    new VisitTypeService(),
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

describe('the two shipped visit types', () => {
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
