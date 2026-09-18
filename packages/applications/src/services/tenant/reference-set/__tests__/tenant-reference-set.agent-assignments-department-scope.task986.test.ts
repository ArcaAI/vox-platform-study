/**
 * TASK-986 R3 (W6) — `copyAgentAssignments` made symmetric with its workflow twin.
 *
 * ## The gap
 *
 * `copyWorkflowAssignments` reads EVERY SYSTEM row, both scopes, precisely so a DEPARTMENT-scope
 * row's exclusion can be REPORTED (see its doc comment in `tenant-reference-set.service.ts`).
 * `copyAgentAssignments` read TENANT scope ONLY, via `findAllForScope(SYSTEM, PipelinePolicyScope
 * .TENANT, null, task)` — a DEPARTMENT-scope SYSTEM row was invisible to that query, so its
 * omission could never be reported. Today this is harmless (SYSTEM seeds only TENANT-scope agent
 * assignments), but the asymmetry means a DEPARTMENT-scope row added to SYSTEM later would be
 * dropped with no trace.
 *
 * This is a VISIBILITY fix only: a DEPARTMENT-scope row is still never copied — a department id
 * is tenant topology, not content, exactly as for `copyWorkflowAssignments`.
 *
 * Written RED-first: the first test here failed against the pre-fix code, which never queried
 * DEPARTMENT scope at all and so could neither skip nor warn about it.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentTask, PipelinePolicyScope } from '@arcaai/domains';
import { IAgentAssignmentService } from '../../../agent-assignment/IAgentAssignmentService';
import { TenantReferenceSetService } from '../tenant-reference-set.service';

const SYSTEM = '00000000-0000-0000-0000-000000000000';
const TENANT = 'tenant-1';

const agentRepository = { findSystemReferences: vi.fn(async () => []) };
const promptTemplateRepository = { findSystemReferences: vi.fn(async () => []) };
const assignmentRepository = {
  findAllForScope: vi.fn(async () => []),
  findForScopeSelector: vi.fn(async () => null),
  findAll: vi.fn(async () => []),
};
const workflowDefinitionRepository = { findSystemTemplates: vi.fn(async () => []) };
const workflowAssignmentRepository = { findAll: vi.fn(async () => []), findForScopeSelector: vi.fn(async () => null) };
const contextSchemaRepository = { findAll: vi.fn(async () => []), findByTenantAndSlug: vi.fn(async () => null) };
const documentTemplateRepository = { findAll: vi.fn(async () => []), findByTenantAndSlug: vi.fn(async () => null) };
const documentTemplateVersionRepository = { findByTemplateAndVersionNumber: vi.fn(async () => null) };
const databaseService = { baseClient: { __base: true } };

const assignments = { upsert: vi.fn(async () => ({})) };

const moduleRef = {
  get: vi.fn((token: unknown) => {
    if (token === IAgentAssignmentService) return assignments;
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
  id: 'aa-1',
  tenantId: SYSTEM,
  scope: PipelinePolicyScope.TENANT,
  scopeId: null,
  task: AgentTask.TEXT_GENERATION,
  agentSlug: 'platform-summarization',
  selectorKey: '',
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  assignmentRepository.findAllForScope.mockResolvedValue([]);
  assignmentRepository.findForScopeSelector.mockResolvedValue(null);
  assignmentRepository.findAll.mockResolvedValue([]);
  assignments.upsert.mockResolvedValue({});
});

describe('TenantReferenceSetService — agentAssignments DEPARTMENT-scope visibility (TASK-986 R3)', () => {
  it('reports a DEPARTMENT-scope SYSTEM agent assignment in warnings, and never copies it', async () => {
    assignmentRepository.findAll.mockResolvedValue([
      row({ id: 'aa-dept', scope: PipelinePolicyScope.DEPARTMENT, scopeId: 'dept-of-the-source-tenant' }),
    ] as any);

    const summary = await make().resync(TENANT, { kinds: ['agentAssignments'] });

    expect(assignments.upsert).not.toHaveBeenCalled();
    expect(summary.kinds.agentAssignments.skipped).toBe(1);
    expect(summary.warnings.some((warning) => warning.startsWith('agentAssignments:') && /DEPARTMENT/.test(warning))).toBe(true);
  });

  it('still clones a TENANT-scope SYSTEM agent assignment normally — the new scan changes nothing about the copy path', async () => {
    assignmentRepository.findAllForScope.mockImplementation(async (_t: string, _s: unknown, _i: unknown, task: AgentTask) =>
      task === AgentTask.TEXT_GENERATION ? [{ agentSlug: 'platform-summarization', selectorKey: '' }] : [],
    );
    assignmentRepository.findAll.mockResolvedValue([row()] as any);

    const summary = await make().resync(TENANT, { kinds: ['agentAssignments'] });

    expect(assignments.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ scope: PipelinePolicyScope.TENANT, task: AgentTask.TEXT_GENERATION, agentSlug: 'platform-summarization' }),
    );
    expect(summary.kinds.agentAssignments.added).toBe(1);
    expect(summary.warnings).toEqual([]);
  });
});
