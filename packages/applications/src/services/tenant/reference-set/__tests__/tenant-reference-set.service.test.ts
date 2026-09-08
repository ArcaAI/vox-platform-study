/**
 * TASK-890 §3.4 L13 step i — the SYSTEM reference set.
 *
 * What these tests pin, and why each matters after the flip (step v):
 *
 *  - the ORDER of the kinds. Prompts must land before agents (an agent's instruction is
 *    re-pointed at the tenant's prompt clone) and agents before assignments (an assignment names
 *    a slug that must already resolve in the tenant). Asserting the order is asserting the only
 *    reason this service exists rather than five statements in `TenantService.create`.
 *  - MISSING-ONLY: a row the tenant already has is never touched.
 *  - per-row FAILURE ISOLATION with a named warning: a tenant missing a kind must be a report,
 *    never a silence — that report is what proof #9 reads before the flip is allowed.
 *  - the SYSTEM tenant refuses to be provisioned from itself.
 *  - NOTHING is cloned for `AiModel` or `GlobalSetting` (OD-O / OD-P): those are CONFIG and
 *    resolve tenant → SYSTEM at read time.
 *
 * TASK-891 adds `documentTemplates` — the same CONTENT rule, for the clinical-document SHAPE
 * catalogue seeded by `27-document-template-library.ts`. It lands BEFORE `workflowDefinitions`
 * because a workflow's generation node binds its template BY ROW ID and the clone re-points that
 * binding by slug in the target tenant: with no template there is nothing to re-point to.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { BadRequestException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentTask, PipelinePolicyScope } from '@arcaai/domains';
import { IAgentService } from '../../../agent/IAgentService';
import { IAgentAssignmentService } from '../../../agent-assignment/IAgentAssignmentService';
import { IConsultationContextSchemaService } from '../../../consultation-context-schema/IConsultationContextSchemaService';
import { IDocumentTemplateService } from '../../../document-template/IDocumentTemplateService';
import { IPromptManagementService } from '../../../prompt-management/IPromptManagementService';
import { IWorkflowDefinitionService } from '../../../workflow-definition/IWorkflowDefinitionService';
import { TenantReferenceSetService } from '../tenant-reference-set.service';

const SYSTEM = '00000000-0000-0000-0000-000000000000';
const TENANT = 'tenant-1';

const calls: string[] = [];

const agentRepository = { findSystemReferences: vi.fn() };
const promptTemplateRepository = { findSystemReferences: vi.fn() };
const assignmentRepository = { findAllForScope: vi.fn(), findForScopeSelector: vi.fn() };
const workflowDefinitionRepository = { findSystemTemplates: vi.fn() };
// TASK-930 §6.3 — the seventh kind. Empty here: what it copies is pinned by its own suite
// (`tenant-reference-set.workflow-assignments.task930.test.ts`); this file pins the ORDER.
const workflowAssignmentRepository = { findAll: vi.fn(async () => []), findForScopeSelector: vi.fn(async () => null) };
const contextSchemaRepository = { findAll: vi.fn(), findByTenantAndSlug: vi.fn() };
const documentTemplateRepository = { findAll: vi.fn(), findByTenantAndSlug: vi.fn() };
const documentTemplateVersionRepository = { findByTemplateAndVersionNumber: vi.fn() };
const databaseService = { baseClient: { __base: true } };

const agents = {
  cloneFromSystem: vi.fn(async (slug: string) => {
    calls.push(`agent:${slug}`);
    return { agentId: 'a1', created: true, warnings: [] };
  }),
};
const prompts = {
  cloneFromSystem: vi.fn(async (id: string) => {
    calls.push(`prompt:${id}`);
    return { templateId: 'p1', created: true, approvedVersionNumber: 1 };
  }),
};
const workflows = {
  cloneFromSystem: vi.fn(async (slug: string) => {
    calls.push(`workflow:${slug}`);
    return { definitionId: 'w1', created: true };
  }),
};
const contextSchemas = {
  cloneFromSystem: vi.fn(async (slug: string) => {
    calls.push(`schema:${slug}`);
    return { id: 's1' };
  }),
};
const assignments = {
  upsert: vi.fn(async (dto: any) => {
    calls.push(`assignment:${dto.task}:${dto.agentSlug}`);
    return {};
  }),
};
const documentTemplates = {
  create: vi.fn(async (dto: any) => {
    calls.push(`document:${dto.slug}`);
    return { id: `dt-${dto.slug}` };
  }),
  // Deliberately NOT pushed onto `calls`: the ORDER assertion is about the kinds, and a second
  // entry per template would drown it. That `publish` ran with the source's pinned shape is
  // asserted directly instead.
  publish: vi.fn(async () => ({})),
};

const PORTS = new Map<unknown, unknown>([
  [IAgentService, agents],
  [IPromptManagementService, prompts],
  [IWorkflowDefinitionService, workflows],
  [IConsultationContextSchemaService, contextSchemas],
  [IAgentAssignmentService, assignments],
  [IDocumentTemplateService, documentTemplates],
]);

function resolvePort(token: unknown): unknown {
  if (PORTS.has(token)) return PORTS.get(token);
  throw new Error('not registered');
}

const moduleRef = { get: vi.fn(resolvePort) };

const cls = {
  get: vi.fn(() => undefined),
  set: vi.fn(),
  getId: vi.fn(() => 'cid'),
  run: vi.fn((optionsOrCallback: unknown, maybeCallback?: unknown) =>
    typeof optionsOrCallback === 'function' ? (optionsOrCallback as () => unknown)() : (maybeCallback as () => unknown)(),
  ),
};
const events = { emit: vi.fn() };

function make(): TenantReferenceSetService {
  return new TenantReferenceSetService(
    agentRepository as never,
    promptTemplateRepository as never,
    assignmentRepository as never,
    workflowDefinitionRepository as never,
    workflowAssignmentRepository as never,
    contextSchemaRepository as never,
    documentTemplateRepository as never,
    documentTemplateVersionRepository as never,
    databaseService as never,
    moduleRef as never,
    events as never,
    cls as never,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  calls.length = 0;
  // `clearAllMocks` clears CALLS, not implementations — re-declare every one this suite
  // overrides in a single test so no expectation leaks into the next.
  moduleRef.get.mockImplementation(resolvePort);
  agents.cloneFromSystem.mockImplementation(async (slug: string) => {
    calls.push(`agent:${slug}`);
    return { agentId: 'a1', created: true, warnings: [] };
  });
  prompts.cloneFromSystem.mockImplementation(async (id: string) => {
    calls.push(`prompt:${id}`);
    return { templateId: 'p1', created: true, approvedVersionNumber: 1 };
  });
  workflows.cloneFromSystem.mockImplementation(async (slug: string) => {
    calls.push(`workflow:${slug}`);
    return { definitionId: 'w1', created: true };
  });
  contextSchemas.cloneFromSystem.mockImplementation(async (slug: string) => {
    calls.push(`schema:${slug}`);
    return { id: 's1' };
  });
  assignments.upsert.mockImplementation(async (dto: any) => {
    calls.push(`assignment:${dto.task}:${dto.agentSlug}`);
    return {};
  });
  documentTemplates.create.mockImplementation(async (dto: any) => {
    calls.push(`document:${dto.slug}`);
    return { id: `dt-${dto.slug}` };
  });
  documentTemplates.publish.mockImplementation(async () => ({}));
  contextSchemaRepository.findAll.mockResolvedValue([{ slug: 'consultation_legacy_v1' }]);
  contextSchemaRepository.findByTenantAndSlug.mockResolvedValue(null);
  promptTemplateRepository.findSystemReferences.mockResolvedValue([{ id: 'sys-prompt', name: 'CATCHALL_SOAP', scope: 'TENANT_DEFAULT' }]);
  agentRepository.findSystemReferences.mockResolvedValue([{ slug: 'platform-summarization' }]);
  assignmentRepository.findAllForScope.mockImplementation(async (_t: string, _s: unknown, _i: unknown, task: AgentTask) =>
    task === AgentTask.TEXT_GENERATION ? [{ agentSlug: 'platform-summarization', selectorKey: '' }] : [],
  );
  assignmentRepository.findForScopeSelector.mockResolvedValue(null);
  workflowDefinitionRepository.findSystemTemplates.mockResolvedValue([{ slug: 'platform-default-summarization' }]);
  documentTemplateRepository.findAll.mockResolvedValue([
    {
      id: 'sys-doc-1',
      slug: 'consultation_note_new_visit',
      name: 'Consultation Note — New / Referral Visit',
      description: 'Platform reference shape.',
      pinnedVersionNumber: 1,
      isDefault: false,
    },
    { id: 'sys-doc-2', slug: 'consultation_note_revisit', name: 'Consultation Note — Follow-up', description: null, pinnedVersionNumber: 1, isDefault: false },
  ]);
  documentTemplateRepository.findByTenantAndSlug.mockResolvedValue(null);
  documentTemplateVersionRepository.findByTemplateAndVersionNumber.mockImplementation(async (templateId: string) => ({
    id: `${templateId}-v1`,
    versionNumber: 1,
    shape: { schemaVersion: '1.0', title: templateId, sections: [] },
  }));
});

describe('TenantReferenceSetService.provision', () => {
  it('copies every kind in the order the runtime requires: schemas, prompts, agents, assignments, documents, workflows', async () => {
    const summary = await make().provision(TENANT);

    expect(calls).toEqual([
      'schema:consultation_legacy_v1',
      'prompt:sys-prompt',
      'agent:platform-summarization',
      'assignment:TEXT_GENERATION:platform-summarization',
      'document:consultation_note_new_visit',
      'document:consultation_note_revisit',
      'workflow:platform-default-summarization',
    ]);
    expect(summary.mode).toBe('missing-only');
    expect(summary.warnings).toEqual([]);
    expect(summary.kinds.contextSchemas.added).toBe(1);
    expect(summary.kinds.promptTemplates.added).toBe(1);
    expect(summary.kinds.agents.added).toBe(1);
    expect(summary.kinds.agentAssignments.added).toBe(1);
    expect(summary.kinds.documentTemplates.added).toBe(2);
    expect(summary.kinds.workflowDefinitions.added).toBe(1);
  });

  it('clones NO AiModel and NO GlobalSetting row — the catalogue and the platform settings are CONFIG (OD-O, OD-P)', async () => {
    const summary = await make().provision(TENANT);
    // The service has no model or setting repository at all; the assertion that matters is that
    // the kind set is closed, so a future addition has to be a deliberate edit here.
    expect(Object.keys(summary.kinds)).toEqual([
      'contextSchemas',
      'promptTemplates',
      'agents',
      'agentAssignments',
      'documentTemplates',
      'workflowDefinitions',
      // TASK-930 §6.3 — the deliberate edit this assertion exists to force. Still CONTENT: which
      // workflow a tenant RUNS is its own row, not a value it inherits at read time.
      'workflowAssignments',
    ]);
  });

  it('reads the SYSTEM reference library on the UNSCOPED base client, never the caller-scoped one', async () => {
    await make().provision(TENANT);
    expect(agentRepository.findSystemReferences).toHaveBeenCalledWith(databaseService.baseClient);
    expect(promptTemplateRepository.findSystemReferences).toHaveBeenCalledWith(databaseService.baseClient);
    expect(workflowDefinitionRepository.findSystemTemplates).toHaveBeenCalledWith(databaseService.baseClient);
  });

  it('reads the SYSTEM assignments under SYSTEM tenant context and writes the tenant row under the TENANT`s', async () => {
    await make().provision(TENANT);
    expect(assignmentRepository.findAllForScope).toHaveBeenCalledWith(SYSTEM, PipelinePolicyScope.TENANT, null, AgentTask.TEXT_GENERATION);
    expect(cls.set).toHaveBeenCalledWith('tenantId', SYSTEM);
    expect(cls.set).toHaveBeenCalledWith('tenantId', TENANT);
    expect(assignments.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ scope: PipelinePolicyScope.TENANT, task: AgentTask.TEXT_GENERATION, agentSlug: 'platform-summarization' }),
    );
  });

  it('is MISSING-ONLY: a schema and an assignment the tenant already has are skipped, not re-copied', async () => {
    contextSchemaRepository.findByTenantAndSlug.mockResolvedValue({ id: 'own' });
    assignmentRepository.findForScopeSelector.mockResolvedValue({ id: 'own' });
    const summary = await make().provision(TENANT);
    expect(contextSchemas.cloneFromSystem).not.toHaveBeenCalled();
    expect(assignments.upsert).not.toHaveBeenCalled();
    expect(summary.kinds.contextSchemas).toEqual({ added: 0, skipped: 1, failed: 0 });
    expect(summary.kinds.agentAssignments).toEqual({ added: 0, skipped: 1, failed: 0 });
  });

  it('reports a per-row failure by NAME and keeps going — one bad copy never costs the tenant the rest', async () => {
    agents.cloneFromSystem.mockRejectedValueOnce(new Error('model not visible'));
    const summary = await make().provision(TENANT);
    expect(summary.kinds.agents).toEqual({ added: 0, skipped: 0, failed: 1 });
    expect(summary.warnings).toEqual([expect.stringContaining("agents: 'platform-summarization' was not provisioned: model not visible")]);
    // The kinds after it still ran.
    expect(summary.kinds.workflowDefinitions.added).toBe(1);
  });

  it('reports an UNREGISTERED collaborator instead of throwing, so a mis-wired host is visible and not fatal', async () => {
    moduleRef.get.mockImplementation((token: unknown) => {
      if (token === IWorkflowDefinitionService) throw new Error('not registered');
      if (PORTS.has(token)) return PORTS.get(token);
      throw new Error('not registered');
    });
    const summary = await make().provision(TENANT);
    expect(summary.kinds.workflowDefinitions.failed).toBe(1);
    expect(summary.warnings).toEqual([expect.stringContaining('workflowDefinitions: the workflow-definition service is not wired')]);
  });

  it('refuses the SYSTEM tenant — it IS the reference set', async () => {
    await expect(make().provision(SYSTEM)).rejects.toBeInstanceOf(BadRequestException);
    await expect(make().provision('')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('never copies a USER_PERSONAL template — a personal prompt has no meaning in another tenant', async () => {
    promptTemplateRepository.findSystemReferences.mockResolvedValue([
      { id: 'sys-prompt', name: 'CATCHALL_SOAP', scope: 'TENANT_DEFAULT' },
      { id: 'personal', name: 'Someone`s draft', scope: 'USER_PERSONAL' },
    ]);
    await make().provision(TENANT);
    expect(prompts.cloneFromSystem).toHaveBeenCalledTimes(1);
    expect(prompts.cloneFromSystem).toHaveBeenCalledWith('sys-prompt', TENANT);
  });
});

describe('TenantReferenceSetService.resync', () => {
  it('runs only the named kinds, still in the canonical order', async () => {
    const summary = await make().resync(TENANT, { kinds: ['agents', 'promptTemplates'] });
    expect(calls).toEqual(['prompt:sys-prompt', 'agent:platform-summarization']);
    expect(summary.kinds.workflowDefinitions).toEqual({ added: 0, skipped: 0, failed: 0 });
  });

  it('is idempotent: a second run over a fully provisioned tenant adds nothing', async () => {
    contextSchemaRepository.findByTenantAndSlug.mockResolvedValue({ id: 'own' });
    assignmentRepository.findForScopeSelector.mockResolvedValue({ id: 'own' });
    documentTemplateRepository.findByTenantAndSlug.mockResolvedValue({ id: 'own' });
    prompts.cloneFromSystem.mockResolvedValue({ templateId: 'p1', created: false, approvedVersionNumber: 1 });
    agents.cloneFromSystem.mockResolvedValue({ agentId: 'a1', created: false, warnings: [] });
    workflows.cloneFromSystem.mockResolvedValue({ definitionId: 'w1', created: false });

    const summary = await make().resync(TENANT);
    const added = Object.values(summary.kinds).reduce((sum, kind) => sum + kind.added, 0);
    expect(added).toBe(0);
    expect(summary.warnings).toEqual([]);
  });

  /**
   * Wave-3 close — `refresh-locked` is declared on the route and not implemented. The run must
   * SAY it reconciled missing-only: an operator reaching for the mode is trying to fast-forward
   * a pristine clone, and a bare "0 added" would read as "already up to date".
   */
  it('says so in `warnings` when asked for the unimplemented `refresh-locked` mode', async () => {
    const summary = await make().resync(TENANT, { mode: 'refresh-locked', kinds: ['contextSchemas'] });
    expect(summary.mode).toBe('refresh-locked');
    expect(summary.warnings.some((warning) => warning.includes('refresh-locked') && warning.includes('not implemented'))).toBe(true);
  });
});

