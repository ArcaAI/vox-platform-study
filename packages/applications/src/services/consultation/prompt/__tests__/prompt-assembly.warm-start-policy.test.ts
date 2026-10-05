/**
 * PromptAssemblyService — warm start is no longer a prompt-assembly decision.
 *
 * `HarnessPolicy.warmStartEnabled` now governs the note plan (the composer withholds or carries the
 * previous AI draft). Assembly neither reads the policy nor appends an unnamed prior draft; a
 * governed body that names `pre_summary_text` still places it itself (prompt-assembly.service.test.ts).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const mockPromptResolutionService = { resolve: vi.fn() };
const mockPromptTemplateRepository = { findById: vi.fn() };
const mockDnaWritingStyleRepository = { findById: vi.fn() };

const TENANT = 'tenant-warm-start';
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

async function buildService(policy: boolean | null) {
  const { PromptAssemblyService } = await import('../prompt-assembly.service');
  const getEffectivePolicy = vi.fn(async () => ({ warmStartEnabled: policy }));
  const cls = { get: vi.fn((key: string) => (key === 'tenantId' ? TENANT : undefined)) };
  const service = new PromptAssemblyService(
    mockPromptResolutionService as never,
    mockPromptTemplateRepository as never,
    mockDnaWritingStyleRepository as never,
    { getEffectivePolicy } as never,
    cls as never,
  );
  return { service, getEffectivePolicy };
}

describe('PromptAssemblyService — warm start is not an assembly decision', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPromptResolutionService.resolve.mockResolvedValue({ promptId: 'template-warm', resolvedFrom: 'default' });
    mockPromptTemplateRepository.findById.mockResolvedValue(createTemplate());
    mockDnaWritingStyleRepository.findById.mockResolvedValue(null);
  });

  it.each([true, false, null])('policy=%s: an unnamed prior draft is never appended and the policy is never read', async (policy) => {
    const { service, getEffectivePolicy } = await buildService(policy);
    const assembled = await service.assemble({
      promptType: 'new-patient',
      transcript: 'patient transcript',
      conversationLanguage: 'en',
      preSummaryText: PRIOR_DRAFT,
      tenantId: TENANT,
    });
    expect(assembled.userPrompt).not.toContain(PRIOR_DRAFT);
    expect(assembled.systemPrompt).not.toContain('Do not regenerate from scratch');
    expect(getEffectivePolicy).not.toHaveBeenCalled();
  });
});
