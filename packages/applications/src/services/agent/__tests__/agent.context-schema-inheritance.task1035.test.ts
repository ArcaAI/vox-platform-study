/**
 * OD-6 / R1 — ONE schema choice: a workflow's trigger owns the context schema, and an agent that
 * a published workflow runs INHERITS it when it pins none of its own.
 *
 *  - publish checks the agent's prompt paths against its own schema, or — pinning none — against
 *    the trigger schema of a published workflow whose `core.agent` node names it;
 *  - the agent DETAIL reports which one, as `effectiveContextSchema`;
 *  - the seeded `case-notes-pre-summary` agents (SYSTEM / Global / ArcaAI) read nine
 *    `{{context.*}}` names and pin no schema. Those names are the gateway's own flat vocabulary
 *    (`PLATFORM_CONTEXT_VARIABLES`, bound by `PromptAssemblyService`), which no schema kind
 *    declares — so a TEXT_GENERATION agent's publish admits them under `context` beside whatever
 *    schema applies, and only a name neither declares is refused.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentTask, ResourceStatusType, SYSTEM_TENANT_ID, WorkflowDefinitionStatus } from '@arcaai/domains';
import { AgentService } from '../agent.service';
import { payloadSchemaFromDefinition } from '../../consultation-context-schema/context-schema-definition';
import { DEFAULT_PROMPT_TEMPLATES, TEMPLATE_IDS } from '../../../../../database/src/prisma/db_main/seed/07-prompt-template';
import {
  ARCAAI_CLINICAL_TEMPLATES,
  ARCAAI_CLINICAL_TEMPLATE_IDS,
} from '../../../../../database/src/prisma/db_main/seed/07b-arcaai-clinical-templates';
import {
  NOTE_CONTEXT_PROMPT_KIND,
  NOTE_CONTEXT_SCHEMA_DEFINITION,
} from '../../../../../database/src/prisma/db_main/seed/07e-consultation-note-context-schema';
import { PRE_SUMMARY_AGENT_SLUG, preSummaryPromptVariables } from '../../../../../database/src/prisma/db_main/seed/25-agents';

const TENANT = '50000000-0000-0000-0000-000000000000';
const NOTE_SCHEMA_ID = '79000000-0000-0000-0000-000000000001';

const clsStore: Record<string, unknown> = { tenantId: TENANT, user: { id: 'user-1', roles: [] } };
const mockClsService = { get: vi.fn((key: string) => clsStore[key]), set: vi.fn(), run: vi.fn(async (_o: unknown, work: () => unknown) => work()) };
const mockAgentRepository = {
  findByIdVisible: vi.fn(),
  findPublishedActiveBySlug: vi.fn(async () => null),
  findOwnActiveBySlug: vi.fn(async () => null),
  update: vi.fn(async (_id: string, entity: unknown) => entity),
};
const LLM_MODEL = {
  id: 'model-llm',
  tenantId: SYSTEM_TENANT_ID,
  slug: 'lms-gemma-4-e2b-it-qat',
  taskType: 'TEXT_GENERATION',
  provider: 'lm-studio',
  wireModelId: 'gemma-4-e2b-it-qat',
  resourceStatus: ResourceStatusType.ENABLED,
  metaData: null,
};
const templates = new Map<string, Record<string, unknown>>();
const mockPromptTemplateRepository = { findById: vi.fn(async (id: string) => templates.get(id) ?? null) };
const mockPromptVersionRepository = {
  findByVersionNumber: vi.fn(async (id: string, versionNumber: number) => {
    const template = templates.get(id);
    return template ? { versionNumber, content: template.content, variables: null } : null;
  }),
};
const mockContextSchemas = { resolveReference: vi.fn() };
const mockWorkflowDefinitions = { findActivePublishedByTenant: vi.fn() };

function putTemplate(id: string, content: string): void {
  templates.set(id, { id, name: id, status: 'APPROVED', content, approvedVersionNumber: 1, currentVersionNumber: 1, variables: null, tenantId: TENANT });
}

function agent(over: Record<string, unknown> = {}) {
  return {
    id: 'agent-1',
    tenantId: TENANT,
    slug: PRE_SUMMARY_AGENT_SLUG,
    name: 'Pre-summary',
    description: null,
    task: AgentTask.TEXT_GENERATION,
    versionNumber: 1,
    status: WorkflowDefinitionStatus.DRAFT,
    isActive: false,
    modelId: 'model-llm',
    contextSchemaId: null,
    contextSchemaVersionNumber: null,
    instruction: { promptTemplateId: 'tpl-pre', promptVersionNumber: 1, variables: preSummaryPromptVariables() },
    parameters: null,
    inputSchema: null,
    outputSchema: null,
    tools: null,
    tags: [],
    version: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
    resourceStatus: ResourceStatusType.ENABLED,
    validate: vi.fn(),
    ...over,
  } as never;
}

/** A published consultation graph whose `core.agent` node runs `slug`, its trigger bound to the note schema. */
function workflowRunning(slug: string) {
  return {
    slug: 'arcaai-general-consultation',
    contextSchemaId: NOTE_SCHEMA_ID,
    contextSchemaVersionNumber: 1,
    graph: { version: 1, nodes: [{ id: 'n_presummary', type: 'core.agent', config: { agentRef: { slug } } }], edges: [] },
  };
}

