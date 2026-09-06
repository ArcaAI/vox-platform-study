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
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { BadRequestException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentTask, PipelinePolicyScope } from '@arcaai/domains';
import { IAgentService } from '../../../agent/IAgentService';
import { IAgentAssignmentService } from '../../../agent-assignment/IAgentAssignmentService';
import { IConsultationContextSchemaService } from '../../../consultation-context-schema/IConsultationContextSchemaService';
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
const contextSchemaRepository = { findAll: vi.fn(), findByTenantAndSlug: vi.fn() };
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

const PORTS = new Map<unknown, unknown>([
  [IAgentService, agents],
  [IPromptManagementService, prompts],
  [IWorkflowDefinitionService, workflows],
  [IConsultationContextSchemaService, contextSchemas],
  [IAgentAssignmentService, assignments],
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
    contextSchemaRepository as never,
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
  contextSchemaRepository.findAll.mockResolvedValue([{ slug: 'consultation_legacy_v1' }]);
  contextSchemaRepository.findByTenantAndSlug.mockResolvedValue(null);
  promptTemplateRepository.findSystemReferences.mockResolvedValue([{ id: 'sys-prompt', name: 'CATCHALL_SOAP', scope: 'TENANT_DEFAULT' }]);
  agentRepository.findSystemReferences.mockResolvedValue([{ slug: 'platform-summarization' }]);
  assignmentRepository.findAllForScope.mockImplementation(async (_t: string, _s: unknown, _i: unknown, task: AgentTask) =>
    task === AgentTask.TEXT_GENERATION ? [{ agentSlug: 'platform-summarization', selectorKey: '' }] : [],
  );
  assignmentRepository.findForScopeSelector.mockResolvedValue(null);
  workflowDefinitionRepository.findSystemTemplates.mockResolvedValue([{ slug: 'platform-default-summarization' }]);
});

describe('TenantReferenceSetService.provision', () => {
  it('copies every kind in the order the runtime requires: schemas, prompts, agents, assignments, workflows', async () => {
    const summary = await make().provision(TENANT);

    expect(calls).toEqual([
      'schema:consultation_legacy_v1',
      'prompt:sys-prompt',
      'agent:platform-summarization',
      'assignment:TEXT_GENERATION:platform-summarization',
      'workflow:platform-default-summarization',
    ]);
    expect(summary.mode).toBe('missing-only');
    expect(summary.warnings).toEqual([]);
    expect(summary.kinds.contextSchemas.added).toBe(1);
    expect(summary.kinds.promptTemplates.added).toBe(1);
    expect(summary.kinds.agents.added).toBe(1);
    expect(summary.kinds.agentAssignments.added).toBe(1);
    expect(summary.kinds.workflowDefinitions.added).toBe(1);
  });

  it('clones NO AiModel and NO GlobalSetting row — the catalogue and the platform settings are CONFIG (OD-O, OD-P)', async () => {
    const summary = await make().provision(TENANT);
    // The service has no model or setting repository at all; the assertion that matters is that
    // the kind set is closed, so a future addition has to be a deliberate edit here.
    expect(Object.keys(summary.kinds)).toEqual(['contextSchemas', 'promptTemplates', 'agents', 'agentAssignments', 'workflowDefinitions']);
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
