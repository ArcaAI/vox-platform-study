/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { BaseTenantDataModel } from '../../../common';
import { JsonValue } from '../../../interfaces';
import * as Enums from '../../../enums';
import * as Models from './';

export class GateEditExemplar extends BaseTenantDataModel {
  public consultationId: string;
  public departmentId: string | null;
  public visitType: string | null;
  public gateDecision: string;
  public qualitySignal: string;
  public editDistance: number | null;
  public editDistanceRatio: number | null;
  public timeToSignSeconds: number | null;
  public redactedBefore: string | null;
  public redactedAfter: string | null;
  public contextItemId: string | null;
  public modelName: string | null;
  public promptTemplateId: string | null;
  public curationStatus: Enums.ExemplarCurationStatus;

  constructor(data: GateEditExemplar & BaseTenantDataModel) {
    super(data);
    this.consultationId = data.consultationId;
    this.departmentId = data.departmentId;
    this.visitType = data.visitType;
    this.gateDecision = data.gateDecision;
    this.qualitySignal = data.qualitySignal;
    this.editDistance = data.editDistance;
    this.editDistanceRatio = data.editDistanceRatio;
    this.timeToSignSeconds = data.timeToSignSeconds;
    this.redactedBefore = data.redactedBefore;
    this.redactedAfter = data.redactedAfter;
    this.contextItemId = data.contextItemId;
    this.modelName = data.modelName;
    this.promptTemplateId = data.promptTemplateId;
    this.curationStatus = data.curationStatus;
  }
}