function makeService(withWorkflows = true) {
  return new AgentService(
    mockAgentRepository as never,
    { findByAgentId: vi.fn(async () => []) } as never,
    { findById: vi.fn(async () => LLM_MODEL), findByTaskTypeSharedRead: vi.fn(async () => []) } as never,
    { emit: vi.fn() } as never,
    mockClsService as never,
    { baseClient: { $transaction: vi.fn() } } as never,
    undefined as never,
    { resolveConnection: vi.fn(async () => ({ source: 'system', encryptedApiKey: new Uint8Array([1]) })), findRow: vi.fn() } as never,
    mockPromptTemplateRepository as never,
    mockPromptVersionRepository as never,
    undefined as never,
    undefined as never,
    mockContextSchemas as never,
    undefined as never,
    undefined as never,
    undefined as never,
    (withWorkflows ? mockWorkflowDefinitions : undefined) as never,
  );
}

async function findingsOf(entity: unknown, withWorkflows = true) {
  mockAgentRepository.findByIdVisible.mockResolvedValue(entity);
  const validated = await makeService(withWorkflows).validate('agent-1');
  return (validated.validationReport as unknown as { blocking: boolean; findings: Array<{ code: string; severity: string; message: string }> });
}

/** A trigger schema whose ONE kind is the prompt vocabulary — the single-kind collapse applies. */
const PROMPT_KIND_ONLY = { schemaVersion: '1.0', kinds: [NOTE_CONTEXT_PROMPT_KIND] };

