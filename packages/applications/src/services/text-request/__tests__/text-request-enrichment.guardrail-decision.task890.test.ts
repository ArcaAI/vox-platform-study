// TASK-890 §3.14 (OD-R) — the WIRE half of the guardrail opt-out.
//
// `resolveGuardrailDecision` answers "does the platform's guardrail run for THIS call"
// (node > workflow > agent > on). `applyGuardrailDecision` is the ONE place that answer is
// written onto an outgoing TEXT body, so every producer states it the same way and none of them
// hand-rolls the key.
//
// Two properties, both load-bearing:
//
//   1. The decision is written EXPLICITLY in both directions. `enabled: true` is not the same
//      statement as an absent block: TEXT distinguishes "screened because a decision said so"
//      from "no opinion — the platform posture governs", and the ledger prices them apart.
//   2. It MERGES. `applyTenantGuardrailPolicy` writes `require_medical` / `include_reasoning`
//      into the same block; whichever runs second must not erase the other's fields, or a
//      caller's ordering silently changes what a clinical gate does.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClsService } from 'nestjs-cls';
import type { IActiveUserContext } from '../../../interfaces';
import type { EffectiveSettingsService } from '../../settings-registry/effective-settings.service';
import { TextRequestEnrichmentService } from '../text-request-enrichment.service';

const TENANT_A = 'tenant-aaa';

function settingsStub(rows: Record<string, { value: unknown; sourceScope: string }>) {
  return {
    resolveEffective: vi.fn(async (key: string) => ({
      key,
      tier: 'global-kv',
      value: rows[key]?.value ?? true,
      sourceScope: rows[key]?.sourceScope ?? 'code-default',
    })),
  } as unknown as EffectiveSettingsService;
}

function makeService(settings?: EffectiveSettingsService, tenantId: string | undefined = TENANT_A): TextRequestEnrichmentService {
  const cls = { get: vi.fn((k: string) => (k === 'tenantId' ? tenantId : undefined)) } as unknown as ClsService<IActiveUserContext>;
  return new TextRequestEnrichmentService(cls, undefined, settings);
}

describe('TextRequestEnrichmentService.applyGuardrailDecision', () => {
  beforeEach(() => vi.clearAllMocks());

  it('writes an opt-out onto the body', () => {
    const body = makeService().applyGuardrailDecision({ prompt: 'p' }, { enabled: false });
    expect(body).toMatchObject({ guardrail_policy: { enabled: false } });
  });

  it('writes an explicit `true` — "screened by decision" is not the same as "no opinion"', () => {
    const body = makeService().applyGuardrailDecision({ prompt: 'p' }, { enabled: true });
    expect((body as { guardrail_policy: { enabled: boolean } }).guardrail_policy.enabled).toBe(true);
  });

  it('PRESERVES the fields the tenant-policy push already wrote', () => {
    const body = makeService().applyGuardrailDecision({ guardrail_policy: { require_medical: false } }, { enabled: false });
    expect(body).toMatchObject({ guardrail_policy: { require_medical: false, enabled: false } });
  });

  it('is not erased by a tenant-policy push that runs afterwards', async () => {
    const service = makeService(settingsStub({ 'text.guardrailPolicy.requireMedical': { value: false, sourceScope: 'tenant' } }));
    const body = service.applyGuardrailDecision({}, { enabled: false });

    await service.applyTenantGuardrailPolicy(body);

    expect(body).toMatchObject({ guardrail_policy: { enabled: false, require_medical: false } });
  });

  it('never mistakes a non-object `guardrail_policy` for a block to merge into', () => {
    const body = makeService().applyGuardrailDecision({ guardrail_policy: 'nonsense' }, { enabled: false });
    expect(body).toMatchObject({ guardrail_policy: { enabled: false } });
  });
});

describe('TextRequestEnrichmentService.guardrailDisposition', () => {
  beforeEach(() => vi.clearAllMocks());

  const platform = (enabled: boolean) => settingsStub({ 'text.externalGuardrail.enabled': { value: enabled, sourceScope: 'system' } });

  it('reports `screened` when the platform gate is on and nobody opted out', async () => {
    await expect(makeService(platform(true)).guardrailDisposition({ enabled: true })).resolves.toBe('screened');
  });

  it('reports `opted_out` when the decision is off and the platform gate is on', async () => {
    await expect(makeService(platform(true)).guardrailDisposition({ enabled: false })).resolves.toBe('opted_out');
  });

  it('reports `platform_off` whatever the decision says — a platform-off gate makes every opt-out moot', async () => {
    await expect(makeService(platform(false)).guardrailDisposition({ enabled: false })).resolves.toBe('platform_off');
    await expect(makeService(platform(false)).guardrailDisposition({ enabled: true })).resolves.toBe('platform_off');
  });

  it('falls back to the DECISION, never to a fabricated `screened`, when the switch cannot be read', async () => {
    // An unwired resolver or a lookup fault must not claim a call was screened. Reporting the
    // decision is the honest half of the answer: it is what this gateway actually asked for.
    const faulty = {
      resolveEffective: vi.fn(async () => {
        throw new Error('kv down');
      }),
    } as unknown as EffectiveSettingsService;
    await expect(makeService(faulty).guardrailDisposition({ enabled: false })).resolves.toBe('opted_out');
    await expect(makeService(undefined).guardrailDisposition({ enabled: false })).resolves.toBe('opted_out');
  });
});
