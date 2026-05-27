import { BadRequestException } from '@nestjs/common';
import { TenantEntity } from '../../entities';
// Import siblings directly to avoid a circular barrel cycle at module
// load (the `index.ts` barrel re-exports BaseTaggedEntity, which extends
// BaseTenantEntity — going through the barrel here breaks single-file
// test loads). TASK-305 A.9.
import { EntityId } from './base.entity';
import { BaseAggregate, BaseAggregateProps } from './base.aggregate';

/**
 * Hardened by TASK-305 Phase A (multi-tenancy hardening):
 * - `tenantId` is REQUIRED on construction; the field can no longer be
 *   silently left null/undefined (matches the schema-level NOT NULL).
 * - The `tenantId` setter is `protected`, so external code can no longer
 *   overwrite a tenant scope. Entities/factories/mappers — and only those —
 *   may rewrite it.
 * - The `Tenant` setter throws if assigned `null`; we never silently clear
 *   the tenant relation. Use a dedicated lifecycle method (e.g. an entity
 *   reparenting helper) if a transfer is ever genuinely needed.
 * - `validate()` is a mandatory runtime backstop — see the method comment.
 */
export interface IBaseTenantEntity extends BaseAggregateProps {
  tenantId: EntityId;
  Tenant?: TenantEntity | null;
}

export abstract class BaseTenantEntity extends BaseAggregate {
  private _tenantId: EntityId;
  private _Tenant?: TenantEntity | null;

  constructor(init: IBaseTenantEntity) {
    super(init);
    this._tenantId = init.tenantId;
  }

  get tenantId(): EntityId {
    return this._tenantId;
  }

  /**
   * Mutation surface is `protected` — only subclasses (entity factories /
   * mappers / lifecycle methods) may overwrite `tenantId`. External callers
   * cannot, by design.
   */
  protected set tenantId(tenantId: EntityId) {
    this.setProperty('tenantId', tenantId);
  }

  get Tenant(): TenantEntity | null | undefined {
    return this._Tenant;
  }

  set Tenant(tenant: TenantEntity) {
    if (tenant === null || tenant === undefined) {
      throw new BadRequestException(
        `${this.constructor.name}: Tenant cannot be unset — assign a concrete TenantEntity, or use a dedicated lifecycle method instead of writing null.`,
      );
    }
    this.setProperty('Tenant', tenant);
    this.setProperty('tenantId', tenant.id);
  }

  /**
   * Mandatory runtime backstop for the schema-level NOT NULL on `tenantId`
   * (TASK-305 Phase A). Catches the cases TypeScript can't — e.g. an entity
   * hydrated from untyped Prisma rows, a mapper that forgot to set tenantId,
   * a hand-rolled `as any` cast in test fixtures.
   *
   * Subclasses that override `validate()` MUST call `super.validate()` (or
   * skip the override entirely) so the tenantId guard is not bypassed.
   */
  public override validate(): void {
    if (
      this._tenantId === null ||
      this._tenantId === undefined ||
      this._tenantId === ''
    ) {
      throw new BadRequestException(
        `${this.constructor.name} is missing tenant context (tenantId is required).`,
      );
    }
  }
}
