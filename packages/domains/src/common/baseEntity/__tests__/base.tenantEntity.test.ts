/**
 * BaseTenantEntity unit tests.
 *
 * Verifies the structural and runtime guards that protect every
 * tenant-scoped entity from silently losing its tenant context:
 *
 *   1. `tenantId` is REQUIRED on construction (TypeScript + runtime).
 *   2. `validate()` throws when `tenantId` is empty/undefined/null.
 *   3. The `tenantId` setter is `protected` (external code can't rewrite
 *      the tenant scope of a live entity).
 *   4. The `Tenant` setter throws when assigned null (no silent unset).
 *   5. The `Tenant` setter syncs `tenantId` from the assigned Tenant
 *      on happy paths.
 *
 * Red-then-green proof: each test bypasses TypeScript with `as any`
 * where needed to demonstrate that the runtime guard catches what TS
 * alone cannot (entities hydrated from untyped Prisma rows, hand-rolled
 * test fixtures, etc.).
 */

import { BadRequestException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { BaseTenantEntity, IBaseTenantEntity } from '../base.tenantEntity';

// Stand-in for TenantEntity — importing the real one from
// `../../../entities` would create a circular barrel cycle at module
// load (TenantEntity extends BaseTaggedEntity extends BaseTenantEntity).
// The Tenant setter only reads `tenant.id`, so a duck-typed stand-in
// is sufficient for these tests.
type FakeTenantEntity = { id: string };

const VALID_TENANT_ID = '00000000-0000-0000-0000-000000000001';

// Minimal concrete subclass — inherits BaseTenantEntity.validate()
// directly (no override), so the base tenantId guard runs unmodified.
class TestTenantEntity extends BaseTenantEntity {
  constructor(init: IBaseTenantEntity) {
    super(init);
  }
}

// Subclass that exposes the protected `tenantId` setter for one test
// case that proves the setter mutation path still works for internal
// callers (factories, mappers, lifecycle methods).
class TestTenantEntityWithRewrite extends BaseTenantEntity {
  rewriteTenant(newTenantId: string): void {
    this.tenantId = newTenantId;
  }
}

function makeInit(overrides: Partial<IBaseTenantEntity> = {}): IBaseTenantEntity {
  return {
    id: 'entity-1',
    tenantId: VALID_TENANT_ID,
    createdBy: null,
    updatedBy: null,
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    ...overrides,
  };
}

describe('BaseTenantEntity', () => {
  describe('constructor', () => {
    it('accepts a valid tenantId and exposes it via the getter', () => {
      const entity = new TestTenantEntity(makeInit());

      expect(entity.tenantId).toBe(VALID_TENANT_ID);
    });

    it('does NOT call validate() during construction (validate is an explicit step)', () => {
      // tenantId = '' is invalid, but construction must not throw — the
      // entity is created in a possibly-invalid state and the caller is
      // responsible for invoking validate() before persistence.
      expect(() => new TestTenantEntity(makeInit({ tenantId: '' as never }))).not.toThrow();
    });
  });

  describe('validate() — runtime backstop for missing tenant context', () => {
    it('returns void on a valid tenantId', () => {
      const entity = new TestTenantEntity(makeInit());

      expect(() => entity.validate()).not.toThrow();
    });

    it('throws BadRequestException when tenantId is an empty string', () => {
      const entity = new TestTenantEntity(makeInit({ tenantId: '' as never }));

      expect(() => entity.validate()).toThrow(BadRequestException);
      expect(() => entity.validate()).toThrow(/TestTenantEntity is missing tenant context/);
    });

    it('throws BadRequestException when tenantId is null (bypasses TS via as any)', () => {
      const entity = new TestTenantEntity(makeInit({ tenantId: null as unknown as string }));

      expect(() => entity.validate()).toThrow(BadRequestException);
    });

    it('throws BadRequestException when tenantId is undefined (bypasses TS via as any)', () => {
      const entity = new TestTenantEntity(makeInit({ tenantId: undefined as unknown as string }));

      expect(() => entity.validate()).toThrow(BadRequestException);
    });

    it('error message includes the entity class name (helps audit logs)', () => {
      const entity = new TestTenantEntity(makeInit({ tenantId: '' as never }));

      try {
        entity.validate();
        throw new Error('validate() should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(BadRequestException);
        expect((err as BadRequestException).message).toContain('TestTenantEntity');
      }
    });
  });

  describe('tenantId setter — protected, not public', () => {
    it('TS prevents external assignment (compile-time guard)', () => {
      const entity = new TestTenantEntity(makeInit());

      // @ts-expect-error — tenantId setter is `protected`, external write must
      // not compile. This `@ts-expect-error` line itself fails the build if
      // the line below ever stops being a type error, which is exactly the
      // guard we want.
      entity.tenantId = 'other-tenant';

      // The line above DID run at runtime because TS errors are erased at
      // emit time — we only care that the type system prevents it.
      // Reset the value for any later assertions in this test block.
      void entity.tenantId;
    });

    it('subclasses can rewrite tenantId via internal helpers', () => {
      const entity = new TestTenantEntityWithRewrite(makeInit());
      const NEW_TENANT_ID = '00000000-0000-0000-0000-000000000002';

      entity.rewriteTenant(NEW_TENANT_ID);

      expect(entity.tenantId).toBe(NEW_TENANT_ID);
    });
  });

  describe('Tenant setter — throws on null, syncs tenantId on assign', () => {
    it('throws BadRequestException when assigned null (no silent unset)', () => {
      const entity = new TestTenantEntity(makeInit());

      expect(() => {
        (entity as unknown as { Tenant: FakeTenantEntity | null }).Tenant = null;
      }).toThrow(BadRequestException);
      expect(() => {
        (entity as unknown as { Tenant: FakeTenantEntity | null }).Tenant = null;
      }).toThrow(/Tenant cannot be unset/);
    });

    it('throws BadRequestException when assigned undefined (no silent unset)', () => {
      const entity = new TestTenantEntity(makeInit());

      expect(() => {
        (
          entity as unknown as {
            Tenant: FakeTenantEntity | undefined;
          }
        ).Tenant = undefined;
      }).toThrow(BadRequestException);
    });

    it('syncs tenantId when assigned a concrete Tenant', () => {
      const entity = new TestTenantEntity(makeInit());
      const NEW_TENANT_ID = '00000000-0000-0000-0000-000000000002';

      const fakeTenant: FakeTenantEntity = { id: NEW_TENANT_ID };

      (entity as unknown as { Tenant: FakeTenantEntity }).Tenant = fakeTenant;

      expect(entity.Tenant).toBe(fakeTenant);
      expect(entity.tenantId).toBe(NEW_TENANT_ID);
    });
  });

  describe('IBaseTenantEntity type-shape (compile-time)', () => {
    it('rejects construction without tenantId (TS guard)', () => {
      // @ts-expect-error — `tenantId` is REQUIRED.
      // Omitting it must fail to compile, which this line proves.
      const init: IBaseTenantEntity = {
        id: 'entity-2',
        createdBy: null,
        updatedBy: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      // Touch `init` so it's not lint-flagged as unused; the real check is
      // the @ts-expect-error above.
      expect(init.id).toBe('entity-2');
    });
  });

  /**
   * `set Tenant(...)` is `protected`,
   * matching the `tenantId` setter hardening. External
   * callers can no longer overwrite the tenant relation of a live entity;
   * only subclasses (entity factories, mappers, lifecycle methods) may.
   */
  describe('Tenant relation setter is protected', () => {
    it('TS prevents external assignment (compile-time guard)', () => {
      const entity = new TestTenantEntity(makeInit());
      const fakeTenant: FakeTenantEntity = {
        id: '00000000-0000-0000-0000-000000000099',
      };

      // The cast goes through `never` so the right-hand side is assignable
      // to the setter's `TenantEntity` parameter — that pins the ONLY
      // compile-time error to the protected-access guard, not a type
      // mismatch. (`never` is the bottom type, assignable to anything.)
      // @ts-expect-error — `Tenant` setter is `protected`
      // (audit C-7 finale). External assignment must not compile, mirroring
      // the `tenantId` setter guard above. This `@ts-expect-error` itself
      // fails the build if the line below ever stops being a type error.
      entity.Tenant = fakeTenant as never;

      // The assignment above is erased by TS at emit time, so the line
      // actually runs at runtime — touch the getter so the read is observed
      // by linters as a deliberate side-effect verification, not dead code.
      void entity.Tenant;
    });

    it('subclasses can still rewrite Tenant via internal helpers', () => {
      class TestTenantEntityWithTenantRewrite extends BaseTenantEntity {
        rewriteTenantRelation(tenant: FakeTenantEntity): void {
          // Inside the class hierarchy, the protected setter is reachable.
          // Cast goes through `never` because the real TenantEntity cannot be
          // imported here (circular barrel) and the structural stand-in
          // `FakeTenantEntity` is not assignable to the setter's parameter.
          this.Tenant = tenant as never;
        }
      }

      const entity = new TestTenantEntityWithTenantRewrite(makeInit());
      const NEW_TENANT_ID = '00000000-0000-0000-0000-000000000099';
      const fakeTenant: FakeTenantEntity = { id: NEW_TENANT_ID };

      entity.rewriteTenantRelation(fakeTenant);

      expect(entity.Tenant).toBe(fakeTenant);
      expect(entity.tenantId).toBe(NEW_TENANT_ID);
    });
  });
});
