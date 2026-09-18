/**
 * TASK-974 §5.1 item 2 — the reference set never CLONES a platform hidden agent.
 *
 * This is the half of D-1 that decides whose agent it is. TASK-890 OD-M made `Agent` CONTENT:
 * provisioning copies every PUBLISHED SYSTEM agent into the tenant, and the tenant then owns —
 * and may re-model — its copy. That is exactly wrong for a platform SERVICE agent, twice over:
 * a tenant could change the model the platform pays for, and a platform admin's model change
 * would be stranded in SYSTEM because re-sync is missing-only.
 *
 * So the clone is skipped, and it is REPORTED rather than silently dropped: `skipped` counts it
 * and a warning says why, so an operator reading a provisioning summary can tell "deliberately
 * not cloned" from "failed to clone".
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentTask } from '@arcaai/domains';
import { IAgentService } from '../../../agent/IAgentService';
import { IAgentAssignmentService } from '../../../agent-assignment/IAgentAssignmentService';
import { IConsultationContextSchemaService } from '../../../consultation-context-schema/IConsultationContextSchemaService';
import { IDocumentTemplateService } from '../../../document-template/IDocumentTemplateService';
import { IPromptManagementService } from '../../../prompt-management/IPromptManagementService';
import { IWorkflowDefinitionService } from '../../../workflow-definition/IWorkflowDefinitionService';
import { DNA_WRITING_STYLE_ANALYST_SLUG } from '../../../agent/platform-hidden-agents';
import { TenantReferenceSetService } from '../tenant-reference-set.service';

const TENANT = 'tenant-1';

const agentRepository = { findSystemReferences: vi.fn() };
const promptTemplateRepository = { findSystemReferences: vi.fn(async () => []) };
const assignmentRepository = {
  findAllForScope: vi.fn(async () => []),
  findForScopeSelector: vi.fn(async () => null),
  // TASK-986 R3 — `copyAgentAssignments` now also runs a read-only scan over every SYSTEM row
  // (any scope) to report a DEPARTMENT-scope omission; empty here, unrelated to this file's focus.
  findAll: vi.fn(async () => []),
};
const workflowDefinitionRepository = { findSystemTemplates: vi.fn(async () => []) };
const workflowAssignmentRepository = { findAll: vi.fn(async () => []), findForScopeSelector: vi.fn(async () => null) };
const contextSchemaRepository = { findAll: vi.fn(async () => []), findByTenantAndSlug: vi.fn(async () => null) };
const documentTemplateRepository = { findAll: vi.fn(async () => []), findByTenantAndSlug: vi.fn(async () => null) };
const documentTemplateVersionRepository = { findByTemplateAndVersionNumber: vi.fn() };
const databaseService = { baseClient: { __base: true } };

const agents = { cloneFromSystem: vi.fn(async () => ({ agentId: 'a1', created: true, warnings: [] })) };
const prompts = { cloneFromSystem: vi.fn() };
const workflows = { cloneFromSystem: vi.fn() };
const contextSchemas = { cloneFromSystem: vi.fn() };
const assignments = { upsert: vi.fn(async () => ({})) };
const documentTemplates = { create: vi.fn(), publish: vi.fn() };

const PORTS = new Map<unknown, unknown>([
  [IAgentService, agents],
  [IPromptManagementService, prompts],
  [IWorkflowDefinitionService, workflows],
  [IConsultationContextSchemaService, contextSchemas],
  [IAgentAssignmentService, assignments],
  [IDocumentTemplateService, documentTemplates],
]);

const moduleRef = {
  get: vi.fn((token: unknown) => {
    if (PORTS.has(token)) return PORTS.get(token);
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
  moduleRef.get.mockImplementation((token: unknown) => {
    if (PORTS.has(token)) return PORTS.get(token);
    throw new Error('not registered');
  });
  agents.cloneFromSystem.mockImplementation(async () => ({ agentId: 'a1', created: true, warnings: [] }));
  assignments.upsert.mockImplementation(async () => ({}));
  assignmentRepository.findAllForScope.mockImplementation(async (_t: string, _s: unknown, _i: unknown, task: AgentTask) =>
    task === AgentTask.TEXT_GENERATION ? [{ agentSlug: 'platform-summarization', selectorKey: '' }] : [],
  );
});

describe('TenantReferenceSetService — a platform hidden agent is never provisioned', () => {
  beforeEach(() => {
    agentRepository.findSystemReferences.mockResolvedValue([{ slug: 'platform-summarization' }, { slug: DNA_WRITING_STYLE_ANALYST_SLUG }] as never);
  });

  it('clones every other SYSTEM agent and skips the hidden one', async () => {
    await make().provision(TENANT);

    const cloned = agents.cloneFromSystem.mock.calls.map((call: unknown[]) => call[0]);
    expect(cloned).toEqual(['platform-summarization']);
    expect(cloned).not.toContain(DNA_WRITING_STYLE_ANALYST_SLUG);
  });

  it('counts the skip and says WHY — a silent omission is indistinguishable from a failed copy', async () => {
    const summary = await make().provision(TENANT);

    expect(summary.kinds.agents.added).toBe(1);
    expect(summary.kinds.agents.skipped).toBe(1);
    expect(summary.kinds.agents.failed).toBe(0);
    expect(summary.warnings).toEqual(expect.arrayContaining([expect.stringContaining(DNA_WRITING_STYLE_ANALYST_SLUG)]));
    expect(summary.warnings.find((w: string) => w.includes(DNA_WRITING_STYLE_ANALYST_SLUG))).toMatch(/platform/i);
  });
});
