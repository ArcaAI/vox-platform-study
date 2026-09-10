/**
 * TASK-947 §4.1 — PUBLISH of a composite instruction (`instruction.fragments[]`).
 *
 * What these tests pin, and why each matters:
 *
 *  1. **Every fragment is resolved and FROZEN**, exactly as the single template is today: an
 *     approved template at the pinned (or approved, or current) version, an inline body verbatim.
 *     The whole point of the freeze is that a template edited tomorrow cannot change what a
 *     published agent renders — losing it for fragment 2 would lose it for the whole agent.
 *  2. **`content` is the STATIC PROJECTION** (OD-3): the unconditional fragments joined. A reader
 *     that predates this ticket does `resolvedPrompt.content` and gets the base prompt rather
 *     than nothing — the failure mode `resolvedPrompt: null` would have produced.
 *  3. **Findings are per fragment, by PATH.** `instruction.fragments[2].promptTemplateId` tells an
 *     author which row to fix; `instruction` does not.
 *  4. **The checksum covers the composition.** Two agents that differ only in a `when` are
 *     different artifacts, because they select different fragments at run time.
 *  5. **Forms 1 and 2 are byte-identical to today.** The composite path is additive; the two
 *     pre-947 shapes are what every published agent in every environment already carries.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentTask, ResourceStatusType, SYSTEM_TENANT_ID, WorkflowDefinitionStatus } from '@arcaai/domains';
import { AgentService } from '../agent.service';

const TENANT = '50000000-0000-0000-0000-000000000000';

const clsStore: Record<string, unknown> = { tenantId: TENANT, user: { id: 'user-1', roles: [] } };
const mockClsService = {
  get: vi.fn((key: string) => clsStore[key]),
  set: vi.fn((key: string, value: unknown) => {
    clsStore[key] = value;
  }),
  run: vi.fn(async (_options: unknown, work: () => unknown) => work()),
};
const mockEventEmitter = { emit: vi.fn() };
const mockAgentRepository = {
  findByIdVisible: vi.fn(),
  findPublishedActiveBySlug: vi.fn(async () => null),
  findOwnActiveBySlug: vi.fn(async () => null),
  update: vi.fn(async (_id: string, entity: unknown) => entity),
};
const mockFallbackRepository = { findByAgentId: vi.fn(async () => []) };
const LLM_MODEL = {
  id: 'model-llm',
  tenantId: SYSTEM_TENANT_ID,
  slug: 'lms-gemma-4-e2b-it-qat',
  taskType: 'TEXT_GENERATION',
  provider: 'lm-studio',
  sourceUri: 'gemma-4-e2b-it-qat',
  wireModelId: 'gemma-4-e2b-it-qat',
  resourceStatus: ResourceStatusType.ENABLED,
  metaData: null,
};
const mockAiModelRepository = { findById: vi.fn(async () => LLM_MODEL), findByTaskTypeSharedRead: vi.fn(async () => []) };

/** Template rows by id, so a composite can bind several and each resolve on its own. */
const templates = new Map<string, Record<string, unknown>>();
const versions = new Map<string, Record<string, unknown>>();
const mockPromptTemplateRepository = { findById: vi.fn(async (id: string) => templates.get(id) ?? null) };
const mockPromptVersionRepository = {
  findByVersionNumber: vi.fn(async (templateId: string, versionNumber: number) => versions.get(`${templateId}#${versionNumber}`) ?? null),
};
const mockDatabaseService = { baseClient: { $transaction: vi.fn((cb: (tx: unknown) => unknown) => cb({})) } };
const mockProviderConnections = {
  resolveConnection: vi.fn(async () => ({ source: 'system', encryptedApiKey: new Uint8Array([1]) })),
  findRow: vi.fn(async () => null),
};

