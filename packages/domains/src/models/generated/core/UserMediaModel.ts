/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { BaseDataModel, VirtualDbProperty } from '../../../common';
import { JsonValue } from '../../../interfaces';
import * as Enums from '../../../enums';
import * as Models from './';

export class UserMedia extends BaseDataModel {
  public sharedAt: Date | null;
  public resourceStatus: Enums.ResourceStatusType;
  public resourceStatusUpdatedAt: Date | null;
  public resourceStatusUpdatedBy: string | null;
  public tags: string[];
  public userId: string;
  public mediaId: string;
  @VirtualDbProperty()
  public User: Models.User | undefined;
  @VirtualDbProperty()
  public Media: Models.Media | undefined;

  constructor(data: UserMedia & BaseDataModel) {
    super(data);
    this.sharedAt = data.sharedAt;
    this.resourceStatus = data.resourceStatus;
    this.resourceStatusUpdatedAt = data.resourceStatusUpdatedAt;
    this.resourceStatusUpdatedBy = data.resourceStatusUpdatedBy;
    this.tags = data.tags;
    this.userId = data.userId;
    this.mediaId = data.mediaId;
    this.User = data.User;
    this.Media = data.Media;
  }
}
