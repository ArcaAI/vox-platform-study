/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { BaseTenantDataModel, VirtualDbProperty } from '../../../common';
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
  // TASK-369 Phase 3C — Vault-Transit ciphertext columns + shared key version.
  public encryptedRationale: Uint8Array | null;
  public encryptedDetails: Uint8Array | null;
  public keyVersion: number | null;
  public resourceStatus: Enums.ResourceStatusType;
  public resourceStatusUpdatedAt: Date | null;
  public resourceStatusUpdatedBy: string | null;
  @VirtualDbProperty()
  public EvalRun: Models.EvalRun | undefined;
  @VirtualDbProperty()
  public GoldenCase: Models.GoldenCase | undefined;

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
    this.encryptedRationale = data.encryptedRationale;
    this.encryptedDetails = data.encryptedDetails;
    this.keyVersion = data.keyVersion;
    this.resourceStatus = data.resourceStatus;
    this.resourceStatusUpdatedAt = data.resourceStatusUpdatedAt;
    this.resourceStatusUpdatedBy = data.resourceStatusUpdatedBy;
    this.EvalRun = data.EvalRun;
    this.GoldenCase = data.GoldenCase;
  }
}
