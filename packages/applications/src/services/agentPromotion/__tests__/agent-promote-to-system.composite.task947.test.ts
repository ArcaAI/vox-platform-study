/**
 * TASK-947 (OD-10) — promoting a COMPOSITE agent from Global into SYSTEM.
 *
 * Promotion's rule for a bound template is per BINDING, not per agent: a Global-owned template is
 * deep-copied into SYSTEM and re-bound, a SYSTEM-owned one is left alone (copying it would fork
 * the platform library). A composite binds several, so the rule has to run several times — and
 * the failure this file exists to catch is the quiet one, where fragment 0 is copied and
 * fragment 1 lands in SYSTEM still pointing at a row only the Global tenant can read.
 *
 * Idempotence matters more here than in the single-template case: two fragments may bind ONE
 * template, and promoting that agent must produce ONE copy, not two forks of the same lineage.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SYSTEM_TENANT_ID, WorkflowDefinitionStatus } from '@arcaai/domains';
import { AgentPromoteToSystemService } from '../agent-promote-to-system.service';

const GLOBAL = '50000000-0000-0000-0000-000000000000';

const mockClsService = {
  get: vi.fn(),
  set: vi.fn(),
  run: vi.fn((optionsOrCallback: unknown, maybeCallback?: unknown) =>
    (typeof optionsOrCallback === 'function' ? optionsOrCallback : (maybeCallback as () => unknown))(),
  ),
};
const mockEventEmitter = { emit: vi.fn() };
const mockAgentRepository = { findAllVersionsBySlug: vi.fn(), findOwnActiveBySlug: vi.fn(), findMaxVersionNumber: vi.fn(), create: vi.fn() };
const mockFallbackRepository = { findByAgentId: vi.fn(), create: vi.fn() };
const mockPromptTemplateRepository = { findById: vi.fn(), findByName: vi.fn(), findByTenantAndSourceTemplateId: vi.fn(), create: vi.fn() };
const mockPromptVersionRepository = { findByTemplate: vi.fn(), findByVersionNumber: vi.fn(), create: vi.fn() };
const mockContextSchemaRepository = { findById: vi.fn(), findByTenantAndSlug: vi.fn() };
const mockContextSchemaVersionRepository = { findBySchemaAndVersionNumber: vi.fn(), findLatestForSchema: vi.fn() };
const mockAiModelRepository = { findByIdOrNull: vi.fn(), findBySlug: vi.fn() };
const mockPromotionRepository = { create: vi.fn() };
const mockDatabaseService = { baseClient: { $transaction: vi.fn((cb: (tx: unknown) => unknown) => cb({})) } };
const mockAgentService = { publish: vi.fn() };
const mockContextSchemaService = { create: vi.fn(), publish: vi.fn() };
const mockModuleRef = {
  get: vi.fn((token: unknown) => {
    const description = typeof token === 'symbol' ? token.description : String(token);
    if (description === 'IAgentService') return mockAgentService;
    if (description === 'IConsultationContextSchemaService') return mockContextSchemaService;
    throw new Error(`no provider for ${String(description)}`);
  }),
};

const agent = (overrides: Record<string, unknown> = {}) => ({
  id: 'agent-global-1',
  tenantId: GLOBAL,
  slug: 'general-medicine-summarization',
  name: 'General medicine summarization',
  description: null,
  task: 'TEXT_GENERATION',
  versionNumber: 3,
  status: WorkflowDefinitionStatus.PUBLISHED,
  isActive: true,
  modelId: 'model-global-1',
  contextSchemaId: null,
  contextSchemaVersionNumber: null,
  instruction: { systemPrompt: 'x' },
  parameters: null,
  inputSchema: null,
  outputSchema: null,
  tools: null,
  tags: [],
  ...overrides,
});

function withId<T extends object>(entity: T, id: string): T {
  const saved = Object.assign(Object.create(Object.getPrototypeOf(entity) as object), entity) as T;
  Object.defineProperty(saved, 'id', { value: id, configurable: true, enumerable: true });
  return saved;
}

const construct = () =>
  new AgentPromoteToSystemService(
    mockAgentRepository as never,
    mockFallbackRepository as never,
    mockPromptTemplateRepository as never,
    mockPromptVersionRepository as never,
    mockContextSchemaRepository as never,
    mockContextSchemaVersionRepository as never,
    mockAiModelRepository as never,
    mockPromotionRepository as never,
    mockDatabaseService as never,
    mockModuleRef as never,
    mockEventEmitter as never,
    mockClsService as never,
  );

/** One Global-owned template row, as promotion reads it. */
const globalTemplate = (id: string, name: string) => ({
  id,
  tenantId: GLOBAL,
  name,
  description: null,
  content: `${id} draft`,
  category: 'consultation',
  status: 'APPROVED',
  approvedVersionNumber: 2,
  variables: null,
  tags: [],
});

