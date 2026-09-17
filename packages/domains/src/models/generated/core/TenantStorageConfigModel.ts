/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { BaseTenantDataModel, VirtualDbProperty } from '../../../common';
import { JsonValue } from '../../../interfaces';
import * as Enums from '../../../enums';
import * as Models from './';

export class TenantStorageConfig extends BaseTenantDataModel {
  public bucketId: string | null;
  public provider: Enums.StorageProviderType;
  public topology: Enums.StorageTopologyType;
  public endpoint: string | null;
  public region: string | null;
  public forcePathStyle: boolean | null;
  public publicEndpoint: string | null;
  public accountName: string | null;
  public endpointSuffix: string | null;
  public containerPrefix: string | null;
  public credentialsRef: string | null;
  public resourceStatus: Enums.ResourceStatusType;
  public resourceStatusUpdatedAt: Date | null;
  public resourceStatusUpdatedBy: string | null;
  public tags: string[];
  @VirtualDbProperty()
  public Bucket: Models.TenantBucket | undefined;

  constructor(data: TenantStorageConfig & BaseTenantDataModel) {
    super(data);
    this.bucketId = data.bucketId;
    this.provider = data.provider;
    this.topology = data.topology;
    this.endpoint = data.endpoint;
    this.region = data.region;
    this.forcePathStyle = data.forcePathStyle;
    this.publicEndpoint = data.publicEndpoint;
    this.accountName = data.accountName;
    this.endpointSuffix = data.endpointSuffix;
    this.containerPrefix = data.containerPrefix;
    this.credentialsRef = data.credentialsRef;
    this.resourceStatus = data.resourceStatus;
    this.resourceStatusUpdatedAt = data.resourceStatusUpdatedAt;
    this.resourceStatusUpdatedBy = data.resourceStatusUpdatedBy;
    this.tags = data.tags;
    this.Bucket = data.Bucket;
  }
}
