/**
 * Finalize lineage — the pinned agent still reaches the resolver.
 *
 * The live-snapshot prior draft is no longer an input (the note plan carries the note's own
 * draft instead), so the lineage-gated warm-start injection is gone. What survives is the
 * resolver pin: `pinnedAgentId` passes straight through, and its absence stays absent.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const mockPromptResolutionService = { resolve: vi.fn() };
const mockPromptTemplateRepository = { findById: vi.fn() };
const mockDnaWritingStyleRepository = { findById: vi.fn() };

const TENANT = 'tenant-lineage';
const PRIOR_DRAFT = 'Running SOAP note from the live session.';

function createTemplate() {
  return {
    id: 'template-warm',
    name: 'WarmStart',
    content: 'Summarize for {conversation_language}.',
    variables: { conversation_language: { type: 'string', required: true } },
    metaData: { promptConfig: { hyperparameters: {}, outputSchema: null } },
  };
}

async function buildService() {
  const { PromptAssemblyService } = await import('../prompt-assembly.service');
  const cls = { get: vi.fn((key: string) => (key === 'tenantId' ? TENANT : undefined)) };
  const service = new PromptAssemblyService(
    mockPromptResolutionService as never,
    mockPromptTemplateRepository as never,
    mockDnaWritingStyleRepository as never,
    cls as never,
  );
  return { service };
}

const assemble = (service: { assemble: (p: unknown) => Promise<{ userPrompt: string }> }, extra: Record<string, unknown>) =>
  service.assemble({
    promptType: 'new-patient',
    transcript: 'patient transcript',
    conversationLanguage: 'en',
    preSummaryText: PRIOR_DRAFT,
    tenantId: TENANT,
    ...extra,
  });

describe('PromptAssemblyService — finalize lineage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPromptResolutionService.resolve.mockResolvedValue({ promptId: 'template-warm', resolvedFrom: 'default' });
    mockPromptTemplateRepository.findById.mockResolvedValue(createTemplate());
    mockDnaWritingStyleRepository.findById.mockResolvedValue(null);
  });

  it('a pinned agent does not make the unnamed prior draft an input', async () => {
    const { service } = await buildService();
    const assembled = await assemble(service as never, { pinnedAgentId: 'agent-session' });
    expect(assembled.userPrompt).not.toContain(PRIOR_DRAFT);
  });

  it('passes pinnedAgentId through to the resolver', async () => {
    const { service } = await buildService();
    await assemble(service as never, { pinnedAgentId: 'agent-session', departmentId: 'dept-1' });

    expect(mockPromptResolutionService.resolve).toHaveBeenCalledWith(expect.objectContaining({ pinnedAgentId: 'agent-session' }));
  });

  it('REGRESSION LOCK — no pin ⇒ resolver sees pinnedAgentId undefined', async () => {
    const { service } = await buildService();
    await assemble(service as never, { departmentId: 'dept-1' });

    expect(mockPromptResolutionService.resolve).toHaveBeenCalledWith(expect.objectContaining({ pinnedAgentId: undefined }));
  });
});
