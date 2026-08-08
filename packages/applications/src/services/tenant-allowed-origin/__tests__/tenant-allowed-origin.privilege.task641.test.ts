/**
 * TASK-641 lane E — privilege boundaries inside `TenantAllowedOriginService`.
 *
 * TASK-610 governed this resource entirely at the controller
 * (`assertGlobalAdmin()` on every handler). TASK-641 relaxes that so a
 * `TENANT_ADMIN` can self-serve their own origins (FR-1), which moves two
 * boundaries INTO the service, where the shape of the value is actually
 * visible:
 *
 *  - **FR-2** — a wildcard (anything containing `*`, including the bare
 *    allow-all token) stays GLOBAL_ADMIN-only, on create **and** on update.
 *    `update` is the escalation path: a tenant admin holding an exact row
 *    could otherwise PATCH its `origin` into `https://*.evil.com:*`.
 *  - **FR-3** — a write whose resolved tenant is SYSTEM stays
 *    GLOBAL_ADMIN-only regardless of role, because a SYSTEM row is valid for
 *    EVERY tenant (`OriginRegistry.allows()` treats SYSTEM as universal).
 *
 * Both are **403s (privilege)**, never the 404-over-403 cross-tenant posture —
 * a cross-tenant id must still 404, and that is asserted here too.
 *
 * ── Why a REAL `ClsService` ──────────────────────────────────────────────
 * TASK-610 §5.2 lesson 1: *"a mocked dependency cannot observe an
 * ambient-context defect"*. Both boundaries under test are decided from
 * AMBIENT request state (`this.requestUser.roles`, `this.tenantId`), so a
 * `{ get: vi.fn() }` stub would let the suite pass by construction — it would
 * answer the same values whether or not the service actually read them from
 * the request store, and it cannot distinguish "read from CLS" from "read
 * from a field the test happened to set". This suite therefore wires a REAL
 * `ClsModule` and performs every call inside a real `cls.run()` store, so the
 * role and tenant reach the service by exactly the path production uses. The
 * repository stays a stub — it is the SINK being protected, and asserting it
 * was never called is the point.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Test } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ClsModule, ClsService } from 'nestjs-cls';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { ArgumentInvalidException } from '@arcaai/exceptions';
import { TenantAllowedOriginEntity } from '@arcaai/domains';
import { TenantAllowedOriginService } from '../tenant-allowed-origin.service';

const SYSTEM_TENANT_ID = '00000000-0000-0000-0000-000000000000';
const TENANT_A = '50000000-0000-0000-0000-000000000000';
const TENANT_B = '50000000-0000-0000-0000-0000000000bb';

const ORIGIN_REGISTRY_INVALIDATE_EVENT = 'origin-registry.invalidate';

const tenantAdmin = { id: 'user-tenant-admin', email: 'ta@example.org', roles: ['TENANT_ADMIN'] };
const globalAdmin = { id: 'user-global-admin', email: 'ga@example.org', roles: ['GLOBAL_ADMIN'] };

function makeEntity(overrides: Partial<{ id: string; tenantId: string; origin: string; label: string; version: number }> = {}): TenantAllowedOriginEntity {
  return new TenantAllowedOriginEntity({
    id: overrides.id ?? 'origin-row-1',
    tenantId: overrides.tenantId ?? TENANT_A,
    origin: overrides.origin ?? 'https://app.tenant-a.example',
    label: overrides.label ?? 'Tenant A app',
    description: null,
    version: overrides.version ?? 1,
    createdBy: null,
    updatedBy: null,
    createdAt: new Date('2026-08-08T00:00:00Z'),
    updatedAt: new Date('2026-08-08T00:00:00Z'),
  });
}

describe('TenantAllowedOriginService — privilege boundaries (TASK-641 FR-2/FR-3)', () => {
  let service: TenantAllowedOriginService;
  let cls: ClsService;
  let emitter: EventEmitter2;
  let emitSpy: ReturnType<typeof vi.spyOn>;
  let repository: {
    findAll: ReturnType<typeof vi.fn>;
    findById: ReturnType<typeof vi.fn>;
    findByOriginAndTenant: ReturnType<typeof vi.fn>;
    findFirst: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    updateWithVersion: ReturnType<typeof vi.fn>;
    restore: ReturnType<typeof vi.fn>;
    softDelete: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [ClsModule.forRoot()] }).compile();
    cls = moduleRef.get(ClsService);

    emitter = new EventEmitter2();
    emitSpy = vi.spyOn(emitter, 'emit');

    repository = {
      findAll: vi.fn().mockResolvedValue([]),
      findById: vi.fn().mockResolvedValue(null),
      findByOriginAndTenant: vi.fn().mockResolvedValue(null),
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockImplementation(async (entity: TenantAllowedOriginEntity) => entity),
      update: vi.fn().mockImplementation(async (_id: string, entity: TenantAllowedOriginEntity) => entity),
      updateWithVersion: vi.fn().mockImplementation(async (_id: string, entity: TenantAllowedOriginEntity) => entity),
      restore: vi.fn(),
      softDelete: vi.fn().mockImplementation(async () => makeEntity()),
    };

    service = new TenantAllowedOriginService(repository as never, emitter, cls as never);
  });

  /** Run `fn` inside a REAL CLS store carrying the given actor + working tenant. */
  function actingAs<T>(user: { id: string; roles: string[] }, tenantId: string, fn: () => Promise<T>): Promise<T> {
    return cls.run(() => {
      cls.set('user' as never, user as never);
      cls.set('tenantId' as never, tenantId as never);
      return fn();
    });
  }

  const invalidateEmitted = () => emitSpy.mock.calls.some(([event]) => event === ORIGIN_REGISTRY_INVALIDATE_EVENT);

  // ── T-1 ────────────────────────────────────────────────────────────────
  describe('T-1 · create · TENANT_ADMIN + exact origin', () => {
    it('creates the row stamped with the CLS tenant (never a DTO-supplied one)', async () => {
      const result = await actingAs(tenantAdmin, TENANT_A, () =>
        service.create({ origin: 'https://app.tenant-a.example', label: 'Tenant A app' } as never),
      );

      expect(repository.create).toHaveBeenCalledTimes(1);
      expect((repository.create.mock.calls[0][0] as TenantAllowedOriginEntity).tenantId).toBe(TENANT_A);
      expect(result.origin).toBe('https://app.tenant-a.example');
      expect(invalidateEmitted()).toBe(true);
    });

    it('ignores a DTO-supplied tenantId — the row is stamped from CLS (FR-1 rests on this)', async () => {
      await actingAs(tenantAdmin, TENANT_A, () =>
        service.create({ origin: 'https://app.tenant-a.example', label: 'x', tenantId: TENANT_B } as never),
      );

      expect((repository.create.mock.calls[0][0] as TenantAllowedOriginEntity).tenantId).toBe(TENANT_A);
    });
  });

  // ── T-2 ────────────────────────────────────────────────────────────────
  describe('T-2 · create · wildcard pattern', () => {
    it('refuses a TENANT_ADMIN with 403 and never reaches the repository', async () => {
      await expect(
        actingAs(tenantAdmin, TENANT_A, () => service.create({ origin: 'https://*.evil.com:*', label: 'nope' } as never)),
      ).rejects.toThrow(ForbiddenException);

      expect(repository.create).not.toHaveBeenCalled();
      expect(invalidateEmitted()).toBe(false);
    });

    it('allows a GLOBAL_ADMIN the identical write (FR-5 — no regression)', async () => {
      const result = await actingAs(globalAdmin, TENANT_A, () =>
        service.create({ origin: 'https://*.bcmch.org:*', label: 'BCMCH subdomains' } as never),
      );

      expect(repository.create).toHaveBeenCalledTimes(1);
      expect(result.origin).toBe('https://*.bcmch.org:*');
      expect(invalidateEmitted()).toBe(true);
    });
  });

  // ── T-3 ────────────────────────────────────────────────────────────────
  describe('T-3 · create · bare allow-all token', () => {
    it('refuses a TENANT_ADMIN with 403', async () => {
      await expect(actingAs(tenantAdmin, TENANT_A, () => service.create({ origin: '*', label: 'everything' } as never))).rejects.toThrow(
        ForbiddenException,
      );

      expect(repository.create).not.toHaveBeenCalled();
    });

    it('allows a GLOBAL_ADMIN (FR-5)', async () => {
      const result = await actingAs(globalAdmin, TENANT_A, () => service.create({ origin: '*', label: 'everything' } as never));

      expect(result.origin).toBe('*');
    });
  });

  // ── T-3b — smuggling a wildcard past a RAW-ONLY shape check ────────────
  //
  // `isOriginPattern` is `includes('*')`. That is sound on the raw input ONLY
  // if normalization cannot INTRODUCE a `*` — and it can: `normalizeOrigin`
  // runs the value through the URL parser, which percent-DECODES `%2A` and
  // NFKC-folds the fullwidth asterisk `＊` (U+FF0A) into a plain `*`. Verified
  // empirically against the real normalizer:
  //
  //     normalizeOrigin('https://%2A.evil.com').origin === 'https://*.evil.com'
  //     normalizeOrigin('https://＊.evil.com').origin  === 'https://*.evil.com'
  //
  // Neither raw string contains `*`, so a raw-only gate calls both "exact" and
  // lets them through — and the value that lands in the table is a literal
  // `https://*.evil.com`, which `OriginRegistryService` then matches AS A
  // WILDCARD (its own dispatch is the same `includes('*')`). That is FR-2
  // defeated end to end by a five-character encoding trick. The gate therefore
  // has to judge the CANONICAL value — the one actually persisted and actually
  // matched — not merely the text the caller typed.
  //
  // RESOLVED BY TASK-641 LANE J — this block's original note called the
  // decode-after-check ordering "a defect in `origin-normalizer.ts` (not this
  // lane's file)" and said it pinned the service-side gate "regardless of how
  // that is resolved". It has since been resolved at source: `normalizeOrigin`
  // now re-checks the CANONICAL host and throws `ArgumentInvalidException`, so
  // these inputs are rejected as malformed (400) before the service ever gets
  // to classify their shape. Both outcomes refuse the write and leave the
  // repository untouched, which is the FR-2 property that matters; the
  // assertion below tracks the layer that actually fires so that reverting
  // either layer surfaces here rather than passing silently.
  //
  // Lane E's canonical-value gate in `TenantAllowedOriginService` STAYS — it is
  // deliberate defence in depth, and it remains directly exercised by T-3 (bare
  // `*`) and T-4 (`https://*.evil.com:*`), both of which still assert 403.
  describe('T-3b · create · wildcard smuggled through encoding (defense in depth)', () => {
    it.each([
      ['percent-encoded asterisk', 'https://%2A.evil.com'],
      ['percent-encoded asterisk, lowercase', 'https://%2a.evil.com'],
      ['fullwidth asterisk U+FF0A', 'https://＊.evil.com'],
    ])('refuses a TENANT_ADMIN whose %s normalizes into a wildcard', async (_label, raw) => {
      await expect(actingAs(tenantAdmin, TENANT_A, () => service.create({ origin: raw, label: 'smuggled' } as never))).rejects.toThrow(
        ArgumentInvalidException,
      );

      expect(repository.create).not.toHaveBeenCalled();
      expect(invalidateEmitted()).toBe(false);
    });

    it('refuses the same smuggling on the UPDATE escalation path', async () => {
      repository.findById.mockResolvedValue(makeEntity({ id: 'row-1', tenantId: TENANT_A, origin: 'https://app.tenant-a.example' }));

      await expect(
        actingAs(tenantAdmin, TENANT_A, () => service.update('row-1', { origin: 'https://%2A.evil.com', expectedVersion: 1 } as never)),
      ).rejects.toThrow(ArgumentInvalidException);

      expect(repository.updateWithVersion).not.toHaveBeenCalled();
    });

    it('refuses a GLOBAL_ADMIN too — an encoded wildcard is malformed input, not a privileged write', async () => {
      // The pre-lane-J behaviour would have ADMITTED this for a global admin
      // (it classified as an "exact" origin and stored `https://*.evil.com`).
      // There is no legitimate reason to spell a wildcard this way: the
      // supported form is `https://*.evil.com:*`, which T-4 covers.
      await expect(
        actingAs(globalAdmin, TENANT_A, () => service.create({ origin: 'https://%2A.evil.com', label: 'smuggled' } as never)),
      ).rejects.toThrow(ArgumentInvalidException);

      expect(repository.create).not.toHaveBeenCalled();
    });
  });

  // ── T-4 — the escalation path ──────────────────────────────────────────
  describe('T-4 · update · exact row → pattern (escalation)', () => {
    it('refuses a TENANT_ADMIN with 403 and never writes', async () => {
      repository.findById.mockResolvedValue(makeEntity({ id: 'row-1', tenantId: TENANT_A, origin: 'https://app.tenant-a.example' }));

      await expect(
        actingAs(tenantAdmin, TENANT_A, () => service.update('row-1', { origin: 'https://*.evil.com:*', expectedVersion: 1 } as never)),
      ).rejects.toThrow(ForbiddenException);

      expect(repository.updateWithVersion).not.toHaveBeenCalled();
      expect(invalidateEmitted()).toBe(false);
    });

    it('allows a GLOBAL_ADMIN the identical PATCH (FR-5)', async () => {
      repository.findById.mockResolvedValue(makeEntity({ id: 'row-1', tenantId: TENANT_A, origin: 'https://app.tenant-a.example' }));

      await actingAs(globalAdmin, TENANT_A, () => service.update('row-1', { origin: 'https://*.bcmch.org:*', expectedVersion: 1 } as never));

      expect(repository.updateWithVersion).toHaveBeenCalledTimes(1);
      expect((repository.updateWithVersion.mock.calls[0][1] as TenantAllowedOriginEntity).origin).toBe('https://*.bcmch.org:*');
    });

    it('keeps 404-over-403 for a CROSS-TENANT id even when the payload is a wildcard (no existence leak, no posture change)', async () => {
      repository.findById.mockResolvedValue(makeEntity({ id: 'row-b', tenantId: TENANT_B }));

      await expect(
        actingAs(tenantAdmin, TENANT_A, () => service.update('row-b', { origin: 'https://*.evil.com:*', expectedVersion: 1 } as never)),
      ).rejects.toThrow(NotFoundException);
    });
  });

  // ── T-5 ────────────────────────────────────────────────────────────────
  describe('T-5 · update · label-only edit on an existing pattern row', () => {
    it('is allowed for a TENANT_ADMIN — no origin change means no trust change', async () => {
      repository.findById.mockResolvedValue(makeEntity({ id: 'row-p', tenantId: TENANT_A, origin: 'https://*.bcmch.org:*', label: 'old' }));

      await actingAs(tenantAdmin, TENANT_A, () => service.update('row-p', { label: 'renamed', expectedVersion: 1 } as never));

      expect(repository.updateWithVersion).toHaveBeenCalledTimes(1);
      expect((repository.updateWithVersion.mock.calls[0][1] as TenantAllowedOriginEntity).origin).toBe('https://*.bcmch.org:*');
      expect(invalidateEmitted()).toBe(true);
    });
  });

  // ── T-6 ────────────────────────────────────────────────────────────────
  describe('T-6 · SYSTEM-tenant writes (FR-3)', () => {
    it('refuses a non-global caller creating a SYSTEM row — a SYSTEM row is valid for EVERY tenant', async () => {
      await expect(
        actingAs(tenantAdmin, SYSTEM_TENANT_ID, () => service.create({ origin: 'https://console.example', label: 'console' } as never)),
      ).rejects.toThrow(ForbiddenException);

      expect(repository.create).not.toHaveBeenCalled();
    });

    it('refuses a non-global caller updating a SYSTEM row', async () => {
      repository.findById.mockResolvedValue(makeEntity({ id: 'row-sys', tenantId: SYSTEM_TENANT_ID }));

      await expect(
        actingAs(tenantAdmin, SYSTEM_TENANT_ID, () => service.update('row-sys', { label: 'renamed', expectedVersion: 1 } as never)),
      ).rejects.toThrow(ForbiddenException);

      expect(repository.updateWithVersion).not.toHaveBeenCalled();
    });

    it('refuses a non-global caller deleting a SYSTEM row', async () => {
      repository.findById.mockResolvedValue(makeEntity({ id: 'row-sys', tenantId: SYSTEM_TENANT_ID }));

      await expect(actingAs(tenantAdmin, SYSTEM_TENANT_ID, () => service.deleteById('row-sys'))).rejects.toThrow(ForbiddenException);

      expect(repository.softDelete).not.toHaveBeenCalled();
    });

    it('allows a GLOBAL_ADMIN every SYSTEM-tenant write (FR-5)', async () => {
      await actingAs(globalAdmin, SYSTEM_TENANT_ID, () => service.create({ origin: 'https://console.example', label: 'console' } as never));
      expect((repository.create.mock.calls[0][0] as TenantAllowedOriginEntity).tenantId).toBe(SYSTEM_TENANT_ID);

      repository.findById.mockResolvedValue(makeEntity({ id: 'row-sys', tenantId: SYSTEM_TENANT_ID }));
      await actingAs(globalAdmin, SYSTEM_TENANT_ID, () => service.update('row-sys', { label: 'renamed', expectedVersion: 1 } as never));
      expect(repository.updateWithVersion).toHaveBeenCalledTimes(1);

      repository.softDelete.mockResolvedValue(makeEntity({ id: 'row-sys', tenantId: SYSTEM_TENANT_ID }));
      await actingAs(globalAdmin, SYSTEM_TENANT_ID, () => service.deleteById('row-sys'));
      expect(repository.softDelete).toHaveBeenCalledTimes(1);
    });
  });

  // ── FR-5 tenant-admin happy paths that must NOT be caught by the gates ──
  describe('FR-1 · TENANT_ADMIN retains ordinary exact-origin CRUD in its own tenant', () => {
    it('updates an exact origin to another exact origin', async () => {
      repository.findById.mockResolvedValue(makeEntity({ id: 'row-1', tenantId: TENANT_A }));

      await actingAs(tenantAdmin, TENANT_A, () => service.update('row-1', { origin: 'https://new.tenant-a.example', expectedVersion: 1 } as never));

      expect((repository.updateWithVersion.mock.calls[0][1] as TenantAllowedOriginEntity).origin).toBe('https://new.tenant-a.example');
      expect(invalidateEmitted()).toBe(true);
    });

    it('soft-deletes its own row', async () => {
      repository.findById.mockResolvedValue(makeEntity({ id: 'row-1', tenantId: TENANT_A }));

      await actingAs(tenantAdmin, TENANT_A, () => service.deleteById('row-1'));

      expect(repository.softDelete).toHaveBeenCalledTimes(1);
      expect(invalidateEmitted()).toBe(true);
    });
  });
});
