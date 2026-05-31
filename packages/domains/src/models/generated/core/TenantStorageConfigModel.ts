import { BaseTenantDataModel } from '../../../common';
import * as Enums from '../../../enums';

export class TenantStorageConfig extends BaseTenantDataModel {
  public bucketId: string | null;
  public provider: Enums.StorageProviderType;
  public topology: Enums.StorageTopologyType;
  public endpoint: string | null;
  public region: string | null;
  public forcePathStyle: boolean | null;
  public accountName: string | null;
  public endpointSuffix: string | null;
  public containerPrefix: string | null;
  public credentialsRef: string | null;

  public resourceStatus: Enums.ResourceStatusType;
  public resourceStatusUpdatedAt: Date | null;
  public resourceStatusUpdatedBy: string | null;

  constructor(data: TenantStorageConfig & BaseTenantDataModel) {
    super(data);
    this.bucketId = data.bucketId;
    this.provider = data.provider;
    this.topology = data.topology;
    this.endpoint = data.endpoint;
    this.region = data.region;
    this.forcePathStyle = data.forcePathStyle;
    this.accountName = data.accountName;
    this.endpointSuffix = data.endpointSuffix;
    this.containerPrefix = data.containerPrefix;
    this.credentialsRef = data.credentialsRef;
    this.resourceStatus = data.resourceStatus;
    this.resourceStatusUpdatedAt = data.resourceStatusUpdatedAt;
    this.resourceStatusUpdatedBy = data.resourceStatusUpdatedBy;
  }
}
