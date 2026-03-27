import { TenantEntity } from '../../entities';
import { EntityId, BaseAggregate, BaseAggregateProps } from '.';

export interface IBaseTenantEntity extends BaseAggregateProps {
  tenantId?: EntityId | null;
  Tenant?: TenantEntity | null;
}

export abstract class BaseTenantEntity extends BaseAggregate {
  private _tenantId?: EntityId | null;
  private _Tenant?: TenantEntity | null;

  constructor(init: IBaseTenantEntity) {
    super(init);
    this._tenantId = init.tenantId;
  }

  get tenantId(): EntityId | null | undefined {
    return this._tenantId;
  }

  set tenantId(tenantId: EntityId | null) {
    this.setProperty('tenantId', tenantId);
  }

  get Tenant(): TenantEntity | null | undefined {
    return this._Tenant;
  }

  set Tenant(tenant: TenantEntity | null) {
    this.setProperty('Tenant', tenant);
    this.setProperty('tenantId', tenant?.id);
  }

  public override validate(): void {}
}
