/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { BusinessException } from '@arcaai/exceptions';
import { BaseTenantEntity, IBaseTenantEntity } from '../../../common';

// Runtime observation (TASK-648) — one row per running process, heartbeated
// (`lastSeenAt`) every 5 minutes. NO `resourceStatus` column: stale rows are
// pruned wholesale by the existing scheduler surface (30-day retention),
// never individually soft-deleted (see MODELS_WITHOUT_SOFT_DELETE). Always
// platform-wide under the SYSTEM tenant. An instance is "live" if
// `lastSeenAt` is within 15 minutes; that threshold is resolved by the
// application service, not this entity.
export interface IServiceInstanceEntity extends IBaseTenantEntity {
  releaseId: string;
  serviceName: string;
  environment: string;
  instanceId: string;
  startedAt: Date;
  lastSeenAt: Date;
}

export class ServiceInstanceEntity extends BaseTenantEntity {
  private _releaseId: IServiceInstanceEntity['releaseId'];
  private _serviceName: IServiceInstanceEntity['serviceName'];
  private _environment: IServiceInstanceEntity['environment'];
  private _instanceId: IServiceInstanceEntity['instanceId'];
  private _startedAt: IServiceInstanceEntity['startedAt'];
  private _lastSeenAt: IServiceInstanceEntity['lastSeenAt'];

  constructor(init: IServiceInstanceEntity) {
    super(init);
    this._releaseId = init.releaseId;
    this._serviceName = init.serviceName;
    this._environment = init.environment;
    this._instanceId = init.instanceId;
    this._startedAt = init.startedAt;
    this._lastSeenAt = init.lastSeenAt;
  }

  get releaseId(): IServiceInstanceEntity['releaseId'] {
    return this._releaseId;
  }

  set releaseId(value: IServiceInstanceEntity['releaseId']) {
    this.setProperty('releaseId', value);
  }

  get serviceName(): IServiceInstanceEntity['serviceName'] {
    return this._serviceName;
  }

  set serviceName(value: IServiceInstanceEntity['serviceName']) {
    this.setProperty('serviceName', value);
  }

  get environment(): IServiceInstanceEntity['environment'] {
    return this._environment;
  }

  set environment(value: IServiceInstanceEntity['environment']) {
    this.setProperty('environment', value);
  }

  get instanceId(): IServiceInstanceEntity['instanceId'] {
    return this._instanceId;
  }

  set instanceId(value: IServiceInstanceEntity['instanceId']) {
    this.setProperty('instanceId', value);
  }

  get startedAt(): IServiceInstanceEntity['startedAt'] {
    return this._startedAt;
  }

  set startedAt(value: IServiceInstanceEntity['startedAt']) {
    this.setProperty('startedAt', value);
  }

  get lastSeenAt(): IServiceInstanceEntity['lastSeenAt'] {
    return this._lastSeenAt;
  }

  set lastSeenAt(value: IServiceInstanceEntity['lastSeenAt']) {
    this.setProperty('lastSeenAt', value);
  }

  public override validate(): void {
    super.validate();
    if (!this._releaseId || this._releaseId.trim().length === 0) {
      throw new BusinessException('Release id is required');
    }
    if (!this._serviceName || this._serviceName.trim().length === 0) {
      throw new BusinessException('Service name is required');
    }
    if (!this._environment || this._environment.trim().length === 0) {
      throw new BusinessException('Environment is required');
    }
    if (!this._instanceId || this._instanceId.trim().length === 0) {
      throw new BusinessException('Instance id is required');
    }
  }
}