function resolvesTo(definition: unknown): void {
  mockContextSchemas.resolveReference.mockResolvedValue({
    outcome: 'resolved',
    schemaId: NOTE_SCHEMA_ID,
    versionNumber: 1,
    versionId: 'note-v1',
    payloadSchema: payloadSchemaFromDefinition(definition),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  templates.clear();
  mockAgentRepository.update.mockImplementation(async (_id: string, entity: unknown) => entity);
  resolvesTo(PROMPT_KIND_ONLY);
  mockWorkflowDefinitions.findActivePublishedByTenant.mockResolvedValue([workflowRunning(PRE_SUMMARY_AGENT_SLUG)]);
});

describe('the seeded `case-notes-pre-summary` bodies, against an inherited schema', () => {
  const SYSTEM_BODY = String(DEFAULT_PROMPT_TEMPLATES.find((template) => template.id === TEMPLATE_IDS.PRE_SUMMARY_DEFAULT)!.content);
  const ARCAAI_BODY = String(ARCAAI_CLINICAL_TEMPLATES.find((template) => template.id === ARCAAI_CLINICAL_TEMPLATE_IDS.PRE_SUMMARY)!.content);

  it.each([
    ['SYSTEM / Global (the platform pre-summary body)', SYSTEM_BODY],
    ['ArcaAI (the department corpus v3 body)', ARCAAI_BODY],
  ])('%s: a SINGLE-kind trigger schema of the prompt vocabulary clears every reference', async (_label, body) => {
    putTemplate('tpl-pre', body);

    const report = await findingsOf(agent());

    expect(report.findings.filter((finding) => finding.code === 'PROMPT_VARIABLE_UNDECLARED')).toEqual([]);
    expect(report.blocking).toBe(false);
  });

  it.each([
    ['SYSTEM / Global', SYSTEM_BODY],
    ['ArcaAI', ARCAAI_BODY],
  ])('%s: WITHOUT a workflow running it, the platform vocabulary still publishes clean', async (_label, body) => {
    putTemplate('tpl-pre', body);

    const report = await findingsOf(agent(), false);

    expect(report.findings.filter((finding) => finding.code === 'PROMPT_VARIABLE_UNDECLARED')).toEqual([]);
    expect(report.blocking).toBe(false);
  });

  it.each([
    ['without a schema', false],
    ['with the inherited note schema', true],
  ])('a made-up `{{context.foo}}` is still refused as an ERROR (%s)', async (_label, withWorkflows) => {
    putTemplate('tpl-pre', `${SYSTEM_BODY}\n{{context.foo}}`);
    resolvesTo(NOTE_CONTEXT_SCHEMA_DEFINITION);

    const report = await findingsOf(agent(), withWorkflows);

    const undeclared = report.findings.filter((finding) => finding.code === 'PROMPT_VARIABLE_UNDECLARED');
    expect(report.blocking).toBe(true);
    expect(undeclared).toHaveLength(1);
    expect(undeclared[0]?.severity).toBe('ERROR');
    expect(undeclared[0]?.message).toContain('context.foo');
  });

  it.each([
    ['SYSTEM / Global', SYSTEM_BODY],
    ['ArcaAI', ARCAAI_BODY],
  ])('%s: under the SEEDED multi-kind `consultation_note_context` the platform vocabulary publishes clean', async (_label, body) => {
    putTemplate('tpl-pre', body);
    resolvesTo(NOTE_CONTEXT_SCHEMA_DEFINITION);

    const report = await findingsOf(agent());

    expect(report.findings.filter((finding) => finding.code === 'PROMPT_VARIABLE_UNDECLARED')).toEqual([]);
    expect(report.blocking).toBe(false);
  });
});

describe('inheritance rules', () => {
  it('a workflow that does NOT run this agent is no source', async () => {
    putTemplate('tpl-pre', 'Weight {{context.patient_weight}}.');
    mockWorkflowDefinitions.findActivePublishedByTenant.mockResolvedValue([workflowRunning('some-other-agent')]);

    const report = await findingsOf(agent({ instruction: { promptTemplateId: 'tpl-pre', promptVersionNumber: 1 } }));

    expect(report.findings.some((finding) => finding.code === 'PROMPT_VARIABLE_UNDECLARED')).toBe(true);
  });

  it('a name the inherited schema does not declare is still refused (a CLOSED kind)', async () => {
    resolvesTo({
      schemaVersion: '1.0',
      kinds: [
        {
          key: 'context',
          label: 'Context',
          primitive: 'STRUCTURED',
          phiClass: 'PHI',
          cardinality: 'ONE',
          lifecycle: 'ANY',
          producedBy: ['CLIENT'],
          fields: { type: 'object', additionalProperties: false, properties: { safe_age: { type: 'string' } } },
        },
      ],
    });
    putTemplate('tpl-pre', 'Age {{context.safe_age}}; {{context.not_in_the_schema}}.');

    const report = await findingsOf(agent({ instruction: { promptTemplateId: 'tpl-pre', promptVersionNumber: 1 } }));

    const undeclared = report.findings.filter((finding) => finding.code === 'PROMPT_VARIABLE_UNDECLARED');
    expect(undeclared).toHaveLength(1);
    expect(undeclared[0]?.message).toContain('context.not_in_the_schema');
  });

  it('is never frozen into the agent: the published artifact carries no context schema', async () => {
    putTemplate('tpl-pre', 'Age {{context.safe_age}}.');
    mockAgentRepository.findByIdVisible.mockResolvedValue(agent({ instruction: { promptTemplateId: 'tpl-pre', promptVersionNumber: 1 } }));

    const published = await makeService().publish('agent-1', { activate: false });

    expect((published.compiledConfig as { contextSchema?: unknown }).contextSchema ?? null).toBeNull();
  });
});

describe('the agent detail reports `effectiveContextSchema`', () => {
  it('inheritedFrom `workflow` for a schema-less agent a workflow runs', async () => {
    mockAgentRepository.findByIdVisible.mockResolvedValue(agent());

    const detail = await makeService().getById('agent-1');

    expect(detail.effectiveContextSchema).toEqual({ id: NOTE_SCHEMA_ID, versionNumber: 1, inheritedFrom: 'workflow' });
  });

  it('inheritedFrom `agent` when the agent pins its own', async () => {
    mockAgentRepository.findByIdVisible.mockResolvedValue(agent({ contextSchemaId: NOTE_SCHEMA_ID }));

    const detail = await makeService().getById('agent-1');

    expect(detail.effectiveContextSchema).toEqual({ id: NOTE_SCHEMA_ID, versionNumber: 1, inheritedFrom: 'agent' });
    expect(mockWorkflowDefinitions.findActivePublishedByTenant).not.toHaveBeenCalled();
  });

  it('null when neither applies', async () => {
    mockWorkflowDefinitions.findActivePublishedByTenant.mockResolvedValue([]);
    mockAgentRepository.findByIdVisible.mockResolvedValue(agent());

    const detail = await makeService().getById('agent-1');

    expect(detail.effectiveContextSchema).toBeNull();
  });
});