let service: AgentPromoteToSystemService;

beforeEach(() => {
  vi.clearAllMocks();
  mockDatabaseService.baseClient.$transaction.mockImplementation((cb: (tx: unknown) => unknown) => cb({}));
  mockAgentRepository.findOwnActiveBySlug.mockResolvedValue(agent());
  mockAgentRepository.findAllVersionsBySlug.mockResolvedValue([agent()]);
  mockAgentRepository.findMaxVersionNumber.mockResolvedValue(4);
  mockAgentRepository.create.mockImplementation((created: object) => Promise.resolve(withId(created, 'agent-sys-5')));
  mockFallbackRepository.findByAgentId.mockResolvedValue([]);
  mockAiModelRepository.findByIdOrNull.mockResolvedValue({ id: 'model-sys-1', slug: 'gemma', tenantId: SYSTEM_TENANT_ID });
  mockPromotionRepository.create.mockImplementation((row: object) => Promise.resolve(withId(row, 'promo-agent-1')));
  mockAgentService.publish.mockResolvedValue({ id: 'agent-sys-5', slug: 'general-medicine-summarization', versionNumber: 5 });
  mockPromptTemplateRepository.findByTenantAndSourceTemplateId.mockResolvedValue(null);
  mockPromptTemplateRepository.findByName.mockResolvedValue(null);
  mockPromptVersionRepository.findByVersionNumber.mockImplementation(async (templateId: string) => ({
    id: `${templateId}-v2`,
    versionNumber: 2,
    content: `${templateId} approved`,
    variables: null,
  }));
  mockPromptVersionRepository.create.mockImplementation((row: unknown) => Promise.resolve(row));
  mockClsService.get.mockImplementation((key: string) => (key === 'user' ? { id: 'root-1', roles: ['SUPER_ADMIN'] } : undefined));
  service = construct();
});

const writtenInstruction = () =>
  (mockAgentRepository.create.mock.calls[0][0] as { instruction: Record<string, unknown> }).instruction as {
    fragments: Array<Record<string, unknown>>;
  };