function putTemplate(
  id: string,
  content: string,
  over: { status?: string; approvedVersionNumber?: number | null; currentVersionNumber?: number | null; variables?: unknown } = {},
): void {
  const approved = over.approvedVersionNumber === undefined ? 1 : over.approvedVersionNumber;
  templates.set(id, {
    id,
    name: `Template ${id}`,
    status: over.status ?? 'APPROVED',
    content,
    approvedVersionNumber: approved,
    currentVersionNumber: over.currentVersionNumber ?? approved,
    variables: over.variables ?? null,
    tenantId: TENANT,
  });
  if (approved !== null) versions.set(`${id}#${approved}`, { versionNumber: approved, content, variables: over.variables ?? null });
}

function putVersion(templateId: string, versionNumber: number, content: string, variables: unknown = null): void {
  versions.set(`${templateId}#${versionNumber}`, { versionNumber, content, variables });
}

function agent(instruction: unknown, over: Record<string, unknown> = {}) {
  return {
    id: 'agent-1',
    tenantId: TENANT,
    slug: 'clinic-summarizer',
    name: 'Clinic summarizer',
    description: null,
    task: AgentTask.TEXT_GENERATION,
    versionNumber: 1,
    status: WorkflowDefinitionStatus.DRAFT,
    isActive: false,
    modelId: 'model-llm',
    contextSchemaId: null,
    contextSchemaVersionNumber: null,
    instruction,
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

function makeService() {
  return new AgentService(
    mockAgentRepository as never,
    mockFallbackRepository as never,
    mockAiModelRepository as never,
    mockEventEmitter as never,
    mockClsService as never,
    mockDatabaseService as never,
    undefined as never,
    mockProviderConnections as never,
    mockPromptTemplateRepository as never,
    mockPromptVersionRepository as never,
  );
}

/** Publish the agent and hand back the stamped `compiledConfig`. */
async function publish(instruction: unknown): Promise<Record<string, unknown>> {
  mockAgentRepository.findByIdVisible.mockResolvedValue(agent(instruction));
  const published = await makeService().publish('agent-1', { activate: false });
  return published.compiledConfig as unknown as Record<string, unknown>;
}

/** Validate (never throws on a blocking finding) and hand back the findings. */
async function validateFindings(instruction: unknown): Promise<Array<{ code: string; path: string; severity: string; message: string }>> {
  mockAgentRepository.findByIdVisible.mockResolvedValue(agent(instruction));
  const validated = await makeService().validate('agent-1');
  return (validated.validationReport as unknown as { findings: Array<{ code: string; path: string; severity: string; message: string }> }).findings;
}

beforeEach(() => {
  vi.clearAllMocks();
  templates.clear();
  versions.clear();
  clsStore.tenantId = TENANT;
  clsStore.user = { id: 'user-1', roles: [] };
  mockClsService.get.mockImplementation((key: string) => clsStore[key]);
  mockAiModelRepository.findById.mockResolvedValue(LLM_MODEL);
  mockFallbackRepository.findByAgentId.mockResolvedValue([]);
  mockAgentRepository.update.mockImplementation(async (_id: string, entity: unknown) => entity);
  mockPromptTemplateRepository.findById.mockImplementation(async (id: string) => templates.get(id) ?? null);
  mockPromptVersionRepository.findByVersionNumber.mockImplementation(
    async (templateId: string, versionNumber: number) => versions.get(`${templateId}#${versionNumber}`) ?? null,
  );
});

describe('publish freezes a composite instruction (§4.1, OD-3)', () => {
  it('stamps every fragment beside its authored `when`, with `content` as the static projection', async () => {
    putTemplate('tpl-base', 'You are a scribe.');
    putTemplate('tpl-revisit', 'This is a follow-up visit.', { approvedVersionNumber: 5 });

    const compiled = await publish({
      fragments: [
        { key: 'base', promptTemplateId: 'tpl-base', promptVersionNumber: 1 },
        { key: 'revisit', promptTemplateId: 'tpl-revisit', when: "has(context.visit_type) && context.visit_type == 'revisit'" },
        { key: 'peds', systemPrompt: 'The patient is a minor.', when: 'has(context.patient_age) && context.patient_age < 18' },
      ],
    });

    expect(compiled.resolvedPrompt).toEqual({
      source: 'composite',
      join: '\n\n',
      content: 'You are a scribe.',
      fragments: [
        { key: 'base', source: 'template', promptTemplateId: 'tpl-base', promptVersionNumber: 1, content: 'You are a scribe.', when: null },
        {
          key: 'revisit',
          source: 'template',
          promptTemplateId: 'tpl-revisit',
          promptVersionNumber: 5,
          content: 'This is a follow-up visit.',
          when: "has(context.visit_type) && context.visit_type == 'revisit'",
        },
        { key: 'peds', source: 'inline', content: 'The patient is a minor.', when: 'has(context.patient_age) && context.patient_age < 18' },
      ],
    });
  });

  it('joins SEVERAL unconditional fragments into the static projection, in authored order', async () => {
    putTemplate('tpl-a', 'A');
    const compiled = await publish({
      fragments: [
        { key: 'frag_a', promptTemplateId: 'tpl-a' },
        { key: 'frag_b', systemPrompt: 'B' },
        { key: 'frag_c', systemPrompt: 'C', when: 'true' },
      ],
    });
    expect((compiled.resolvedPrompt as { content: string }).content).toBe('A\n\nB');
  });

  it('follows the pin rule per fragment: explicit pin, else approved, else current', async () => {
    putTemplate('tpl-pinned', 'v-approved', { approvedVersionNumber: 4 });
    putVersion('tpl-pinned', 2, 'v2');
    putTemplate('tpl-current', 'from-current', { approvedVersionNumber: null, currentVersionNumber: 7 });
    putVersion('tpl-current', 7, 'v7');

    const compiled = await publish({
      fragments: [
        { key: 'pinned', promptTemplateId: 'tpl-pinned', promptVersionNumber: 2 },
        { key: 'approved', promptTemplateId: 'tpl-pinned' },
        { key: 'current', promptTemplateId: 'tpl-current' },
      ],
    });

    expect((compiled.resolvedPrompt as { fragments: Array<Record<string, unknown>> }).fragments).toEqual([
      { key: 'pinned', source: 'template', promptTemplateId: 'tpl-pinned', promptVersionNumber: 2, content: 'v2', when: null },
      { key: 'approved', source: 'template', promptTemplateId: 'tpl-pinned', promptVersionNumber: 4, content: 'v-approved', when: null },
      { key: 'current', source: 'template', promptTemplateId: 'tpl-current', promptVersionNumber: 7, content: 'v7', when: null },
    ]);
  });

  it('makes two agents that differ ONLY in a `when` different artifacts (the checksum covers the composition)', async () => {
    putTemplate('tpl-base', 'Base');
    putTemplate('tpl-extra', 'Extra');
    const listing = (when: string | undefined) => ({
      fragments: [
        { key: 'base', promptTemplateId: 'tpl-base' },
        { key: 'extra', promptTemplateId: 'tpl-extra', ...(when === undefined ? {} : { when }) },
      ],
    });

    mockAgentRepository.findByIdVisible.mockResolvedValue(agent(listing("context.visit_type == 'revisit'")));
    const first = await makeService().publish('agent-1', { activate: false });
    mockAgentRepository.findByIdVisible.mockResolvedValue(agent(listing("context.visit_type == 'new'")));
    const second = await makeService().publish('agent-1', { activate: false });

    expect(first.compiledConfigChecksum).toMatch(/^sha256:/);
    expect(second.compiledConfigChecksum).not.toBe(first.compiledConfigChecksum);
  });
});

describe('publish reports a broken fragment BY PATH (§4.1)', () => {
  it('names the fragment whose template is missing', async () => {
    putTemplate('tpl-base', 'Base');
    const findings = await validateFindings({
      fragments: [
        { key: 'base', promptTemplateId: 'tpl-base' },
        { key: 'gone', promptTemplateId: 'tpl-gone', when: 'true' },
      ],
    });
    expect(findings).toContainEqual(
      expect.objectContaining({ code: 'TEMPLATE_NOT_FOUND', path: 'instruction.fragments[1].promptTemplateId', severity: 'ERROR' }),
    );
  });

  it('names the fragment whose template is not APPROVED', async () => {
    putTemplate('tpl-base', 'Base');
    putTemplate('tpl-draft', 'Draft', { status: 'DRAFT' });
    const findings = await validateFindings({
      fragments: [
        { key: 'base', promptTemplateId: 'tpl-base' },
        { key: 'draft', promptTemplateId: 'tpl-draft', when: 'true' },
      ],
    });
    expect(findings).toContainEqual(
      expect.objectContaining({ code: 'TEMPLATE_NOT_APPROVED', path: 'instruction.fragments[1].promptTemplateId', severity: 'ERROR' }),
    );
  });

  it('names the fragment whose pinned version does not exist', async () => {
    putTemplate('tpl-base', 'Base');
    const findings = await validateFindings({
      fragments: [
        { key: 'base', promptTemplateId: 'tpl-base' },
        { key: 'pinned', promptTemplateId: 'tpl-base', promptVersionNumber: 99, when: 'true' },
      ],
    });
    expect(findings).toContainEqual(
      expect.objectContaining({ code: 'TEMPLATE_VERSION_NOT_FOUND', path: 'instruction.fragments[1].promptVersionNumber', severity: 'ERROR' }),
    );
  });

  it('reports EVERY broken fragment at once, not just the first', async () => {
    putTemplate('tpl-base', 'Base');
    const findings = await validateFindings({
      fragments: [
        { key: 'base', promptTemplateId: 'tpl-base' },
        { key: 'gone_a', promptTemplateId: 'tpl-gone-a', when: 'true' },
        { key: 'gone_b', promptTemplateId: 'tpl-gone-b', when: 'true' },
      ],
    });
    expect(findings.filter((finding) => finding.code === 'TEMPLATE_NOT_FOUND').map((finding) => finding.path)).toEqual([
      'instruction.fragments[1].promptTemplateId',
      'instruction.fragments[2].promptTemplateId',
    ]);
  });

  it('refuses to publish a composite whose fragment does not resolve', async () => {
    putTemplate('tpl-base', 'Base');
    mockAgentRepository.findByIdVisible.mockResolvedValue(
      agent({
        fragments: [
          { key: 'base', promptTemplateId: 'tpl-base' },
          { key: 'gone', promptTemplateId: 'tpl-gone', when: 'true' },
        ],
      }),
    );
    await expect(makeService().publish('agent-1', {})).rejects.toMatchObject({ response: { code: 'TEMPLATE_NOT_FOUND' } });
  });
});

describe('per-fragment template checks (§4.4 item 2)', () => {
  it('reports a syntax error in ONE fragment at that fragment’s path', async () => {
    putTemplate('tpl-base', 'Base');
    putTemplate('tpl-bad', 'Broken {{ ');
    const findings = await validateFindings({
      fragments: [
        { key: 'base', promptTemplateId: 'tpl-base' },
        { key: 'bad', promptTemplateId: 'tpl-bad', when: 'true' },
      ],
    });
    expect(findings).toContainEqual(
      expect.objectContaining({ code: 'PROMPT_TEMPLATE_SYNTAX', path: 'instruction.fragments[1]', severity: 'ERROR' }),
    );
  });

  it('warns about an undeclared reference inside a fragment, at that fragment’s path', async () => {
    putTemplate('tpl-base', 'Base');
    const findings = await validateFindings({
      fragments: [
        { key: 'base', promptTemplateId: 'tpl-base' },
        { key: 'inline', systemPrompt: 'Ward {{ward}}', when: 'true' },
      ],
    });
    expect(findings).toContainEqual(
      expect.objectContaining({ code: 'PROMPT_VARIABLE_UNDECLARED', path: 'instruction.fragments[1]', severity: 'WARNING' }),
    );
  });

  it('WARNS when a `when` reads a root that is neither a scope root nor a bound name', async () => {
    putTemplate('tpl-base', 'Base');
    const findings = await validateFindings({
      fragments: [
        { key: 'base', promptTemplateId: 'tpl-base' },
        { key: 'odd', systemPrompt: 'x', when: 'patient.age > 18' },
      ],
    });
    expect(findings).toContainEqual(
      expect.objectContaining({ code: 'PROMPT_FRAGMENT_CONDITION_ROOT', path: 'instruction.fragments[1].when', severity: 'WARNING' }),
    );
  });

  it('accepts a `when` over a scope root or a BOUND variable name without warning', async () => {
    putTemplate('tpl-base', 'Base');
    const findings = await validateFindings({
      fragments: [
        { key: 'base', promptTemplateId: 'tpl-base' },
        { key: 'ctx', systemPrompt: 'x', when: 'has(context.visit_type)' },
        { key: 'bound', systemPrompt: 'y', when: "ward == '3'" },
      ],
      variables: { ward: { path: 'context.ward' } },
    });
    expect(findings.filter((finding) => finding.code === 'PROMPT_FRAGMENT_CONDITION_ROOT')).toEqual([]);
  });

  it('ERRORS when two TEMPLATE fragments declare one variable name with different types (OD-8)', async () => {
    putTemplate('tpl-a', '{{age}}', { variables: [{ name: 'age', type: 'number', required: false }] });
    putTemplate('tpl-b', '{{age}}', { variables: [{ name: 'age', type: 'string', required: false }] });
    const findings = await validateFindings({
      fragments: [
        { key: 'frag_a', promptTemplateId: 'tpl-a' },
        { key: 'frag_b', promptTemplateId: 'tpl-b', when: 'true' },
      ],
      variables: { age: { path: 'context.age' } },
    });
    expect(findings).toContainEqual(expect.objectContaining({ code: 'PROMPT_VARIABLE_CONFLICT', severity: 'ERROR' }));
  });

  it('does NOT report a conflict when the two fragments agree on the type', async () => {
    putTemplate('tpl-a', '{{age}}', { variables: [{ name: 'age', type: 'number', required: false }] });
    putTemplate('tpl-b', '{{age}}', { variables: [{ name: 'age', type: 'number', required: false }] });
    const findings = await validateFindings({
      fragments: [
        { key: 'frag_a', promptTemplateId: 'tpl-a' },
        { key: 'frag_b', promptTemplateId: 'tpl-b', when: 'true' },
      ],
      variables: { age: { path: 'context.age' } },
    });
    expect(findings.filter((finding) => finding.code === 'PROMPT_VARIABLE_CONFLICT')).toEqual([]);
  });
});

describe('the two pre-947 forms are untouched', () => {
  it('form 1 (template) still compiles to the flat `template` shape', async () => {
    putTemplate('tpl-1', 'SOAP {{context.clinic}}');
    const compiled = await publish({ promptTemplateId: 'tpl-1', promptVersionNumber: 1 });
    expect(compiled.resolvedPrompt).toEqual({
      source: 'template',
      promptTemplateId: 'tpl-1',
      promptVersionNumber: 1,
      content: 'SOAP {{context.clinic}}',
    });
  });

  it('form 2 (inline) still compiles to the flat `inline` shape', async () => {
    const compiled = await publish({ systemPrompt: 'You are a scribe.' });
    expect(compiled.resolvedPrompt).toEqual({ source: 'inline', content: 'You are a scribe.' });
  });

  it('form 1 still reports a missing template at `instruction.promptTemplateId`', async () => {
    const findings = await validateFindings({ promptTemplateId: 'tpl-gone' });
    expect(findings).toContainEqual(expect.objectContaining({ code: 'TEMPLATE_NOT_FOUND', path: 'instruction.promptTemplateId' }));
  });
});
