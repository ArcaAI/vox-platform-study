import { ForbiddenException } from '@nestjs/common';
import { OptimisticConcurrencyException } from '@arcaai/exceptions';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SYSTEM_TENANT_ID, SysEventType } from '@arcaai/domains';
import { GuardrailAvailabilityService } from '../guardrail-availability.service';
import { PLATFORM_DEFAULT_GUARDRAIL_POLICIES } from '../policy-catalogue';

const TENANT_A = 'aaaaaaaa-0000-0000-0000-000000000001';

function entity(tenantId: string, policies: Record<string, unknown>, version = 3) {
  const changes: Record<string, unknown> = {};
  return {
    id: `row-${tenantId}`,
    tenantId,
    policies,
    reason: null as string | null,
    version,
    updatedAt: new Date('2026-09-05T00:00:00Z'),
    updatedBy: null as string | null,
    get hasChanges() {
      return Object.keys(changes).length > 0;
    },
    get changes() {
      return changes;
    },
    setProperty(key: string, value: unknown) {
      changes[key] = value;
    },
  };
}

/** A hand-rolled double: the entity's setters must route through `setProperty`. */
function writable(base: ReturnType<typeof entity>) {
  return new Proxy(base as unknown as Record<string, unknown>, {
    set(target, key: string, value) {
      (target as { setProperty(k: string, v: unknown): void }).setProperty(key, value);
      target[key] = value;
      return true;
    },
  }) as unknown as ReturnType<typeof entity>;
}