describe('promotion deep-copies EVERY Global-owned fragment template (OD-10)', () => {
  it('copies both Global templates into SYSTEM and re-binds each fragment to its own copy', async () => {
    mockAgentRepository.findOwnActiveBySlug.mockResolvedValue(
      agent({
        instruction: {
          fragments: [
            { key: 'base', promptTemplateId: 'tpl-global-a', promptVersionNumber: 7 },
            { key: 'revisit', promptTemplateId: 'tpl-global-b', when: "context.visit_type == 'revisit'" },
            { key: 'peds', systemPrompt: 'The patient is a minor.', when: 'context.patient_age < 18' },
          ],
          variables: { a: { path: 'context.a' } },
          evalGate: { goldenSetId: 'gs-1' },
        },
      }),
    );
    mockPromptTemplateRepository.findById.mockImplementation(async (id: string) =>
      id === 'tpl-global-a' ? globalTemplate('tpl-global-a', 'Base') : globalTemplate('tpl-global-b', 'Revisit'),
    );
    let created = 0;
    mockPromptTemplateRepository.create.mockImplementation((row: object) => Promise.resolve(withId(row, `tpl-sys-${++created}`)));

    const result = await service.promoteToSystem({ sourceSlug: 'general-medicine-summarization', changeReason: 'r' });

    expect(result.copied.promptTemplates).toBe(2);
    expect(writtenInstruction().fragments).toEqual([
      // Each copy's lineage restarts at 1, so the source's pin is replaced, never carried.
      { key: 'base', promptTemplateId: 'tpl-sys-1', promptVersionNumber: 1 },
      { key: 'revisit', promptTemplateId: 'tpl-sys-2', promptVersionNumber: 1, when: "context.visit_type == 'revisit'" },
      { key: 'peds', systemPrompt: 'The patient is a minor.', when: 'context.patient_age < 18' },
    ]);
    // The eval gate never crosses — a golden set is encrypted PHI and not even its pointer travels.
    expect((mockAgentRepository.create.mock.calls[0][0] as { instruction: Record<string, unknown> }).instruction).not.toHaveProperty('evalGate');
  });

  it('leaves a SYSTEM-owned fragment template alone and copies only the Global one beside it', async () => {
    mockAgentRepository.findOwnActiveBySlug.mockResolvedValue(
      agent({
        instruction: {
          fragments: [
            { key: 'base', promptTemplateId: 'tpl-sys-9' },
            { key: 'revisit', promptTemplateId: 'tpl-global-b', when: 'true' },
          ],
        },
      }),
    );
    mockPromptTemplateRepository.findById.mockImplementation(async (id: string) =>
      id === 'tpl-sys-9' ? { id: 'tpl-sys-9', tenantId: SYSTEM_TENANT_ID, name: 'platform', status: 'APPROVED' } : globalTemplate(id, 'Revisit'),
    );
    mockPromptTemplateRepository.create.mockImplementation((row: object) => Promise.resolve(withId(row, 'tpl-sys-new')));

    const result = await service.promoteToSystem({ sourceSlug: 'general-medicine-summarization', changeReason: 'r' });

    expect(result.copied.promptTemplates).toBe(1);
    expect(writtenInstruction().fragments).toEqual([
      { key: 'base', promptTemplateId: 'tpl-sys-9' },
      { key: 'revisit', promptTemplateId: 'tpl-sys-new', promptVersionNumber: 1, when: 'true' },
    ]);
  });

  it('makes ONE copy when two fragments bind the SAME Global template', async () => {
    mockAgentRepository.findOwnActiveBySlug.mockResolvedValue(
      agent({
        instruction: {
          fragments: [
            { key: 'base', promptTemplateId: 'tpl-global-a' },
            { key: 'again', promptTemplateId: 'tpl-global-a', when: 'true' },
          ],
        },
      }),
    );
    mockPromptTemplateRepository.findById.mockImplementation(async (id: string) => globalTemplate(id, 'Base'));
    let created = 0;
    mockPromptTemplateRepository.create.mockImplementation((row: object) => Promise.resolve(withId(row, `tpl-sys-${++created}`)));

    const result = await service.promoteToSystem({ sourceSlug: 'general-medicine-summarization', changeReason: 'r' });

    expect(result.copied.promptTemplates).toBe(1);
    expect(mockPromptTemplateRepository.create).toHaveBeenCalledTimes(1);
    expect(writtenInstruction().fragments).toEqual([
      { key: 'base', promptTemplateId: 'tpl-sys-1', promptVersionNumber: 1 },
      { key: 'again', promptTemplateId: 'tpl-sys-1', promptVersionNumber: 1, when: 'true' },
    ]);
  });

  it('re-binds to an EXISTING SYSTEM copy rather than forking the lineage a second time', async () => {
    mockAgentRepository.findOwnActiveBySlug.mockResolvedValue(
      agent({ instruction: { fragments: [{ key: 'base', promptTemplateId: 'tpl-global-a', promptVersionNumber: 7 }] } }),
    );
    mockPromptTemplateRepository.findById.mockImplementation(async (id: string) => globalTemplate(id, 'Base'));
    mockPromptTemplateRepository.findByTenantAndSourceTemplateId.mockResolvedValue({ id: 'tpl-sys-existing', approvedVersionNumber: 3 });

    const result = await service.promoteToSystem({ sourceSlug: 'general-medicine-summarization', changeReason: 'r' });

    expect(result.copied.promptTemplates).toBe(0);
    expect(mockPromptTemplateRepository.create).not.toHaveBeenCalled();
    expect(writtenInstruction().fragments).toEqual([{ key: 'base', promptTemplateId: 'tpl-sys-existing', promptVersionNumber: 3 }]);
  });

  it('leaves a fragment whose template no longer reads as it is — publish reports it, this does not unbind it', async () => {
    mockAgentRepository.findOwnActiveBySlug.mockResolvedValue(
      agent({ instruction: { fragments: [{ key: 'base', promptTemplateId: 'tpl-gone', promptVersionNumber: 7 }] } }),
    );
    mockPromptTemplateRepository.findById.mockResolvedValue(null);

    const result = await service.promoteToSystem({ sourceSlug: 'general-medicine-summarization', changeReason: 'r' });

    expect(result.copied.promptTemplates).toBe(0);
    expect(writtenInstruction().fragments).toEqual([{ key: 'base', promptTemplateId: 'tpl-gone', promptVersionNumber: 7 }]);
  });
});
