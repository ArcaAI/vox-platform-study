import { BaseTenantDataModel } from '../../../common';
import * as Enums from '../../../enums';

export class TenantBucket extends BaseTenantDataModel {
  public name: string;
  public slug: string;
  public description: string | null;
  public bucketType: Enums.TenantBucketType;
  public pathPattern: string;

  public resourceStatus: Enums.ResourceStatusType;
  public resourceStatusUpdatedAt: Date | null;
  public resourceStatusUpdatedBy: string | null;

  constructor(data: TenantBucket & BaseTenantDataModel) {
    super(data);
    this.name = data.name;
    this.slug = data.slug;
    this.description = data.description;
    this.bucketType = data.bucketType;
    this.pathPattern = data.pathPattern;
    this.resourceStatus = data.resourceStatus;
    this.resourceStatusUpdatedAt = data.resourceStatusUpdatedAt;
    this.resourceStatusUpdatedBy = data.resourceStatusUpdatedBy;
  }
}
