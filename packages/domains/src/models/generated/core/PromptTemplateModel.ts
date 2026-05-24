/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { BaseTenantDataModel } from '../../../common';
import * as Enums from '../../../enums';
import * as Models from './';

export class PromptTemplate extends BaseTenantDataModel {
  public name: string | null;
  public description: string | null;
  public content: string | null;
  public category: string | null;
  public variables: any | null;
  public currentVersionNumber: number | null;
  public departmentId: string | null;
  public scope: string | null;
  public ownerUserId: string | null;
  public tags: string[];
  public resourceStatus: Enums.ResourceStatusType;
  public resourceStatusUpdatedAt: Date | null;
  public resourceStatusUpdatedBy: string | null;

  constructor(data: PromptTemplate & BaseTenantDataModel) {
    super(data);
    this.name = data.name;
    this.description = data.description;
    this.content = data.content;
    this.category = data.category;
    this.variables = data.variables;
    this.currentVersionNumber = data.currentVersionNumber;
    this.departmentId = data.departmentId;
    this.scope = data.scope;
    this.ownerUserId = data.ownerUserId;
    this.tags = data.tags;
    this.resourceStatus = data.resourceStatus;
    this.resourceStatusUpdatedAt = data.resourceStatusUpdatedAt;
    this.resourceStatusUpdatedBy = data.resourceStatusUpdatedBy;
  }
}
