/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { BaseTenantDataModel } from '../../../common';
import { JsonValue } from '../../../interfaces';
import * as Enums from '../../../enums';
import * as Models from './';

export class AgentAssignmentChange extends BaseTenantDataModel {
  public scope: Enums.PipelinePolicyScope;
  public scopeId: string | null;
  public task: Enums.AgentTask;
  public changedBy: string | null;
  public assignmentVersion: number | null;
  public beforeSlug: string | null;
  public afterSlug: string | null;
  public reason: string | null;

  constructor(data: AgentAssignmentChange & BaseTenantDataModel) {
    super(data);
    this.scope = data.scope;
    this.scopeId = data.scopeId;
    this.task = data.task;
    this.changedBy = data.changedBy;
    this.assignmentVersion = data.assignmentVersion;
    this.beforeSlug = data.beforeSlug;
    this.afterSlug = data.afterSlug;
    this.reason = data.reason;
  }
}
