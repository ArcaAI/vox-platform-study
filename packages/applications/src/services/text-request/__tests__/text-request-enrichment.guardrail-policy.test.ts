// TASK-799 A.2 — the PRODUCING half of the `guardrail_policy` push contract.
//
// `GenerateRequest.guardrail_policy` (`apps/text/src/text/models/requests.py`)
// and `core/guardrail_posture.resolve_posture` have existed and been tested for
// a while; nothing ever SENT the field, so every tenant silently ran the
// platform posture and the per-tenant half of D-1's split was unreachable.
//
// The property under test is narrow and easy to get wrong in exactly one way:
// ABSENCE MUST NOT BE FLATTENED INTO `false`. The receiving field is
// `bool | None` and its docstring says so outright — "`None` means NO OPINION
// … not the same as `False` and must never be flattened into it" — so pushing
// `descriptor.default` on every request would make the platform default
// unreachable for every tenant while looking, on the wire, exactly like a
// tenant that had chosen it.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClsService } from 'nestjs-cls';
import type { IActiveUserContext } from '../../../interfaces';
import type { EffectiveSettingsService } from '../../settings-registry/effective-settings.service';
import { TextRequestEnrichmentService } from '../text-request-enrichment.service';

const TENANT_A = 'tenant-aaa';

/**
 * `sourceScope` is the whole signal: only `'tenant'` means a row exists under
 * THIS tenant. `'system'` and `'code-default'` are the cascade falling through,
 * which is "no opinion".
 */
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
  return new TextRequestEnrichmentService(cls, undefined, undefined, settings);
}

describe('TextRequestEnrichmentService.applyTenantGuardrailPolicy', () => {
  beforeEach(() => vi.clearAllMocks());

  it('pushes the tenant’s own opinion onto the body', async () => {
    const service = makeService(
      settingsStub({
        'text.guardrailPolicy.requireMedical': { value: false, sourceScope: 'tenant' },
        'text.guardrailPolicy.includeReasoning': { value: true, sourceScope: 'tenant' },
      }),
    );

    const body = await service.applyTenantGuardrailPolicy({ provider: 'azure' });

    expect(body).toMatchObject({ guardrail_policy: { require_medical: false, include_reasoning: true } });
  });

  it('a tenant with NO opinion gets no field at all — the platform default stands', async () => {
    // Both keys resolve, but from the platform/code tiers. Pushing
    // `require_medical: true` here would be indistinguishable on the wire from
    // a tenant that chose it, and would pin the tenant to today's platform
    // value forever after.
    const service = makeService(
      settingsStub({
        'text.guardrailPolicy.requireMedical': { value: true, sourceScope: 'system' },
        'text.guardrailPolicy.includeReasoning': { value: false, sourceScope: 'code-default' },
      }),
    );

    const body = await service.applyTenantGuardrailPolicy({ provider: 'azure' });

    expect(body).not.toHaveProperty('guardrail_policy');
  });

  it('pushes ONLY the fields the tenant actually set', async () => {
    const service = makeService(
      settingsStub({
        'text.guardrailPolicy.requireMedical': { value: false, sourceScope: 'tenant' },
        'text.guardrailPolicy.includeReasoning': { value: false, sourceScope: 'system' },
      }),
    );

    const body = (await service.applyTenantGuardrailPolicy({})) as Record<string, unknown>;

    expect(body.guardrail_policy).toEqual({ require_medical: false });
  });

  it('refuses a row of the wrong type rather than coercing it', async () => {
    const service = makeService(settingsStub({ 'text.guardrailPolicy.requireMedical': { value: 'no', sourceScope: 'tenant' } }));

    const body = await service.applyTenantGuardrailPolicy({});

    expect(body).not.toHaveProperty('guardrail_policy');
  });

  it('fails OPEN on a resolver error — generation is never taken down by a config read', async () => {
    const settings = {
      resolveEffective: vi.fn(async () => {
        throw new Error('control plane unreachable');
      }),
    } as unknown as EffectiveSettingsService;

    const body = await makeService(settings).applyTenantGuardrailPolicy({ provider: 'azure' });

    expect(body).toEqual({ provider: 'azure' });
  });

  it('is inert without a tenant in context, and without a resolver wired', async () => {
    expect(await makeService(settingsStub({}), undefined).applyTenantGuardrailPolicy({ a: 1 })).toEqual({ a: 1 });
    expect(await makeService(undefined).applyTenantGuardrailPolicy({ a: 1 })).toEqual({ a: 1 });
  });
});
