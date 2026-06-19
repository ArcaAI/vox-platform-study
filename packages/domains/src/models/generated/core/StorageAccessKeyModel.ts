/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { BaseTenantDataModel, VirtualDbProperty } from '../../../common';
import { JsonValue } from '../../../interfaces';
import * as Enums from '../../../enums';
import * as Models from './';

export class StorageAccessKey extends BaseTenantDataModel {
  public name: string;
  public description: string | null;
  public accessKeyId: string;
  public secretAccessKey: string;
  public permissions: string[];
  public bucketIds: string[];
  public expiresAt: Date | null;
  public lastUsedAt: Date | null;
  public lastUsedIp: string | null;
  public resourceStatus: Enums.ResourceStatusType;
  public resourceStatusUpdatedAt: Date | null;
  public resourceStatusUpdatedBy: string | null;
  @VirtualDbProperty()
  public Buckets: Models.TenantBucket[] | undefined;

  constructor(data: StorageAccessKey & BaseTenantDataModel) {
    super(data);
    this.name = data.name;
    this.description = data.description;
    this.accessKeyId = data.accessKeyId;
    this.secretAccessKey = data.secretAccessKey;
    this.permissions = data.permissions;
    this.bucketIds = data.bucketIds;
    this.expiresAt = data.expiresAt;
    this.lastUsedAt = data.lastUsedAt;
    this.lastUsedIp = data.lastUsedIp;
    this.resourceStatus = data.resourceStatus;
    this.resourceStatusUpdatedAt = data.resourceStatusUpdatedAt;
    this.resourceStatusUpdatedBy = data.resourceStatusUpdatedBy;
    this.Buckets = data.Buckets;
  }
}
