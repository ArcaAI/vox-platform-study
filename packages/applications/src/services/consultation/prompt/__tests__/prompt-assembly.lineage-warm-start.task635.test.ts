/**
 * Lineage-present warm start is UNCONDITIONAL.
 *
 * R-N2 ("the same specific agent reviews and finalizes") is the product
 * contract, not an opt-in optimization. Once a session has PROVABLY run the live
 * agent — the lineage block exists only because the live loop wrote it — the
 * prior draft is injected regardless of `HarnessPolicy.warmStartEnabled` / the
 * `HARNESS_WARM_START_ENABLED` env fallback.
 *
 * The flag is DEMOTED, not deleted: it still governs the LEGACY no-lineage path
 * (a case-notes PRE_SUMMARY, or a session recorded before C3 shipped), where
 * injection remains a genuine opt-in behaviour change.
 *
 * Gating table locked here:
 *
 *   | lineage | flag  | prior draft injected |
 *   |---------|-------|----------------------|
 *   | present | OFF   | YES  (R-N2)          |
 *   | present | ON    | YES                  |
 *   | absent  | OFF   | NO   (unchanged)     |
 *   | absent  | ON    | YES  (unchanged)     |
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const mockPromptResolutionService = { resolve: vi.fn() };
const mockPromptTemplateRepository = { findById: vi.fn() };
const mockDnaWritingStyleRepository = { findById: vi.fn() };

const TENANT = 'tenant-lineage';
const PRIOR_DRAFT = 'Running SOAP note from the live session.';

const LINEAGE = {
  agentId: 'agent-session',
  agentName: 'Surgery Default',
  promptTemplateId: 'tpl-live',
  promptVersionNumber: 3,
  resolvedFrom: 'agent' as const,
  frozenAt: '2026-08-08T00:00:00.000Z',
};

function createTemplate() {
  return {
    id: 'template-warm',
    name: 'WarmStart',
    content: 'Summarize for {conversation_language}.',
    variables: { conversation_language: { type: 'string', required: true } },
    metaData: { promptConfig: { hyperparameters: {}, outputSchema: null } },
  };
}

async function buildService(opts: { flag: boolean }) {
  const { PromptAssemblyService } = await import('../prompt-assembly.service');
  const configService = { get: vi.fn(() => undefined) };
  const getEffectivePolicy = vi.fn(async () => ({ warmStartEnabled: opts.flag }));
  const cls = { get: vi.fn((key: string) => (key === 'tenantId' ? TENANT : undefined)) };

  const service = new PromptAssemblyService(
    mockPromptResolutionService as never,
    mockPromptTemplateRepository as never,
    mockDnaWritingStyleRepository as never,
    configService as never,
    { getEffectivePolicy } as never,
    cls as never,
  );
  return { service, getEffectivePolicy };
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

const injected = (assembled: { userPrompt: string }) => assembled.userPrompt.includes(PRIOR_DRAFT);

describe('PromptAssemblyService — finalize lineage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPromptResolutionService.resolve.mockResolvedValue({ promptId: 'template-warm', resolvedFrom: 'default' });
    mockPromptTemplateRepository.findById.mockResolvedValue(createTemplate());
    mockDnaWritingStyleRepository.findById.mockResolvedValue(null);
  });

  it('lineage present + flag OFF ⇒ prior draft injected (R-N2)', async () => {
    const { service, getEffectivePolicy } = await buildService({ flag: false });
    expect(injected(await assemble(service as never, { preSummaryLineage: LINEAGE }))).toBe(true);
    // Short-circuited: lineage makes the governance read unnecessary.
    expect(getEffectivePolicy).not.toHaveBeenCalled();
  });

  it('lineage present + flag ON ⇒ prior draft injected', async () => {
    const { service } = await buildService({ flag: true });
    expect(injected(await assemble(service as never, { preSummaryLineage: LINEAGE }))).toBe(true);
  });

  it('LEGACY LOCK — lineage absent + flag OFF ⇒ NOT injected', async () => {
    const { service } = await buildService({ flag: false });
    expect(injected(await assemble(service as never, {}))).toBe(false);
  });

  it('LEGACY LOCK — lineage absent + flag ON ⇒ injected', async () => {
    const { service } = await buildService({ flag: true });
    expect(injected(await assemble(service as never, {}))).toBe(true);
  });

  it('passes pinnedAgentId through to the resolver', async () => {
    const { service } = await buildService({ flag: false });
    await assemble(service as never, { preSummaryLineage: LINEAGE, pinnedAgentId: LINEAGE.agentId, departmentId: 'dept-1' });

    expect(mockPromptResolutionService.resolve).toHaveBeenCalledWith(expect.objectContaining({ pinnedAgentId: 'agent-session' }));
  });

  it('REGRESSION LOCK — no lineage ⇒ resolver sees pinnedAgentId undefined', async () => {
    const { service } = await buildService({ flag: false });
    await assemble(service as never, { departmentId: 'dept-1' });

    expect(mockPromptResolutionService.resolve).toHaveBeenCalledWith(expect.objectContaining({ pinnedAgentId: undefined }));
  });
});
