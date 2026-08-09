/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { BaseTenantDataModel, VirtualDbProperty } from '../../../common';
import { JsonValue } from '../../../interfaces';
import * as Enums from '../../../enums';
import * as Models from './';

export class ServiceInstance extends BaseTenantDataModel {
  public releaseId: string;
  public serviceName: string;
  public environment: string;
  public instanceId: string;
  public startedAt: Date;
  public lastSeenAt: Date;
  @VirtualDbProperty()
  public ServiceRelease: Models.ServiceRelease | undefined;

  constructor(data: ServiceInstance & BaseTenantDataModel) {
    super(data);
    this.releaseId = data.releaseId;
    this.serviceName = data.serviceName;
    this.environment = data.environment;
    this.instanceId = data.instanceId;
    this.startedAt = data.startedAt;
    this.lastSeenAt = data.lastSeenAt;
    this.ServiceRelease = data.ServiceRelease;
  }
}
