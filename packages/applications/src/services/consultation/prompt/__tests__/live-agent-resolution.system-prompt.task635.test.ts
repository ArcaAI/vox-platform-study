/**
 * CLOSED. Custom per-agent live system prompt.
 *
 * `LiveAgentResolutionService#systemPromptFor` now reads the resolved live
 * template's `metaData.promptConfig.systemPrompt` (surfaced via a
 * hand-authored accessor on `PromptTemplateEntity`, mirroring the
 * `DepartmentAgentEntity` / `AiModelEntity` precedent — `IBaseEntity.metaData`
 * is declared but not wired on the abstract base) and falls back to the
 * in-code `LIVE_DOCUMENT_SYSTEM_PROMPT` constant when the value is absent or
 * malformed. `metaData` is untrusted JSON: these tests lock the defensive
 * parsing AND the resolver's totality contract (never throws — step 4).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

import { LiveAgentResolutionService } from '../live-agent-resolution.service';
import { LIVE_DOCUMENT_STABLE_SYSTEM_PREFIX, LIVE_DOCUMENT_SYSTEM_PROMPT } from '../../live-documentation/live-documentation.service';

const TENANT = 'tenant-1';
const CONSULTATION = 'consultation-1';
const TEMPLATE = 'tpl-1';

function baseResolved(overrides: Record<string, unknown> = {}) {
  return {
    resolvedFrom: 'default',
    promptId: TEMPLATE,
    content: LIVE_DOCUMENT_STABLE_SYSTEM_PREFIX,
    resolvedVersionNumber: 1,
    resolvedAgentId: undefined,
    ...overrides,
  };
}

describe('LiveAgentResolutionService — custom per-agent system prompt', () => {
  let consultationRepository: { findById: ReturnType<typeof vi.fn> };
  let promptResolutionService: { resolve: ReturnType<typeof vi.fn> };
  let departmentAgentRepository: { findById: ReturnType<typeof vi.fn> };
  let promptVersionRepository: { findByVersionNumber: ReturnType<typeof vi.fn> };
  let aiModelRepository: { findAll: ReturnType<typeof vi.fn> };
  let promptTemplateRepository: { findById: ReturnType<typeof vi.fn> };
  let service: LiveAgentResolutionService;

  beforeEach(() => {
    consultationRepository = { findById: vi.fn().mockResolvedValue({ id: CONSULTATION, tenantId: TENANT, departmentId: null }) };
    promptResolutionService = { resolve: vi.fn().mockResolvedValue(baseResolved()) };
    departmentAgentRepository = { findById: vi.fn() };
    promptVersionRepository = { findByVersionNumber: vi.fn() };
    aiModelRepository = { findAll: vi.fn() };
    promptTemplateRepository = { findById: vi.fn() };

    service = new LiveAgentResolutionService(
      consultationRepository as never,
      promptResolutionService as never,
      departmentAgentRepository as never,
      promptVersionRepository as never,
      aiModelRepository as never,
      promptTemplateRepository as never,
    );
  });

  it('uses metaData.promptConfig.systemPrompt when it is a non-empty string', async () => {
    promptTemplateRepository.findById.mockResolvedValue({
      id: TEMPLATE,
      metaData: { promptConfig: { systemPrompt: 'Custom agent system prompt.' } },
    });

    const snapshot = await service.resolveForSession({ consultationId: CONSULTATION, tenantId: TENANT });

    expect(snapshot.systemPrompt).toBe('Custom agent system prompt.');
    expect(promptTemplateRepository.findById).toHaveBeenCalledWith(TEMPLATE);
  });

  it.each([
    ['metaData is null', { id: TEMPLATE, metaData: null }],
    ['metaData is absent', { id: TEMPLATE }],
  ])('falls back to the code-default system prompt when %s', async (_label, template) => {
    promptTemplateRepository.findById.mockResolvedValue(template);

    const snapshot = await service.resolveForSession({ consultationId: CONSULTATION, tenantId: TENANT });

    expect(snapshot.systemPrompt).toBe(LIVE_DOCUMENT_SYSTEM_PROMPT);
  });

  it.each([
    ['metaData is an array', { id: TEMPLATE, metaData: [] }],
    ['promptConfig is a string', { id: TEMPLATE, metaData: { promptConfig: 'not-an-object' } }],
    ['systemPrompt is a number', { id: TEMPLATE, metaData: { promptConfig: { systemPrompt: 42 } } }],
    ['systemPrompt is an empty string', { id: TEMPLATE, metaData: { promptConfig: { systemPrompt: '' } } }],
    ['systemPrompt is whitespace-only', { id: TEMPLATE, metaData: { promptConfig: { systemPrompt: '   ' } } }],
  ])('falls back to the code-default system prompt, without throwing, when %s', async (_label, template) => {
    promptTemplateRepository.findById.mockResolvedValue(template);

    await expect(service.resolveForSession({ consultationId: CONSULTATION, tenantId: TENANT })).resolves.toMatchObject({
      systemPrompt: LIVE_DOCUMENT_SYSTEM_PROMPT,
    });
  });

  it('falls back to the code-default system prompt when the template lookup throws (fail-open, never throws)', async () => {
    promptTemplateRepository.findById.mockRejectedValue(new Error('db down'));

    await expect(service.resolveForSession({ consultationId: CONSULTATION, tenantId: TENANT })).resolves.toMatchObject({
      systemPrompt: LIVE_DOCUMENT_SYSTEM_PROMPT,
    });
  });

  it('the crash-recovery rehydrate path also serves the custom system prompt', async () => {
    promptTemplateRepository.findById.mockResolvedValue({
      id: TEMPLATE,
      metaData: { promptConfig: { systemPrompt: 'Custom agent system prompt.' } },
    });
    promptVersionRepository.findByVersionNumber.mockResolvedValue({ content: 'pinned-content', versionNumber: 3 });

    const snapshot = await service.rehydrateFromLineage({
      tenantId: TENANT,
      lineage: {
        agentId: null,
        agentName: null,
        promptTemplateId: TEMPLATE,
        promptVersionNumber: 3,
        resolvedFrom: 'default',
        frozenAt: new Date().toISOString(),
      },
    });

    expect(snapshot?.systemPrompt).toBe('Custom agent system prompt.');
  });
});