describe('GuardrailAvailabilityService', () => {
  let repository: {
    findByTenantId: ReturnType<typeof vi.fn>;
    findAll: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    updateWithVersion: ReturnType<typeof vi.fn>;
  };
  let eventEmitter: { emit: ReturnType<typeof vi.fn> };
  let cls: { get: ReturnType<typeof vi.fn> };
  let service: GuardrailAvailabilityService;
  let roles: string[];

  beforeEach(() => {
    roles = ['SUPER_ADMIN'];
    repository = {
      findByTenantId: vi.fn().mockResolvedValue(null),
      findAll: vi.fn().mockResolvedValue([]),
      create: vi.fn().mockImplementation(async (e: unknown) => e),
      updateWithVersion: vi.fn().mockImplementation(async (_id: string, e: unknown) => e),
    };
    eventEmitter = { emit: vi.fn() };
    cls = {
      get: vi.fn((key: string) => {
        if (key === 'user') return { id: 'admin-1', tenantId: SYSTEM_TENANT_ID, roles };
        if (key === 'tenantId') return SYSTEM_TENANT_ID;
        return undefined;
      }),
    };
    service = new GuardrailAvailabilityService(repository as never, eventEmitter as never, cls as never);
  });

  // ── the privilege boundary ────────────────────────────────────────────────

  describe('SUPER_ADMIN-only (a 403 privilege boundary, not 404-over-403)', () => {
    beforeEach(() => {
      roles = ['TENANT_ADMIN'];
    });

    it('refuses a tenant admin reading its OWN tenant row', async () => {
      cls.get = vi.fn((key: string) => (key === 'user' ? { id: 'u', tenantId: TENANT_A, roles } : TENANT_A));
      await expect(service.getForTenant(TENANT_A)).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('refuses a tenant admin writing its OWN tenant row', async () => {
      cls.get = vi.fn((key: string) => (key === 'user' ? { id: 'u', tenantId: TENANT_A, roles } : TENANT_A));
      await expect(service.putForTenant(TENANT_A, { policies: {}, expectedVersion: 0 })).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('refuses a tenant admin listing', async () => {
      await expect(service.list()).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  // ── the cascade ───────────────────────────────────────────────────────────

  describe('resolution — absence widens to SYSTEM, presence does not', () => {
    it('a tenant with no row gets the SYSTEM set, attributed to SYSTEM', async () => {
      repository.findByTenantId.mockImplementation(async (tenantId: string) =>
        tenantId === SYSTEM_TENANT_ID ? entity(SYSTEM_TENANT_ID, { prompt_safety: { enabled: true } }) : null,
      );
      const response = await service.getForTenant(TENANT_A);
      expect(response.version).toBe(0);
      expect(response.policies).toEqual({});
      expect(response.effective).toEqual({ prompt_safety: { enabled: true } });
      expect(response.effectiveSourceTenantId).toBe(SYSTEM_TENANT_ID);
    });

    it('a tenant WITH a selection gets its own, attributed to itself', async () => {
      repository.findByTenantId.mockImplementation(async (tenantId: string) =>
        tenantId === SYSTEM_TENANT_ID
          ? entity(SYSTEM_TENANT_ID, PLATFORM_DEFAULT_GUARDRAIL_POLICIES as never)
          : entity(TENANT_A, { prompt_safety: { enabled: true } }),
      );
      const response = await service.getForTenant(TENANT_A);
      expect(response.effective).toEqual({ prompt_safety: { enabled: true } });
      expect(response.effectiveSourceTenantId).toBe(TENANT_A);
    });

    it('an EMPTY selection still resolves the SYSTEM set — there is no "off"', async () => {
      repository.findByTenantId.mockImplementation(async (tenantId: string) =>
        tenantId === SYSTEM_TENANT_ID ? entity(SYSTEM_TENANT_ID, PLATFORM_DEFAULT_GUARDRAIL_POLICIES as never) : entity(TENANT_A, {}),
      );
      const response = await service.getForTenant(TENANT_A);
      expect(response.effective).toEqual(PLATFORM_DEFAULT_GUARDRAIL_POLICIES);
      expect(response.effectiveSourceTenantId).toBe(SYSTEM_TENANT_ID);
    });
  });

  // ── the write lane ────────────────────────────────────────────────────────

  describe('write lane', () => {
    it('creates a row on `If-Match: "0"` and broadcasts ResourceCreated', async () => {
      repository.findByTenantId.mockResolvedValue(null);
      const response = await service.putForTenant(TENANT_A, { policies: { prompt_safety: { enabled: true } }, expectedVersion: 0 });
      expect(repository.create).toHaveBeenCalledOnce();
      expect(response.policies).toEqual({ prompt_safety: { enabled: true } });
      expect(eventEmitter.emit).toHaveBeenCalledWith(SysEventType.ResourceCreated, expect.anything());
    });

    it('refuses to create without `If-Match: "0"` (412 via OCC)', async () => {
      repository.findByTenantId.mockResolvedValue(null);
      await expect(service.putForTenant(TENANT_A, { policies: {}, expectedVersion: 7 })).rejects.toBeInstanceOf(OptimisticConcurrencyException);
    });

    it('CASes an existing row against its version', async () => {
      repository.findByTenantId.mockImplementation(async (t: string) => (t === TENANT_A ? writable(entity(TENANT_A, {}, 3)) : null));
      await expect(service.putForTenant(TENANT_A, { policies: { prompt_safety: { enabled: true } }, expectedVersion: 2 })).rejects.toBeInstanceOf(
        OptimisticConcurrencyException,
      );
    });

    it('REFUSES a loosening threshold with 403, naming the floor', async () => {
      repository.findByTenantId.mockImplementation(async (t: string) =>
        t === SYSTEM_TENANT_ID ? entity(SYSTEM_TENANT_ID, { pii_leak: { enabled: true, minScore: 0.5 } }) : null,
      );
      const attempt = service.putForTenant(TENANT_A, { policies: { pii_leak: { enabled: true, minScore: 0.9 } }, expectedVersion: 0 });
      await expect(attempt).rejects.toBeInstanceOf(ForbiddenException);
      await expect(attempt).rejects.toThrow(/may only be tightened/);
      expect(repository.create).not.toHaveBeenCalled();
    });

    it('ACCEPTS a tightening threshold', async () => {
      repository.findByTenantId.mockImplementation(async (t: string) =>
        t === SYSTEM_TENANT_ID ? entity(SYSTEM_TENANT_ID, { pii_leak: { enabled: true, minScore: 0.5 } }) : null,
      );
      await expect(service.putForTenant(TENANT_A, { policies: { pii_leak: { enabled: true, minScore: 0.1 } }, expectedVersion: 0 })).resolves.toMatchObject(
        { policies: { pii_leak: { enabled: true, minScore: 0.1 } } },
      );
    });

    it('rejects an unknown policy id (400) instead of dropping it', async () => {
      await expect(service.putForTenant(TENANT_A, { policies: { not_a_check: { enabled: true } }, expectedVersion: 0 })).rejects.toThrow(
        /Unknown guardrail policy/,
      );
    });

    it('does NOT floor-check the SYSTEM row against itself', async () => {
      repository.findByTenantId.mockImplementation(async (t: string) =>
        t === SYSTEM_TENANT_ID ? writable(entity(SYSTEM_TENANT_ID, { pii_leak: { enabled: true, minScore: 0.5 } }, 4)) : null,
      );
      await expect(
        service.putForTenant(SYSTEM_TENANT_ID, { policies: { pii_leak: { enabled: true, minScore: 0.9 } }, expectedVersion: 4 }),
      ).resolves.toMatchObject({ tenantId: SYSTEM_TENANT_ID });
    });
  });
});
