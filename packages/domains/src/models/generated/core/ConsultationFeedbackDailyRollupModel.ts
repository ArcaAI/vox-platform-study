/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { BaseTenantDataModel } from '../../../common';
import { JsonValue } from '../../../interfaces';
import * as Enums from '../../../enums';
import * as Models from './';

export class ConsultationFeedbackDailyRollup extends BaseTenantDataModel {
  public day: Date;
  public targetKind: Enums.FeedbackTargetKind;
  public agentSlug: string;
  public agentVersion: number;
  public modelName: string;
  public promptVersion: string;
  public sectionKey: string;
  public entityLabel: string;
  public reasonCode: string;
  public upCount: number;
  public downCount: number;
  public clearedCount: number;
  public commentCount: number;
  public correctionCount: number;
  public reasonedCount: number;
  public computedAt: Date;

  constructor(data: ConsultationFeedbackDailyRollup & BaseTenantDataModel) {
    super(data);
    this.day = data.day;
    this.targetKind = data.targetKind;
    this.agentSlug = data.agentSlug;
    this.agentVersion = data.agentVersion;
    this.modelName = data.modelName;
    this.promptVersion = data.promptVersion;
    this.sectionKey = data.sectionKey;
    this.entityLabel = data.entityLabel;
    this.reasonCode = data.reasonCode;
    this.upCount = data.upCount;
    this.downCount = data.downCount;
    this.clearedCount = data.clearedCount;
    this.commentCount = data.commentCount;
    this.correctionCount = data.correctionCount;
    this.reasonedCount = data.reasonedCount;
    this.computedAt = data.computedAt;
  }
}
