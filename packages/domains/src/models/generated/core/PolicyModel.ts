/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { BaseDataModel, VirtualDbProperty } from '../../../common';
import { JsonValue } from '../../../interfaces';
import * as Enums from '../../../enums';
import * as Models from './';

export class Policy extends BaseDataModel {
  public name: string;
  public description: string | null;
  public rules: JsonValue;
  public scope: Enums.PolicyScope;
  public isProtected: boolean;
  public resourceStatus: Enums.ResourceStatusType;
  public resourceStatusUpdatedAt: Date | null;
  public resourceStatusUpdatedBy: string | null;
  @VirtualDbProperty()
  public RolePolicies: Models.RolePolicy[] | undefined;

  constructor(data: Policy & BaseDataModel) {
    super(data);
    this.name = data.name;
    this.description = data.description;
    this.rules = data.rules;
    this.scope = data.scope;
    this.isProtected = data.isProtected;
    this.resourceStatus = data.resourceStatus;
    this.resourceStatusUpdatedAt = data.resourceStatusUpdatedAt;
    this.resourceStatusUpdatedBy = data.resourceStatusUpdatedBy;
    this.RolePolicies = data.RolePolicies;
  }
}
