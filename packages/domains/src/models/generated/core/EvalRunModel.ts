/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { BaseTenantDataModel } from '../../../common';
import { JsonValue } from '../../../interfaces';
import * as Enums from '../../../enums';
import * as Models from './';

export class EvalRun extends BaseTenantDataModel {
  public goldenSetId: string;
  public modelName: string;
  public modelVersion: string | null;
  public promptTemplateId: string | null;
  public promptVersion: string | null;
  public judgeModel: string | null;
  public status: string | null;
  public startedAt: Date | null;
  public completedAt: Date | null;
  public aggregateScores: JsonValue | null;
  public notes: string | null;
  public resourceStatus: Enums.ResourceStatusType;
  public resourceStatusUpdatedAt: Date | null;
  public resourceStatusUpdatedBy: string | null;

  constructor(data: EvalRun & BaseTenantDataModel) {
    super(data);
    this.goldenSetId = data.goldenSetId;
    this.modelName = data.modelName;
    this.modelVersion = data.modelVersion;
    this.promptTemplateId = data.promptTemplateId;
    this.promptVersion = data.promptVersion;
    this.judgeModel = data.judgeModel;
    this.status = data.status;
    this.startedAt = data.startedAt;
    this.completedAt = data.completedAt;
    this.aggregateScores = data.aggregateScores;
    this.notes = data.notes;
    this.resourceStatus = data.resourceStatus;
    this.resourceStatusUpdatedAt = data.resourceStatusUpdatedAt;
    this.resourceStatusUpdatedBy = data.resourceStatusUpdatedBy;
  }
}