/**
 * TASK-891 — `documentTemplates`.
 *
 * The gap these close: the SYSTEM `DocumentTemplate` rows seeded by
 * `27-document-template-library.ts` are CONTENT — the model is deliberately absent from
 * `SYSTEM_SHARED_READ_MODELS` and `resolveForGeneration` reads the REQUEST tenant only — so a
 * SYSTEM row is INVISIBLE to a tenant that has no copy of it. Before this kind existed a tenant
 * created through `POST /admin/tenants` received none, and the sync route could not add them
 * later. Everything below is about the copy being faithful, ordered, and never destructive.
 */
describe('TenantReferenceSetService — documentTemplates (TASK-891)', () => {
  it('clones each SYSTEM template and publishes v1 from the SOURCE`s PINNED version shape', async () => {
    const summary = await make().provision(TENANT);

    expect(summary.kinds.documentTemplates).toEqual({ added: 2, skipped: 0, failed: 0 });
    expect(documentTemplateVersionRepository.findByTemplateAndVersionNumber).toHaveBeenCalledWith('sys-doc-1', 1);
    expect(documentTemplateVersionRepository.findByTemplateAndVersionNumber).toHaveBeenCalledWith('sys-doc-2', 1);
    expect(documentTemplates.publish).toHaveBeenCalledWith('dt-consultation_note_new_visit', {
      shape: { schemaVersion: '1.0', title: 'sys-doc-1', sections: [] },
      changeReason: 'Provisioned from the platform reference set',
    });
    expect(documentTemplates.publish).toHaveBeenCalledWith('dt-consultation_note_revisit', {
      shape: { schemaVersion: '1.0', title: 'sys-doc-2', sections: [] },
      changeReason: 'Provisioned from the platform reference set',
    });
  });

  it('stamps the golden-library provenance and never makes the clone the tenant default', async () => {
    await make().provision(TENANT);

    expect(documentTemplates.create).toHaveBeenCalledWith({
      slug: 'consultation_note_new_visit',
      name: 'Consultation Note — New / Referral Visit',
      description: 'Platform reference shape.',
      // Hardcoded false, never mirrored from the source: `DocumentTemplateService.create`
      // DEMOTES the tenant's existing default, and provisioning must never silently change a
      // choice the tenant made.
      isDefault: false,
      sourceTemplateSlug: 'consultation_note_new_visit',
      templateLocked: true,
    });
    expect(documentTemplates.create).toHaveBeenCalledWith(expect.objectContaining({ slug: 'consultation_note_revisit', description: undefined }));
  });

  it('reads the SYSTEM library under SYSTEM context and writes the clone under the TENANT`s', async () => {
    await make().provision(TENANT);

    expect(documentTemplateRepository.findAll).toHaveBeenCalledWith({ where: { tenantId: SYSTEM } });
    expect(documentTemplateRepository.findByTenantAndSlug).toHaveBeenCalledWith(TENANT, 'consultation_note_new_visit');
    expect(cls.set).toHaveBeenCalledWith('tenantId', SYSTEM);
    expect(cls.set).toHaveBeenCalledWith('tenantId', TENANT);
  });

  it('lands BEFORE workflowDefinitions — a workflow node binds its template by row id, re-pointed by slug', async () => {
    await make().provision(TENANT);
    expect(calls.indexOf('document:consultation_note_new_visit')).toBeLessThan(calls.indexOf('workflow:platform-default-summarization'));
  });

  /**
   * THE clobber proof. A tenant that has edited its copy — renamed it, republished a different
   * shape, unlocked it — must come out of a re-sync with exactly what it had. Create-only by
   * SLUG is what guarantees that: the tenant row is never read for its contents, never patched
   * and never re-published, so there is no code path through which an edit could be lost.
   */
  it('is CREATE-ONLY: a tenant-EDITED row is skipped, never overwritten and never re-published', async () => {
    documentTemplateRepository.findByTenantAndSlug.mockImplementation(async (_tenantId: string, slug: string) =>
      slug === 'consultation_note_new_visit'
        ? { id: 'tenant-own', slug, name: 'Our own house note', templateLocked: false, pinnedVersionNumber: 7 }
        : null,
    );

    const summary = await make().resync(TENANT, { kinds: ['documentTemplates'] });

    expect(summary.kinds.documentTemplates).toEqual({ added: 1, skipped: 1, failed: 0 });
    // Only the MISSING slug was touched. The edited row produced no create and no publish at all.
    expect(documentTemplates.create).toHaveBeenCalledTimes(1);
    expect(documentTemplates.create).toHaveBeenCalledWith(expect.objectContaining({ slug: 'consultation_note_revisit' }));
    expect(documentTemplates.publish).toHaveBeenCalledTimes(1);
    expect(documentTemplates.publish).not.toHaveBeenCalledWith('tenant-own', expect.anything());
  });

  it('leaves a tenant-edited row alone in `refresh-locked` too — the mode is declared, not implemented', async () => {
    documentTemplateRepository.findByTenantAndSlug.mockResolvedValue({ id: 'tenant-own', templateLocked: false });

    const summary = await make().resync(TENANT, { mode: 'refresh-locked', kinds: ['documentTemplates'] });

    expect(summary.kinds.documentTemplates).toEqual({ added: 0, skipped: 2, failed: 0 });
    expect(documentTemplates.create).not.toHaveBeenCalled();
    expect(documentTemplates.publish).not.toHaveBeenCalled();
  });

  it('is idempotent: a second run over an already-provisioned tenant adds nothing', async () => {
    documentTemplateRepository.findByTenantAndSlug.mockResolvedValue({ id: 'clone' });
    const summary = await make().resync(TENANT, { kinds: ['documentTemplates'] });
    expect(summary.kinds.documentTemplates).toEqual({ added: 0, skipped: 2, failed: 0 });
  });

  /**
   * An unservable SOURCE would produce an unservable CLONE — a row `isServable` silently skips.
   * Naming the platform defect at provisioning time is the point of the warnings list.
   */
  it('refuses a SYSTEM row with no pinned version, by name, and keeps going', async () => {
    documentTemplateRepository.findAll.mockResolvedValue([
      { id: 'sys-doc-1', slug: 'consultation_note_new_visit', name: 'A', description: null, pinnedVersionNumber: null, isDefault: false },
      { id: 'sys-doc-2', slug: 'consultation_note_revisit', name: 'B', description: null, pinnedVersionNumber: 1, isDefault: false },
    ]);

    const summary = await make().resync(TENANT, { kinds: ['documentTemplates'] });

    expect(summary.kinds.documentTemplates).toEqual({ added: 1, skipped: 0, failed: 1 });
    expect(summary.warnings).toEqual([expect.stringContaining("documentTemplates: 'consultation_note_new_visit' was not provisioned")]);
    expect(documentTemplates.create).toHaveBeenCalledTimes(1);
  });

  it('reports a per-row publish failure by NAME and still copies the rest', async () => {
    documentTemplates.publish.mockRejectedValueOnce(new Error('the shape is not publishable'));

    const summary = await make().resync(TENANT, { kinds: ['documentTemplates'] });

    expect(summary.kinds.documentTemplates).toEqual({ added: 1, skipped: 0, failed: 1 });
    expect(summary.warnings).toEqual([
      expect.stringContaining("documentTemplates: 'consultation_note_new_visit' was not provisioned: the shape is not publishable"),
    ]);
  });

  it('reports an unwired document-template service instead of throwing', async () => {
    moduleRef.get.mockImplementation((token: unknown) => {
      if (token === IDocumentTemplateService) throw new Error('not registered');
      if (PORTS.has(token)) return PORTS.get(token);
      throw new Error('not registered');
    });

    const summary = await make().resync(TENANT, { kinds: ['documentTemplates'] });

    expect(summary.kinds.documentTemplates.failed).toBe(1);
    expect(summary.warnings).toEqual([expect.stringContaining('documentTemplates: the document-template service is not wired')]);
  });
});
