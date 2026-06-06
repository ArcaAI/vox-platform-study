/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { BaseTenantDataModel } from '../../../common';
import { JsonValue } from '../../../interfaces';
import * as Enums from '../../../enums';
import * as Models from './';

export class EvalScore extends BaseTenantDataModel {
  public evalRunId: string;
  public goldenCaseId: string;
  public metric: string;
  public score: number;
  public maxScore: number | null;
  public rationale: string | null;
  public judgeModel: string | null;
  public details: JsonValue | null;
  public resourceStatus: Enums.ResourceStatusType;
  public resourceStatusUpdatedAt: Date | null;
  public resourceStatusUpdatedBy: string | null;

  constructor(data: EvalScore & BaseTenantDataModel) {
    super(data);
    this.evalRunId = data.evalRunId;
    this.goldenCaseId = data.goldenCaseId;
    this.metric = data.metric;
    this.score = data.score;
    this.maxScore = data.maxScore;
    this.rationale = data.rationale;
    this.judgeModel = data.judgeModel;
    this.details = data.details;
    this.resourceStatus = data.resourceStatus;
    this.resourceStatusUpdatedAt = data.resourceStatusUpdatedAt;
    this.resourceStatusUpdatedBy = data.resourceStatusUpdatedBy;
  }
}
