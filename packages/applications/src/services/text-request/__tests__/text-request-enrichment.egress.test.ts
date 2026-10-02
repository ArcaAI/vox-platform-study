/**
 * The egress statements every `apps/text` `/generate` body carries, stamped by the ONE enrichment
 * every caller already runs (`applyTenantProviderOverrides` — the coverage gate in
 * `text-generate-caller-coverage.test.ts` proves every POST site calls it):
 *
 *   - `provider_locality`, from the resolved model row (or the engine-served rule), REPLACING
 *     anything a client sent;
 *   - `known_phi`, when the caller names the consultation the call is about;
 *   - never a guardrail opt-out (`guardrail_policy.enabled`), never `require_medical`, never
 *     `medical_exempt` — screening is not the caller's to switch off.
 */
import { describe, expect, it, vi } from 'vitest';
import type { ClsService } from 'nestjs-cls';
import type { IActiveUserContext } from '../../../interfaces';
import type { EffectiveSettingsService } from '../../settings-registry/effective-settings.service';
import type { KnownPhiService } from '../known-phi.service';
import { TextRequestEnrichmentService } from '../text-request-enrichment.service';

const cls = { get: vi.fn((k: string) => (k === 'tenantId' ? 'tenant-a' : undefined)) } as unknown as ClsService<IActiveUserContext>;

function service(options: { knownPhi?: Partial<KnownPhiService>; settings?: EffectiveSettingsService } = {}): TextRequestEnrichmentService {
  return new TextRequestEnrichmentService(cls, undefined, options.settings, options.knownPhi as KnownPhiService | undefined);
}

describe('provider_locality', () => {
  it('stamps an engine-served provider local with no row known', async () => {
    const body = await service().applyTenantProviderOverrides({ provider: 'lm-studio' });
    expect(body).toMatchObject({ provider_locality: { 'lm-studio': 'local' } });
  });

  it('stamps from the resolved row when the caller supplies its deploymentKind', async () => {
    const body = await service().applyTenantProviderOverrides({ provider: 'openai-compat' }, { deploymentKind: 'SELF_HOSTED' });
    expect(body).toMatchObject({ provider_locality: { 'openai-compat': 'local' } });
  });

  it('stamps even when the caller already resolved provider_overrides (the early-return path)', async () => {
    const body = await service().applyTenantProviderOverrides({ provider: 'azure-openai', provider_overrides: { 'azure-openai': { api_key: 'k' } } });
    expect(body).toMatchObject({ provider_locality: { 'azure-openai': 'cloud' } });
  });

  it('discards a client-supplied locality it cannot confirm', async () => {
    const body = await service().applyTenantProviderOverrides({ provider: 'mystery', provider_locality: { mystery: 'local' } } as { provider: string });
    expect(body).not.toHaveProperty('provider_locality');
  });
});

describe('no opt-out ever leaves the gateway', () => {
  it('strips guardrail_policy.enabled / require_medical and medical_exempt, keeping include_reasoning', async () => {
    const body = await service().applyTenantProviderOverrides({
      provider: 'lm-studio',
      guardrail_policy: { enabled: false, require_medical: false, include_reasoning: true },
      medical_exempt: 'internal',
    } as { provider: string });
    expect(body).toMatchObject({ guardrail_policy: { include_reasoning: true } });
    expect((body as Record<string, unknown>).guardrail_policy).not.toHaveProperty('enabled');
    expect((body as Record<string, unknown>).guardrail_policy).not.toHaveProperty('require_medical');
    expect(body).not.toHaveProperty('medical_exempt');
  });

  it('drops an emptied guardrail_policy block entirely', async () => {
    const body = await service().applyTenantProviderOverrides({ provider: 'lm-studio', guardrail_policy: { enabled: false } } as { provider: string });
    expect(body).not.toHaveProperty('guardrail_policy');
  });

  it('pushes only include_reasoning from the tenant policy, never require_medical', async () => {
    const settings = {
      resolveEffective: vi.fn(async (key: string) => ({ key, value: false, sourceScope: 'tenant' })),
    } as unknown as EffectiveSettingsService;
    const body = await service({ settings }).applyTenantGuardrailPolicy({ provider: 'lm-studio' });
    expect(body).toEqual({ provider: 'lm-studio', guardrail_policy: { include_reasoning: false } });
  });

  it('no longer offers a per-call guardrail decision or disposition', () => {
    const enrichment = service() as unknown as Record<string, unknown>;
    expect(enrichment.applyGuardrailDecision).toBeUndefined();
    expect(enrichment.guardrailDisposition).toBeUndefined();
  });
});

describe('known_phi', () => {
  it('attaches the consultation’s known PHI when the caller names the consultation', async () => {
    const forConsultation = vi.fn(async () => [{ label: 'patient id', value: 'P-1' }]);
    const body = await service({ knownPhi: { forConsultation } }).applyTenantProviderOverrides(
      { provider: 'azure-openai' },
      { consultationId: 'c-1', context: { patient: { name: 'Asha' } } },
    );
    expect(forConsultation).toHaveBeenCalledWith('c-1', { patient: { name: 'Asha' } });
    expect(body).toMatchObject({ known_phi: [{ label: 'patient id', value: 'P-1' }] });
  });

  it('sends nothing when there is no consultation, nothing known, or the resolver fails', async () => {
    const empty = await service({ knownPhi: { forConsultation: vi.fn(async () => []) } }).applyTenantProviderOverrides({ provider: 'x' }, { consultationId: 'c' });
    expect(empty).not.toHaveProperty('known_phi');
    const none = await service({ knownPhi: { forConsultation: vi.fn() } }).applyTenantProviderOverrides({ provider: 'x', known_phi: [{ label: 'a', value: 'bb' }] } as { provider: string });
    expect(none).not.toHaveProperty('known_phi');
    const failing = await service({ knownPhi: { forConsultation: vi.fn(async () => Promise.reject(new Error('db'))) } }).applyTenantProviderOverrides(
      { provider: 'x' },
      { consultationId: 'c' },
    );
    expect(failing).not.toHaveProperty('known_phi');
  });
});
