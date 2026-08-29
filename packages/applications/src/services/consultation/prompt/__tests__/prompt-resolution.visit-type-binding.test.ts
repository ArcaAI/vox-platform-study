/**
 * VISIT TYPE AS THE PROMPT-COMPOSITION IDENTIFIER (owner, 2026-08-29):
 *
 * > "Visit type is an identifier where the hope platform configure and compose
 * > the instructions and consultation context as prompt for agent to work on:
 * > pre-summarization OR summarization OR any text generation task."
 *
 * The resolver could not express that. `promptType` carries BOTH axes (a frozen
 * wire contract), so a pre-summary request said `'pre-summary'` and the visit
 * type became invisible — it reached assembly only as the `{visit_type}`
 * VARIABLE. And on the summary chain the visit type could only pick between two
 * `Department` columns.
 *
 * These tests pin the generalisation and, first, the thing that makes it safe:
 * a tenant that has configured NO binding resolves byte-identically on all
 * three chains.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DepartmentEntity } from '@arcaai/domains';
import { TenantSettingsService } from '../../../settings-registry/tenant-settings.service';
import { CONSULTATION_VISIT_TYPES_KEY, type VisitTypeDefinition } from '../../visit-type/visit-type.catalogue';
import { VisitTypeService } from '../../visit-type/visit-type.service';
import { PromptResolutionService, SYSTEM_DEFAULTS } from '../prompt-resolution.service';

const TENANT = 'tenant-1';

const DEPARTMENT = {
  id: 'dept-1',
  tenantId: TENANT,
  defaultSummaryTemplate: 'SOAP',
  newPatientPromptId: 'prompt-new-patient',
  revisitPromptId: 'prompt-revisit',
  promptConfig: { contextVariables: { specialty: 'cardiology' } },
} as unknown as DepartmentEntity;

const departmentRepository = { findById: vi.fn() };
const promptTemplateRepository = { findById: vi.fn(), findAll: vi.fn() };
const promptVersionRepository = { findByVersionNumber: vi.fn(), findLatestVersion: vi.fn() };

/** A catalogue whose "Revisit" composes its own prompt for each task. */
const BOUND: VisitTypeDefinition[] = [
  { key: 'new-patient', label: 'New patient', aliases: ['new-visit'], promptSlot: 'new-patient' },
  {
    key: 'revisit',
    label: 'Revisit',
    aliases: ['follow-up', 're-visit'],
    promptSlot: 'revisit',
    prompts: {
      summary: { promptTemplateId: 'tpl-summary-revisit', contextVariables: { priorVisits: 3, specialty: 'cardiology-followup' } },
      'pre-summary': { promptTemplateId: 'tpl-presummary-revisit', promptVersionNumber: 7 },
      live: { promptTemplateId: 'tpl-live-revisit' },
    },
  },
];

function visitTypeService(tenantCatalogue?: VisitTypeDefinition[]): VisitTypeService {
  return new VisitTypeService(
    new TenantSettingsService({
      getValueFromCache: () => null,
      getTenantValueFromCache: (tenantId: string, key: string) =>
        tenantId === TENANT && key === CONSULTATION_VISIT_TYPES_KEY ? (tenantCatalogue ?? null) : null,
    } as never),
  );
}

/** No workflow resolvers wired ⇒ the node tier is skipped, as in a bare composition. */
function createService(tenantCatalogue?: VisitTypeDefinition[]): PromptResolutionService {
  return new PromptResolutionService(
    departmentRepository as never,
    promptTemplateRepository as never,
    promptVersionRepository as never,
    undefined,
    undefined,
    visitTypeService(tenantCatalogue),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  departmentRepository.findById.mockResolvedValue(DEPARTMENT);
  promptTemplateRepository.findById.mockImplementation(async (id: string) => ({ id, status: 'APPROVED', approvedVersionNumber: 2 }));
  promptTemplateRepository.findAll.mockResolvedValue([]);
  promptVersionRepository.findByVersionNumber.mockImplementation(async (id: string, n: number) => ({
    versionNumber: n,
    content: `body:${id}@${n}`,
  }));
  promptVersionRepository.findLatestVersion.mockResolvedValue(null);
});

describe('a tenant that configured NO binding — nothing may move', () => {
  it('summary still resolves the department visit-type column', async () => {
    await expect(createService().resolve({ departmentId: 'dept-1', promptType: 'revisit' })).resolves.toMatchObject({
      promptId: 'prompt-revisit',
      resolvedFrom: 'department',
    });
  });

  it('pre-summary still resolves the SYSTEM default even when a visit type is supplied', async () => {
    await expect(
      createService().resolve({ tenantId: TENANT, departmentId: 'dept-1', promptType: 'pre-summary', visitTypeKey: 'revisit' }),
    ).resolves.toMatchObject({ promptId: SYSTEM_DEFAULTS.preSummaryPromptId, resolvedFrom: 'default' });
  });

  it('live still resolves the SYSTEM live default', async () => {
    await expect(createService().resolve({ tenantId: TENANT, departmentId: 'dept-1', promptType: 'live' })).resolves.toMatchObject({
      promptId: SYSTEM_DEFAULTS.livePromptId,
      resolvedFrom: 'default',
    });
  });
});

