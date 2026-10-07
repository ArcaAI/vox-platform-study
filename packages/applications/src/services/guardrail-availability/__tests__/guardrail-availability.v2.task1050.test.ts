/**
 * TASK-1050 W2b — the PLATFORM per-tenant control, `admin/guardrail/availability/:tenantId`, in the v2
 * shape (README §11.1): a super admin sets action, lock, data-region action and thresholds per tenant
 * (and on the SYSTEM row); a lock it sets stops the tenant changing that check; legacy rows normalise on
 * read and are rewritten as v2 on the first write; the catalogue-locked medical check is editable by
 * nobody; every write publishes the invalidation.
 */
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { SYSTEM_TENANT_ID } from '@arcaai/domains';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GuardrailAvailabilityService } from '../guardrail-availability.service';
import { GuardrailTenantPolicyService } from '../guardrail-tenant-policy.service';

const TENANT_A = 'aaaaaaaa-0000-0000-0000-000000000001';

function entity(tenantId: string, policies: Record<string, unknown>, version = 3) {
  const changes: Record<string, unknown> = {};
  const base = {
    id: `row-${tenantId}`,
    tenantId,
    policies,
    reason: null as string | null,
    version,
    updatedAt: new Date('2026-10-07T00:00:00Z'),
    updatedBy: null as string | null,
    get hasChanges() {
      return Object.keys(changes).length > 0;
    },
    setProperty(key: string, value: unknown) {
      changes[key] = value;
    },
  };
  return new Proxy(base as unknown as Record<string, unknown>, {
    set(target, key: string, value) {
      if (key !== 'updatedBy') (target as { setProperty(k: string, v: unknown): void }).setProperty(key, value);
      target[key] = value;
      return true;
    },
  }) as unknown as typeof base;
}

