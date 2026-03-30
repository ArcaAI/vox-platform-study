/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { BaseTenantDataModel, VirtualDbProperty } from '../../../common';
import { JsonValue } from '../../../interfaces';
import * as Enums from '../../../enums';
import * as Models from './';

export class Media extends BaseTenantDataModel {
  public name: string;
  public uri: string;
  public extension: string;
  public mimeType: string;
  public size: number;
  public hash: string;
  public bucketId: string | null;
  public resourceStatus: Enums.ResourceStatusType;
  public resourceStatusUpdatedAt: Date | null;
  public resourceStatusUpdatedBy: string | null;
  public tags: string[];
  @VirtualDbProperty()
  public UserMedias: Models.UserMedia[] | undefined;

  constructor(data: Media & BaseTenantDataModel) {
    super(data);
    this.name = data.name;
    this.uri = data.uri;
    this.extension = data.extension;
    this.mimeType = data.mimeType;
    this.size = data.size;
    this.hash = data.hash;
    this.bucketId = data.bucketId;
    this.resourceStatus = data.resourceStatus;
    this.resourceStatusUpdatedAt = data.resourceStatusUpdatedAt;
    this.resourceStatusUpdatedBy = data.resourceStatusUpdatedBy;
    this.tags = data.tags;
    this.UserMedias = data.UserMedias;
  }
}
