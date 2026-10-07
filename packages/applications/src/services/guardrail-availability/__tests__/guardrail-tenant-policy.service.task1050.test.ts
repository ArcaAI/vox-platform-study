/**
 * TASK-1050 W2b — `GET/PUT admin/guardrail/policy`: a tenant admin turns its OWN tenant's guardrail
 * checks and directions on/off, and nothing else (README §11.1, field-level split gate).
 *
 *  - 404 for a tenant admin aiming at another tenant (existence first), 403 for the SYSTEM tier;
 *  - only `enabled` (checks and directions); any other changed field is 403 GUARDRAIL_FIELD_PLATFORM_ONLY,
 *    a catalogue-locked or platform-locked check's `enabled` too;
 *  - at least one check per direction stays on (OD-8; a direction off is monitor only, so allowed);
 *  - If-Match: `"0"` creates, a stale version is 412;
 *  - every write publishes `guardrail:config:invalidate` and schedules the governed-prompt re-screen.
 */
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { OptimisticConcurrencyException } from '@arcaai/exceptions';
import { SYSTEM_TENANT_ID, SysEventType } from '@arcaai/domains';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GuardrailTenantPolicyService } from '../guardrail-tenant-policy.service';

const TENANT_A = 'aaaaaaaa-0000-0000-0000-000000000001';
const TENANT_B = 'bbbbbbbb-0000-0000-0000-000000000002';

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