describe('GuardrailAvailabilityService — v2 platform control', () => {
  let rows: Map<string, ReturnType<typeof entity>>;
  let repository: Record<string, ReturnType<typeof vi.fn>>;
  let publisher: { policyChanged: ReturnType<typeof vi.fn> };
  let user: { id: string; tenantId: string; roles: string[] };
  let workingTenant: string;
  let cls: { get: ReturnType<typeof vi.fn> };
  let service: GuardrailAvailabilityService;

  beforeEach(() => {
    rows = new Map();
    repository = {
      findByTenantId: vi.fn(async (tenantId: string) => rows.get(tenantId) ?? null),
      findAll: vi.fn(async () => [...rows.values()]),
      create: vi.fn(async (created: { tenantId: string; policies: Record<string, unknown> }) => {
        const row = entity(created.tenantId, created.policies, 1);
        rows.set(created.tenantId, row);
        return row;
      }),
      updateWithVersion: vi.fn(async (_id: string, updated: ReturnType<typeof entity>) => {
        const row = entity(updated.tenantId, updated.policies, updated.version + 1);
        rows.set(updated.tenantId, row);
        return row;
      }),
    };
    publisher = { policyChanged: vi.fn(async () => undefined) };
    user = { id: 'root', tenantId: SYSTEM_TENANT_ID, roles: ['SUPER_ADMIN'] };
    workingTenant = SYSTEM_TENANT_ID;
    cls = { get: vi.fn((key: string) => (key === 'user' ? user : key === 'tenantId' ? workingTenant : undefined)) };
    service = new GuardrailAvailabilityService(repository as never, { emit: vi.fn() } as never, cls as never, publisher as never);
  });

  it('stores a v2 per-tenant row: action, lock and data-region action, every entry stamped platform_admin', async () => {
    await service.putForTenant(TENANT_A, {
      policies: {
        directions: { inbound: { enabled: true } },
        checks: { prompt_safety: { enabled: true, action: 'warn', locked: true }, jailbreak_detection: { dataRegionAction: 'warn' } },
      },
      expectedVersion: 0,
    });
    expect(rows.get(TENANT_A)!.policies).toEqual({
      directions: { inbound: { enabled: true } },
      checks: {
        prompt_safety: { enabled: true, action: 'warn', locked: true, setBy: 'platform_admin' },
        jailbreak_detection: { dataRegionAction: 'warn', setBy: 'platform_admin' },
      },
    });
  });

  it('answers the v2 effective view beside the legacy fields', async () => {
    rows.set(SYSTEM_TENANT_ID, entity(SYSTEM_TENANT_ID, { checks: { leakage_judge: { enabled: true } } }));
    rows.set(TENANT_A, entity(TENANT_A, { prompt_safety: { enabled: true } }, 2));
    const response = await service.getForTenant(TENANT_A);
    expect(response.policies).toEqual({ prompt_safety: { enabled: true } });
    expect(response.effectivePolicy?.checks.find((c) => c.checkId === 'leakage_judge')).toMatchObject({ enabled: true, action: 'block', inherited: true });
    expect(response.effectivePolicy?.checks.find((c) => c.checkId === 'prompt_safety')).toMatchObject({ enabled: true, action: 'block', inherited: false, editable: true });
    expect(response.effective).toMatchObject({ prompt_safety: { enabled: true }, leakage_judge: { enabled: true } });
  });

  it('a legacy row is rewritten as v2 on its first write', async () => {
    rows.set(TENANT_A, entity(TENANT_A, { prompt_safety: { enabled: true }, pii_leak: { enabled: true, minScore: 0.5 } }, 2));
    await service.putForTenant(TENANT_A, { policies: { prompt_safety: { enabled: true }, pii_leak: { enabled: true, minScore: 0.5 } }, expectedVersion: 2 });
    expect(rows.get(TENANT_A)!.policies).toEqual({
      directions: {},
      checks: { prompt_safety: { enabled: true, setBy: 'platform_admin' }, pii_leak: { enabled: true, minScore: 0.5, setBy: 'platform_admin' } },
    });
  });

  it('the catalogue-locked medical check is editable by NOBODY, a super admin included (403 GUARDRAIL_CHECK_LOCKED)', async () => {
    const error = await service
      .putForTenant(TENANT_A, { policies: { checks: { medical_validation: { enabled: true, action: 'warn' } } }, expectedVersion: 0 })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ForbiddenException);
    expect((error as ForbiddenException).getResponse()).toMatchObject({ code: 'GUARDRAIL_CHECK_LOCKED', fields: ['checks.medical_validation.action'] });
  });

  it('echoing the locked medical values is allowed, and the entry is never stored', async () => {
    await service.putForTenant(TENANT_A, {
      policies: { checks: { medical_validation: { enabled: true, action: 'block' }, prompt_safety: { enabled: true } } },
      expectedVersion: 0,
    });
    expect((rows.get(TENANT_A)!.policies as { checks: Record<string, unknown> }).checks.medical_validation).toBeUndefined();
  });

  it('an action outside the check`s allowed set is 400', async () => {
    await expect(
      service.putForTenant(TENANT_A, { policies: { checks: { prompt_safety: { action: 'loud' } } }, expectedVersion: 0 }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('OD-8 holds on the platform plane too: no direction may be left with no check', async () => {
    const outbound = ['response_safety', 'response_toxicity', 'response_refusal', 'pii_leak', 'containment_echo', 'jailbreak_detection'];
    const checks = Object.fromEntries(outbound.map((id) => [id, { enabled: false }]));
    await expect(service.putForTenant(TENANT_A, { policies: { checks }, expectedVersion: 0 })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('thresholds stay tighten-only against the SYSTEM row', async () => {
    rows.set(SYSTEM_TENANT_ID, entity(SYSTEM_TENANT_ID, { checks: { pii_leak: { enabled: true, minScore: 0.5 } } }));
    await expect(
      service.putForTenant(TENANT_A, { policies: { checks: { pii_leak: { enabled: true, minScore: 0.9 } } }, expectedVersion: 0 }),
    ).rejects.toThrow(/0\.9/);
  });

  it('a platform LOCK prevents the tenant changing that check on the tenant route', async () => {
    await service.putForTenant(TENANT_A, { policies: { checks: { prompt_toxicity: { enabled: true, locked: true } } }, expectedVersion: 0 });
    user = { id: 'admin-a', tenantId: TENANT_A, roles: ['TENANT_ADMIN'] };
    workingTenant = TENANT_A;
    const tenantPlane = new GuardrailTenantPolicyService(repository as never, { emit: vi.fn() } as never, cls as never, publisher as never);
    const error = await tenantPlane.putOwn({ checks: { prompt_toxicity: { enabled: false } }, expectedVersion: 1 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ForbiddenException);
    expect((error as ForbiddenException).getResponse()).toMatchObject({ code: 'GUARDRAIL_FIELD_PLATFORM_ONLY', fields: ['checks.prompt_toxicity.enabled'] });
  });

  it('every committed write publishes the invalidation for the written tenant — SYSTEM included', async () => {
    await service.putForTenant(TENANT_A, { policies: { checks: { prompt_safety: { action: 'warn' } } }, expectedVersion: 0 });
    await service.putForTenant(SYSTEM_TENANT_ID, { policies: { checks: { leakage_judge: { enabled: true } } }, expectedVersion: 0 });
    expect(publisher.policyChanged.mock.calls).toEqual([[TENANT_A], [SYSTEM_TENANT_ID]]);
  });

  it('a no-op re-send publishes nothing', async () => {
    rows.set(TENANT_A, entity(TENANT_A, { directions: {}, checks: { prompt_safety: { action: 'warn', setBy: 'platform_admin' } } }, 4));
    await service.putForTenant(TENANT_A, { policies: { checks: { prompt_safety: { action: 'warn' } } }, expectedVersion: 4 });
    expect(repository.updateWithVersion).not.toHaveBeenCalled();
    expect(publisher.policyChanged).not.toHaveBeenCalled();
  });

  it('the catalogue lists the v2 fields a console needs', () => {
    const medical = service.catalogue().find((entry) => entry.id === 'medical_validation');
    expect(medical).toMatchObject({ locked: true, allowedActions: ['block'], platformDefaultAction: 'block', defaultEnabled: true });
  });
});
