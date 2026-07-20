/**
 * PromptAssemblyService — effective `warmStartEnabled` precedence (TASK-533 D-23).
 *
 * `HarnessPolicy.warmStartEnabled` was fully WRITE-plumbed — DTO, response,
 * GLOBAL_ADMIN gate, admin-console knob, even parsed into the Python dataclass —
 * and then read by NOTHING. The real switch was the process-wide env var
 * `HARNESS_WARM_START_ENABLED`, cached at CONSTRUCTION, so a global admin toggling
 * the console knob changed nothing and could never vary per tenant.
 *
 * The contract this pins:
 *   1. the effective POLICY value wins over the env var, both directions
 *   2. a null policy value falls back to env — so an untouched deployment behaves
 *      byte-for-byte as it did before (program risk rule, README §7)
 *   3. resolution is PER-CALL: a policy change is picked up with no redeploy and
 *      no service reconstruction (the construction-time cache is gone)
 *   4. a policy-resolution failure degrades to env rather than throwing
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

async function buildService(opts: { env?: boolean; policy?: boolean | null; policyThrows?: boolean } = {}) {
  const { PromptAssemblyService } = await import('../prompt-assembly.service');
  const configService = {
    get: vi.fn((key: string) => (key === 'HARNESS_WARM_START_ENABLED' ? (opts.env ? 'true' : undefined) : undefined)),
  };
  const getEffectivePolicy = vi.fn(async () => {
    if (opts.policyThrows) throw new Error('policy backend unavailable');
    return { warmStartEnabled: opts.policy ?? null };
  });
  const harnessPolicyService = { getEffectivePolicy };
  const cls = { get: vi.fn((key: string) => (key === 'tenantId' ? TENANT : undefined)) };

  const service = new PromptAssemblyService(
    mockPromptResolutionService as never,
    mockPromptTemplateRepository as never,
    mockDnaWritingStyleRepository as never,
    configService as never,
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

describe('PromptAssemblyService — effective warmStartEnabled (TASK-533 D-23)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPromptResolutionService.resolve.mockResolvedValue({ promptId: 'template-warm', resolvedFrom: 'default' });
    mockPromptTemplateRepository.findById.mockResolvedValue(createTemplate());
    mockDnaWritingStyleRepository.findById.mockResolvedValue(null);
  });

  it('policy=false beats env=true → warm start OFF', async () => {
    const { service } = await buildService({ env: true, policy: false });
    expect(warmStarted(await assembleWithPriorDraft(service as never))).toBe(false);
  });

  it('policy=true beats env unset → warm start ON', async () => {
    const { service } = await buildService({ env: false, policy: true });
    expect(warmStarted(await assembleWithPriorDraft(service as never))).toBe(true);
  });

  it('policy=null falls back to env (untouched deployments behave exactly as before)', async () => {
    const envOn = await buildService({ env: true, policy: null });
    expect(warmStarted(await assembleWithPriorDraft(envOn.service as never))).toBe(true);

    const envOff = await buildService({ env: false, policy: null });
    expect(warmStarted(await assembleWithPriorDraft(envOff.service as never))).toBe(false);
  });

  it('resolves PER CALL — a policy flip takes effect with no reconstruction', async () => {
    const { service, getEffectivePolicy } = await buildService({ env: false, policy: false });

    expect(warmStarted(await assembleWithPriorDraft(service as never))).toBe(false);

    // Global admin flips the knob. Same service instance, no redeploy.
    getEffectivePolicy.mockResolvedValue({ warmStartEnabled: true } as never);

    expect(warmStarted(await assembleWithPriorDraft(service as never))).toBe(true);
    expect(getEffectivePolicy).toHaveBeenCalledTimes(2);
  });

  it('resolves the policy for the calling tenant', async () => {
    const { service, getEffectivePolicy } = await buildService({ env: false, policy: true });
    await assembleWithPriorDraft(service as never);
    expect(getEffectivePolicy).toHaveBeenCalledWith(TENANT);
  });

  it('degrades to env when the policy lookup fails (never blocks assembly)', async () => {
    const { service } = await buildService({ env: true, policyThrows: true });
    expect(warmStarted(await assembleWithPriorDraft(service as never))).toBe(true);
  });
});
