/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { BaseTenantDataModel, VirtualDbProperty } from '../../../common';
import { JsonValue } from '../../../interfaces';
import * as Enums from '../../../enums';
import * as Models from './';

export class TenantBucket extends BaseTenantDataModel {
  public name: string;
  public slug: string;
  public description: string | null;
  public bucketType: Enums.TenantBucketType;
  public purpose: Enums.TenantBucketPurpose;
  public pathPattern: string;
  public quotaBytes: bigint | null;
  public resourceStatus: Enums.ResourceStatusType;
  public resourceStatusUpdatedAt: Date | null;
  public resourceStatusUpdatedBy: string | null;
  public tags: string[];
  @VirtualDbProperty()
  public Medias: Models.Media[] | undefined;
  @VirtualDbProperty()
  public StorageAccessKeys: Models.StorageAccessKey[] | undefined;
  @VirtualDbProperty()
  public StorageConfigs: Models.TenantStorageConfig[] | undefined;

  constructor(data: TenantBucket & BaseTenantDataModel) {
    super(data);
    this.name = data.name;
    this.slug = data.slug;
    this.description = data.description;
    this.bucketType = data.bucketType;
    this.purpose = data.purpose;
    this.pathPattern = data.pathPattern;
    this.quotaBytes = data.quotaBytes;
    this.resourceStatus = data.resourceStatus;
    this.resourceStatusUpdatedAt = data.resourceStatusUpdatedAt;
    this.resourceStatusUpdatedBy = data.resourceStatusUpdatedBy;
    this.tags = data.tags;
    this.Medias = data.Medias;
    this.StorageAccessKeys = data.StorageAccessKeys;
    this.StorageConfigs = data.StorageConfigs;
  }
}
