/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { BaseDataModel, VirtualDbProperty } from '../../../common';
import { JsonValue } from '../../../interfaces';
import * as Enums from '../../../enums';
import * as Models from './';

export class UserSettings extends BaseDataModel {
  public name: string;
  public key: string;
  public value: string;
  public dataType: Enums.ValueType;
  public namespace: string | null;
  public resourceStatus: Enums.ResourceStatusType;
  public resourceStatusUpdatedAt: Date | null;
  public resourceStatusUpdatedBy: string | null;
  public userId: string;
  @VirtualDbProperty()
  public User: Models.User | undefined;

  constructor(data: UserSettings & BaseDataModel) {
    super(data);
    this.name = data.name;
    this.key = data.key;
    this.value = data.value;
    this.dataType = data.dataType;
    this.namespace = data.namespace;
    this.resourceStatus = data.resourceStatus;
    this.resourceStatusUpdatedAt = data.resourceStatusUpdatedAt;
    this.resourceStatusUpdatedBy = data.resourceStatusUpdatedBy;
    this.userId = data.userId;
    this.User = data.User;
  }
}