describe('GuardrailTenantPolicyService', () => {
  let rows: Map<string, ReturnType<typeof entity>>;
  let repository: Record<string, ReturnType<typeof vi.fn>>;
  let eventEmitter: { emit: ReturnType<typeof vi.fn> };
  let publisher: { policyChanged: ReturnType<typeof vi.fn> };
  let user: { id: string; tenantId: string; roles: string[] };
  let workingTenant: string | undefined;
  let service: GuardrailTenantPolicyService;

  beforeEach(() => {
    rows = new Map();
    repository = {
      findByTenantId: vi.fn(async (tenantId: string) => rows.get(tenantId) ?? null),
      create: vi.fn(async (created: { tenantId: string }) => ({ ...created, id: 'new-row', version: 1 })),
      updateWithVersion: vi.fn(async (_id: string, updated: { version: number }) => ({ ...updated, version: updated.version + 1, policies: (updated as { policies: unknown }).policies })),
    };
    eventEmitter = { emit: vi.fn() };
    publisher = { policyChanged: vi.fn(async () => undefined) };
    user = { id: 'admin-a', tenantId: TENANT_A, roles: ['TENANT_ADMIN'] };
    workingTenant = TENANT_A;
    const cls = { get: vi.fn((key: string) => (key === 'user' ? user : key === 'tenantId' ? workingTenant : undefined)) };
    service = new GuardrailTenantPolicyService(repository as never, eventEmitter as never, cls as never, publisher as never);
  });

  // ── existence first, privilege second ───────────────────────────────────

  it('a tenant admin aiming at ANOTHER tenant is 404 — its row is not hidden behind a 403', async () => {
    workingTenant = TENANT_B;
    await expect(service.getOwn()).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.putOwn({ checks: {}, expectedVersion: 0 })).rejects.toBeInstanceOf(NotFoundException);
    expect(repository.findByTenantId).not.toHaveBeenCalled();
  });

  it('the SYSTEM tier is never written through this route (403, the platform route owns it)', async () => {
    user = { id: 'root', tenantId: SYSTEM_TENANT_ID, roles: ['SUPER_ADMIN'] };
    workingTenant = SYSTEM_TENANT_ID;
    await expect(service.putOwn({ checks: {}, expectedVersion: 0 })).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('a super admin may use the route for its WORKING tenant', async () => {
    user = { id: 'root', tenantId: SYSTEM_TENANT_ID, roles: ['SUPER_ADMIN'] };
    workingTenant = TENANT_B;
    const response = await service.getOwn();
    expect(response.tenantId).toBe(TENANT_B);
  });

  it('no working tenant is a 400, never a silent SYSTEM read', async () => {
    workingTenant = undefined;
    await expect(service.getOwn()).rejects.toBeInstanceOf(BadRequestException);
  });

  // ── the read ────────────────────────────────────────────────────────────

  it('GET returns the effective per-check view: enabled, read-only action, locks, setBy, directions', async () => {
    rows.set(SYSTEM_TENANT_ID, entity(SYSTEM_TENANT_ID, { checks: { unsafe_content_judge: { enabled: true, action: 'block' } } }));
    rows.set(TENANT_A, entity(TENANT_A, { directions: { outbound: { enabled: false } }, checks: { prompt_safety: { enabled: true, locked: true, setBy: 'platform_admin' } } }, 4));
    const response = await service.getOwn();
    expect(response.version).toBe(4);
    expect(response.directions).toEqual({ inbound: { enabled: true }, outbound: { enabled: false } });
    expect(response.checks.find((c) => c.checkId === 'unsafe_content_judge')).toMatchObject({ enabled: true, action: 'block', inherited: true, editable: true });
    expect(response.checks.find((c) => c.checkId === 'prompt_safety')).toMatchObject({ locked: true, lockReason: 'platform', editable: false, setBy: 'platform_admin' });
    expect(response.checks.find((c) => c.checkId === 'medical_validation')).toMatchObject({ locked: true, lockReason: 'catalogue', editable: false });
  });

  it('a tenant with no row reads version 0 (If-Match "0" creates it)', async () => {
    expect((await service.getOwn()).version).toBe(0);
  });

  // ── the field-level gate ────────────────────────────────────────────────

  it('a tenant admin may switch a check and a direction; only those fields are stored, stamped tenant_admin', async () => {
    rows.set(SYSTEM_TENANT_ID, entity(SYSTEM_TENANT_ID, { checks: { unsafe_content_judge: { action: 'block' } } }));
    await service.putOwn({ directions: { outbound: { enabled: false } }, checks: { unsafe_content_judge: { enabled: true } }, expectedVersion: 0 });
    const stored = repository.create.mock.calls[0]![0] as { policies: unknown };
    expect(stored.policies).toEqual({ directions: { outbound: { enabled: false } }, checks: { unsafe_content_judge: { enabled: true, setBy: 'tenant_admin' } } });
    expect(eventEmitter.emit).toHaveBeenCalledWith(SysEventType.ResourceCreated, expect.anything());
  });

  it.each([
    [{ unsafe_content_judge: { action: 'block' } }, 'checks.unsafe_content_judge.action'],
    [{ prompt_safety: { locked: true } }, 'checks.prompt_safety.locked'],
    [{ pii_leak: { minScore: 0.1 } }, 'checks.pii_leak.minScore'],
    [{ jailbreak_detection: { dataRegionAction: 'block' } }, 'checks.jailbreak_detection.dataRegionAction'],
  ])('a tenant admin changing %j is 403 GUARDRAIL_FIELD_PLATFORM_ONLY naming the field', async (checks, field) => {
    const error = await service.putOwn({ checks, expectedVersion: 0 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ForbiddenException);
    expect((error as ForbiddenException).getResponse()).toMatchObject({ code: 'GUARDRAIL_FIELD_PLATFORM_ONLY', fields: [field] });
    expect(repository.create).not.toHaveBeenCalled();
    expect(publisher.policyChanged).not.toHaveBeenCalled();
  });

  it('echoing the platform action back is not a change, so it is allowed', async () => {
    await service.putOwn({ checks: { unsafe_content_judge: { enabled: true, action: 'warn' } }, expectedVersion: 0 });
    expect(repository.create).toHaveBeenCalled();
  });

  it('the catalogue-locked medical check is read-only for a tenant admin (403 GUARDRAIL_CHECK_LOCKED)', async () => {
    const error = await service.putOwn({ checks: { medical_validation: { enabled: false } }, expectedVersion: 0 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ForbiddenException);
    expect((error as ForbiddenException).getResponse()).toMatchObject({ code: 'GUARDRAIL_CHECK_LOCKED', fields: ['checks.medical_validation.enabled'] });
  });

  it('a check the platform LOCKED for this tenant — on its row or on SYSTEM — cannot be switched by it', async () => {
    rows.set(TENANT_A, entity(TENANT_A, { checks: { prompt_safety: { enabled: true, locked: true } } }));
    await expect(service.putOwn({ checks: { prompt_safety: { enabled: false } }, expectedVersion: 3 })).rejects.toBeInstanceOf(ForbiddenException);
    rows.clear();
    rows.set(SYSTEM_TENANT_ID, entity(SYSTEM_TENANT_ID, { checks: { prompt_toxicity: { locked: true } } }));
    await expect(service.putOwn({ checks: { prompt_toxicity: { enabled: false } }, expectedVersion: 0 })).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('a super admin on the tenant route is a platform admin: it may change the action too', async () => {
    user = { id: 'root', tenantId: SYSTEM_TENANT_ID, roles: ['SUPER_ADMIN'] };
    await service.putOwn({ checks: { unsafe_content_judge: { action: 'block' } }, expectedVersion: 0 });
    const stored = repository.create.mock.calls[0]![0] as { policies: { checks: Record<string, unknown> } };
    expect(stored.policies.checks.unsafe_content_judge).toEqual({ action: 'block', setBy: 'platform_admin' });
  });

  // ── OD-8 ─────────────────────────────────────────────────────────────────

  it('switching off the last inbound check is 400 (OD-8: at least one check per direction stays on)', async () => {
    const inbound = { jailbreak_detection: { enabled: false }, prompt_safety: { enabled: false }, prompt_toxicity: { enabled: false } };
    await expect(service.putOwn({ checks: inbound, expectedVersion: 0 })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('a direction OFF is monitor only, not ungated — allowed', async () => {
    await service.putOwn({ directions: { inbound: { enabled: false }, outbound: { enabled: false } }, expectedVersion: 0 });
    expect(repository.create).toHaveBeenCalled();
  });

  // ── If-Match ──────────────────────────────────────────────────────────────

  it('a create needs If-Match "0"; any other version is 412', async () => {
    await expect(service.putOwn({ checks: { prompt_safety: { enabled: false } }, expectedVersion: 5 })).rejects.toBeInstanceOf(OptimisticConcurrencyException);
  });

  it('an update with a stale version is 412 even when the payload is legal', async () => {
    rows.set(TENANT_A, entity(TENANT_A, { checks: {} }, 7));
    await expect(service.putOwn({ checks: { prompt_safety: { enabled: false } }, expectedVersion: 6 })).rejects.toBeInstanceOf(OptimisticConcurrencyException);
  });

  it('an update CASes on the version, rewrites a legacy row as v2, and broadcasts the version pair', async () => {
    rows.set(TENANT_A, entity(TENANT_A, { prompt_safety: { enabled: true }, pii_leak: { enabled: true, minScore: 0.4 } }, 7));
    await service.putOwn({ checks: { prompt_safety: { enabled: false } }, expectedVersion: 7 });
    expect(repository.updateWithVersion).toHaveBeenCalledWith(`row-${TENANT_A}`, expect.anything(), 7);
    const saved = repository.updateWithVersion.mock.calls[0]![1] as { policies: unknown };
    expect(saved.policies).toEqual({ directions: {}, checks: { prompt_safety: { enabled: false, setBy: 'tenant_admin' }, pii_leak: { enabled: true, minScore: 0.4 } } });
    expect(eventEmitter.emit).toHaveBeenCalledWith(SysEventType.ResourceUpdated, expect.objectContaining({ data: expect.objectContaining({ previousVersion: 7, newVersion: 8 }) }));
  });

  it('an idempotent re-send changes nothing: no version bump, no event, no invalidation', async () => {
    rows.set(TENANT_A, entity(TENANT_A, { directions: {}, checks: { prompt_safety: { enabled: false, setBy: 'tenant_admin' } } }, 7));
    const response = await service.putOwn({ checks: { prompt_safety: { enabled: false } }, expectedVersion: 7 });
    expect(response.version).toBe(7);
    expect(repository.updateWithVersion).not.toHaveBeenCalled();
    expect(publisher.policyChanged).not.toHaveBeenCalled();
  });

  // ── propagation ───────────────────────────────────────────────────────────

  it('every committed write tells the publisher (Redis invalidation + governed re-screen) for THIS tenant', async () => {
    await service.putOwn({ checks: { prompt_safety: { enabled: false } }, expectedVersion: 0 });
    expect(publisher.policyChanged).toHaveBeenCalledWith(TENANT_A);
  });

  it('a malformed body is 400 before any privilege decision', async () => {
    await expect(service.putOwn({ checks: { nope: { enabled: true } }, expectedVersion: 0 })).rejects.toBeInstanceOf(BadRequestException);
  });
});
