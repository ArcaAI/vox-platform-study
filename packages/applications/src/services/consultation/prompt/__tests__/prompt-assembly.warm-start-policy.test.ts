/**
 * PromptAssemblyService — effective `warmStartEnabled` is the `HarnessPolicy` column, alone.
 *
 * TASK-882: `harness.warmStartEnabled` (`HARNESS_WARM_START_ENABLED`) was an env DUPLICATE of the
 * SUPER_ADMIN_ONLY `HarnessPolicy.warmStartEnabled` column — the env var survived only as the
 * fallback for a null policy value. It is gone: the column is the one source, a null column is
 * the code default (OFF), and there is no env branch to fall back to.
 *
 * The contract this pins:
 *   1. the effective POLICY value decides, both directions
 *   2. a null policy value is the code default — OFF — never an env read
 *   3. resolution is PER-CALL: a policy change is picked up with no redeploy
 *   4. a policy-resolution failure degrades to OFF rather than throwing
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const mockPromptResolutionService = { resolve: vi.fn() };
const mockPromptTemplateRepository = { findById: vi.fn() };
const mockDnaWritingStyleRepository = { findById: vi.fn() };

const TENANT = 'tenant-warm-start';
const PRIOR_DRAFT = 'Running SOAP note from the live session.';

/** The template echoes the prompt body; warm start appends the PRIOR DRAFT block. */
function createTemplate() {
  return {
    id: 'template-warm',
    name: 'WarmStart',
    content: 'Summarize for {conversation_language}.',
    variables: { conversation_language: { type: 'string', required: true } },
    metaData: { promptConfig: { hyperparameters: {}, outputSchema: null } },
  };
}

async function buildService(opts: { policy?: boolean | null; policyThrows?: boolean; unwired?: boolean } = {}) {
  const { PromptAssemblyService } = await import('../prompt-assembly.service');
  const getEffectivePolicy = vi.fn(async () => {
    if (opts.policyThrows) throw new Error('policy backend unavailable');
    return { warmStartEnabled: opts.policy ?? null };
  });
  const harnessPolicyService = opts.unwired ? undefined : { getEffectivePolicy };
  const cls = { get: vi.fn((key: string) => (key === 'tenantId' ? TENANT : undefined)) };

  const service = new PromptAssemblyService(
    mockPromptResolutionService as never,
    mockPromptTemplateRepository as never,
    mockDnaWritingStyleRepository as never,
    harnessPolicyService as never,
    cls as never,
  );
  return { service, getEffectivePolicy };
}

const assembleWithPriorDraft = (service: { assemble: (p: unknown) => Promise<{ userPrompt: string }> }) =>
  service.assemble({
    promptType: 'new-patient',
    transcript: 'patient transcript',
    conversationLanguage: 'en',
    preSummaryText: PRIOR_DRAFT,
    tenantId: TENANT,
  });

/** Warm start is ON iff the prior-draft block reached the user prompt. */
const warmStarted = (assembled: { userPrompt: string }) => assembled.userPrompt.includes(PRIOR_DRAFT);

describe('PromptAssemblyService — effective warmStartEnabled (HarnessPolicy column only)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPromptResolutionService.resolve.mockResolvedValue({ promptId: 'template-warm', resolvedFrom: 'default' });
    mockPromptTemplateRepository.findById.mockResolvedValue(createTemplate());
    mockDnaWritingStyleRepository.findById.mockResolvedValue(null);
  });

  it('policy=false → warm start OFF', async () => {
    const { service } = await buildService({ policy: false });
    expect(warmStarted(await assembleWithPriorDraft(service as never))).toBe(false);
  });

  it('policy=true → warm start ON', async () => {
    const { service } = await buildService({ policy: true });
    expect(warmStarted(await assembleWithPriorDraft(service as never))).toBe(true);
  });

  it('policy=null is the code default (OFF) — there is no env fallback any more', async () => {
    const { service } = await buildService({ policy: null });
    expect(warmStarted(await assembleWithPriorDraft(service as never))).toBe(false);
  });

  it('an unwired policy service is the code default (OFF)', async () => {
    const { service } = await buildService({ unwired: true });
    expect(warmStarted(await assembleWithPriorDraft(service as never))).toBe(false);
  });

  it('resolves PER CALL — a policy flip takes effect with no reconstruction', async () => {
    const { service, getEffectivePolicy } = await buildService({ policy: false });

    expect(warmStarted(await assembleWithPriorDraft(service as never))).toBe(false);

    // Super admin flips the knob. Same service instance, no redeploy.
    getEffectivePolicy.mockResolvedValue({ warmStartEnabled: true } as never);

    expect(warmStarted(await assembleWithPriorDraft(service as never))).toBe(true);
    expect(getEffectivePolicy).toHaveBeenCalledTimes(2);
  });

  it('resolves the policy for the calling tenant', async () => {
    const { service, getEffectivePolicy } = await buildService({ policy: true });
    await assembleWithPriorDraft(service as never);
    expect(getEffectivePolicy).toHaveBeenCalledWith(TENANT);
  });

  it('degrades to OFF when the policy lookup fails (never blocks assembly, never reads env)', async () => {
    const { service } = await buildService({ policyThrows: true });
    expect(warmStarted(await assembleWithPriorDraft(service as never))).toBe(false);
  });
});