describe('(task, visitType) selects the instructions', () => {
  it('SUMMARY — the binding beats the department column', async () => {
    const result = await createService(BOUND).resolve({ departmentId: 'dept-1', promptType: 'revisit' });
    expect(result.promptId).toBe('tpl-summary-revisit');
    expect(result.content).toBe('body:tpl-summary-revisit@2');
  });

  it('PRE-SUMMARY — the chain that had no visit-type axis at all now has one', async () => {
    const result = await createService(BOUND).resolve({
      tenantId: TENANT,
      departmentId: 'dept-1',
      promptType: 'pre-summary',
      visitTypeKey: 'revisit',
    });
    expect(result.promptId).toBe('tpl-presummary-revisit');
    // The binding's own pin, not the template's approvedVersionNumber.
    expect(result.resolvedVersionNumber).toBe(7);
    expect(result.resolvedCapability).toBe('pre-summary');
  });

  it('LIVE — the binding answers before the node tier', async () => {
    const result = await createService(BOUND).resolve({ tenantId: TENANT, departmentId: 'dept-1', promptType: 'live', visitTypeKey: 'revisit' });
    expect(result.promptId).toBe('tpl-live-revisit');
  });

  it('resolves through an ALIAS, and through a spelling the owner used', async () => {
    await expect(createService(BOUND).resolve({ departmentId: 'dept-1', promptType: 'Re-visit' })).resolves.toMatchObject({
      promptId: 'tpl-summary-revisit',
    });
  });

  it('a visit type with no binding for THIS task falls through — never a neighbour’s prompt', async () => {
    // 'new-patient' binds nothing at all.
    await expect(createService(BOUND).resolve({ departmentId: 'dept-1', promptType: 'new-patient' })).resolves.toMatchObject({
      promptId: 'prompt-new-patient',
      resolvedFrom: 'department',
    });
  });

  it('falls through when the bound template is not APPROVED', async () => {
    promptTemplateRepository.findById.mockImplementation(async (id: string) =>
      id === 'tpl-summary-revisit' ? { id, status: 'DRAFT' } : { id, status: 'APPROVED', approvedVersionNumber: 2 },
    );
    await expect(createService(BOUND).resolve({ departmentId: 'dept-1', promptType: 'revisit' })).resolves.toMatchObject({
      promptId: 'prompt-revisit',
      resolvedFrom: 'department',
    });
  });

  it('does not leak one tenant’s binding to another', async () => {
    departmentRepository.findById.mockResolvedValue({ ...DEPARTMENT, tenantId: 'tenant-2' } as unknown as DepartmentEntity);
    await expect(createService(BOUND).resolve({ departmentId: 'dept-1', promptType: 'revisit' })).resolves.toMatchObject({
      promptId: 'prompt-revisit',
    });
  });
});

describe('(task, visitType) also composes the consultation context', () => {
  it('merges the binding’s context variables OVER the department’s', async () => {
    const result = await createService(BOUND).resolve({ departmentId: 'dept-1', promptType: 'revisit' });
    expect(result.contextVariables).toEqual({ specialty: 'cardiology-followup', priorVisits: 3 });
  });

  it('leaves the department’s alone when the binding did not supply the prompt', async () => {
    const result = await createService(BOUND).resolve({ departmentId: 'dept-1', promptType: 'new-patient' });
    expect(result.contextVariables).toEqual({ specialty: 'cardiology' });
  });
});

describe('the explicit visit-type axis', () => {
  it('`visitTypeKey` outranks the visit type buried in `promptType`', async () => {
    const result = await createService(BOUND).resolve({ departmentId: 'dept-1', promptType: 'new-patient', visitTypeKey: 'revisit' });
    expect(result.promptId).toBe('tpl-summary-revisit');
  });

  it('a phase in `promptType` carries no visit-type opinion, so no binding is consulted', async () => {
    // No `visitTypeKey` ⇒ pre-summary resolves exactly as it did before.
    await expect(createService(BOUND).resolve({ tenantId: TENANT, departmentId: 'dept-1', promptType: 'pre-summary' })).resolves.toMatchObject({
      promptId: SYSTEM_DEFAULTS.preSummaryPromptId,
    });
  });

  it('the doctor’s preferred template still outranks the tenant’s binding', async () => {
    const result = await createService(BOUND).resolve({
      departmentId: 'dept-1',
      promptType: 'revisit',
      preferredPromptTemplateId: 'tpl-doctor',
    });
    expect(result.promptId).toBe('tpl-doctor');
    expect(result.resolvedFrom).toBe('preferred');
  });
});

describe('provenance', () => {
  it('reports the binding through the EXISTING `resolvedFrom` vocabulary and names it in the trace', async () => {
    const result = await createService(BOUND).resolve({ departmentId: 'dept-1', promptType: 'revisit' });
    // No new member: `ResolvedPromptConfig` is reached by a frozen v1-compat
    // route, and `'tenant'` already means "a tenant-configured template".
    expect(result.resolvedFrom).toBe('tenant');
    expect(result.resolutionTrace).toMatchObject({
      visitTypeKey: 'revisit',
      visitTypeTask: 'summary',
      visitTypePromptId: 'tpl-summary-revisit',
    });
  });

  it('records the visit type it resolved even when no binding answered', async () => {
    const result = await createService(BOUND).resolve({ departmentId: 'dept-1', promptType: 'new-patient' });
    expect(result.resolutionTrace.visitTypeKey).toBe('new-patient');
    expect(result.resolutionTrace.visitTypePromptId).toBeNull();
  });
});
