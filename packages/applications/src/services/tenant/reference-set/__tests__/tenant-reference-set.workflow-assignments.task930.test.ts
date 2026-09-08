/**
 * TASK-930 §6.3 — the reference set also clones `workflowAssignments`.
 *
 * ## Why the kind exists at all
 *
 * `workflowDefinitions` gives a new tenant the platform's workflows; it does NOT give it the row
 * that says which one runs. `WorkflowAssignmentService.resolve` has no SYSTEM tier — the cascade
 * is `department → tenant → platform-default` — so an unassigned tenant silently falls through to
 * the platform default no matter how good its cloned library is. Cloning the assignment is what
 * makes "provisioned from SYSTEM" mean the tenant actually RUNS the SYSTEM workflow.
 *
 * ## Why TENANT scope only
 *
 * A DEPARTMENT-scope row names a `scopeId` that is a department of the SOURCE tenant. Departments
 * are tenant TOPOLOGY, not content: the id means nothing in the target and there is no slug to
 * re-point it by. Copying one would either dangle or, worse, collide with an unrelated department
 * id. So DEPARTMENT rows are skipped, and — because a silent skip is how a tenant ends up missing
 * a routing rule nobody can explain — the skip is stated in `warnings`.
 *
 * Written RED-first: every test here failed against `2ba6910ad`, where `REFERENCE_SET_KINDS`
 * carried six kinds and no assignment of a workflow was ever copied.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PipelinePolicyScope } from '@arcaai/domains';
import { IWorkflowAssignmentService } from '../../../workflow-assignment/IWorkflowAssignmentService';
import { REFERENCE_SET_KINDS } from '../ITenantReferenceSetService';
import { TenantReferenceSetService } from '../tenant-reference-set.service';

const SYSTEM = '00000000-0000-0000-0000-000000000000';
const TENANT = 'tenant-1';

const agentRepository = { findSystemReferences: vi.fn(async () => []) };
const promptTemplateRepository = { findSystemReferences: vi.fn(async () => []) };
const assignmentRepository = { findAllForScope: vi.fn(async () => []), findForScopeSelector: vi.fn(async () => null) };
const workflowDefinitionRepository = { findSystemTemplates: vi.fn(async () => []) };
const workflowAssignmentRepository = { findAll: vi.fn(async () => []), findForScopeSelector: vi.fn(async () => null) };
const contextSchemaRepository = { findAll: vi.fn(async () => []), findByTenantAndSlug: vi.fn(async () => null) };
const documentTemplateRepository = { findAll: vi.fn(async () => []), findByTenantAndSlug: vi.fn(async () => null) };
const documentTemplateVersionRepository = { findByTemplateAndVersionNumber: vi.fn(async () => null) };
const databaseService = { baseClient: { __base: true } };

const workflowAssignments = { upsert: vi.fn(async () => ({})) };

const moduleRef = {
  get: vi.fn((token: unknown) => {
    if (token === IWorkflowAssignmentService) return workflowAssignments;
    throw new Error('not registered');
  }),
};
const cls = {
  get: vi.fn(() => undefined),
  set: vi.fn(),
  getId: vi.fn(() => 'cid'),
  run: vi.fn((optionsOrCallback: unknown, maybeCallback?: unknown) =>
    typeof optionsOrCallback === 'function' ? (optionsOrCallback as () => unknown)() : (maybeCallback as () => unknown)(),
  ),
};
const events = { emit: vi.fn() };

const make = () =>
  new TenantReferenceSetService(
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

const row = (overrides: Record<string, unknown> = {}) => ({
  id: 'wa-1',
  tenantId: SYSTEM,
  scope: PipelinePolicyScope.TENANT,
  scopeId: null,
  paletteKey: 'core',
  workflowDefinitionSlug: 'general-medicine-consultation',
  selectorKey: '',
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  workflowAssignmentRepository.findAll.mockResolvedValue([]);
  workflowAssignmentRepository.findForScopeSelector.mockResolvedValue(null);
  workflowAssignments.upsert.mockResolvedValue({});
});

describe('REFERENCE_SET_KINDS (TASK-930 §6.3)', () => {
  it('carries workflowAssignments immediately AFTER workflowDefinitions', () => {
    // Order is the whole point: an assignment names a definition slug that must already resolve
    // in the target tenant, exactly as agentAssignments follows agents.
    expect([...REFERENCE_SET_KINDS]).toEqual([
      'contextSchemas',
      'promptTemplates',
      'agents',
      'agentAssignments',
      'documentTemplates',
      'workflowDefinitions',
      'workflowAssignments',
    ]);
  });
});

describe('TenantReferenceSetService — workflowAssignments (TASK-930 §6.3)', () => {
  it('clones every TENANT-scope SYSTEM assignment into the tenant', async () => {
    workflowAssignmentRepository.findAll.mockResolvedValue([row(), row({ id: 'wa-2', paletteKey: 'core', selectorKey: 'new-visit' })] as any);

    const summary = await make().resync(TENANT, { kinds: ['workflowAssignments'] });

    expect(workflowAssignments.upsert).toHaveBeenCalledTimes(2);
    expect(workflowAssignments.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: PipelinePolicyScope.TENANT,
        scopeId: null,
        paletteKey: 'core',
        workflowDefinitionSlug: 'general-medicine-consultation',
        selectorTags: [],
      }),
    );
    // The tag-qualified variant keeps its selector — it is a different row of the same tier.
    expect(workflowAssignments.upsert).toHaveBeenCalledWith(expect.objectContaining({ selectorTags: ['new-visit'] }));
    expect(summary.kinds.workflowAssignments).toEqual({ added: 2, skipped: 0, failed: 0 });
  });

  it('skips DEPARTMENT-scope rows and SAYS SO — a department id is tenant topology, not content', async () => {
    workflowAssignmentRepository.findAll.mockResolvedValue([
      row(),
      row({ id: 'wa-dept', scope: PipelinePolicyScope.DEPARTMENT, scopeId: 'dept-of-the-source-tenant' }),
    ] as any);

    const summary = await make().resync(TENANT, { kinds: ['workflowAssignments'] });

    expect(workflowAssignments.upsert).toHaveBeenCalledTimes(1);
    expect(summary.kinds.workflowAssignments.skipped).toBe(1);
    expect(summary.warnings.some((warning) => /DEPARTMENT/.test(warning))).toBe(true);
  });

  it('is missing-only: a row the tenant already holds is never rewritten', async () => {
    workflowAssignmentRepository.findAll.mockResolvedValue([row()] as any);
    workflowAssignmentRepository.findForScopeSelector.mockResolvedValue({ id: 'tenant-owned' } as any);

    const summary = await make().resync(TENANT, { kinds: ['workflowAssignments'] });

    expect(workflowAssignments.upsert).not.toHaveBeenCalled();
    expect(summary.kinds.workflowAssignments).toEqual({ added: 0, skipped: 1, failed: 0 });
  });

  it('isolates a failing row and names it, rather than aborting the kind', async () => {
    workflowAssignmentRepository.findAll.mockResolvedValue([row(), row({ id: 'wa-2', workflowDefinitionSlug: 'not-here' })] as any);
    workflowAssignments.upsert.mockImplementation(async (dto: any) => {
      if (dto.workflowDefinitionSlug === 'not-here') throw new Error('no such published definition');
      return {};
    });

    const summary = await make().resync(TENANT, { kinds: ['workflowAssignments'] });

    expect(summary.kinds.workflowAssignments).toEqual({ added: 1, skipped: 0, failed: 1 });
    expect(summary.warnings.some((warning) => warning.includes('not-here'))).toBe(true);
  });

  it('reports a warning instead of throwing when the workflow-assignment service is not wired', async () => {
    workflowAssignmentRepository.findAll.mockResolvedValue([row()] as any);
    moduleRef.get.mockImplementation(() => {
      throw new Error('not registered');
    });

    const summary = await make().resync(TENANT, { kinds: ['workflowAssignments'] });

    expect(summary.kinds.workflowAssignments.failed).toBe(1);
    expect(summary.warnings.some((warning) => warning.startsWith('workflowAssignments:'))).toBe(true);
  });
});
