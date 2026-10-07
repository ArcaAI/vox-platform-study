/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { BaseTenantDataModel } from '../../../common';
import { JsonValue } from '../../../interfaces';
import * as Enums from '../../../enums';
import * as Models from './';

export class GuardrailEvaluation extends BaseTenantDataModel {
  public requestId: string;
  public consultationId: string | null;
  public runId: string | null;
  public runKey: string | null;
  public nodeId: string | null;
  public agentSlug: string | null;
  public caller: string;
  public direction: Enums.GuardrailDirection;
  public decision: Enums.GuardrailDecision;
  public exempt: string | null;
  public checks: JsonValue;
  public policyVersion: string;
  public noticeIds: string[];
  public encryptedWithheldContent: Uint8Array | null;
  public keyVersion: number | null;
  public at: Date;

  constructor(data: GuardrailEvaluation & BaseTenantDataModel) {
    super(data);
    this.requestId = data.requestId;
    this.consultationId = data.consultationId;
    this.runId = data.runId;
    this.runKey = data.runKey;
    this.nodeId = data.nodeId;
    this.agentSlug = data.agentSlug;
    this.caller = data.caller;
    this.direction = data.direction;
    this.decision = data.decision;
    this.exempt = data.exempt;
    this.checks = data.checks;
    this.policyVersion = data.policyVersion;
    this.noticeIds = data.noticeIds;
    this.encryptedWithheldContent = data.encryptedWithheldContent;
    this.keyVersion = data.keyVersion;
    this.at = data.at;
  }
}
