/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { BaseTenantDataModel, VirtualDbProperty } from '../../../common';
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
  // TASK-369 Phase 6 — plaintext notes column DROPPED; persistence is
  // ciphertext-only. The entity keeps `notes` as a transient field repopulated
  // by repository decrypt-on-read.
  // TASK-369 Phase 3C — Vault-Transit ciphertext columns + shared key version.
  public encryptedNotes: Uint8Array | null;
  public keyVersion: number | null;
  public resourceStatus: Enums.ResourceStatusType;
  public resourceStatusUpdatedAt: Date | null;
  public resourceStatusUpdatedBy: string | null;
  @VirtualDbProperty()
  public GoldenSet: Models.GoldenSet | undefined;
  @VirtualDbProperty()
  public EvalScores: Models.EvalScore[] | undefined;

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
    this.encryptedNotes = data.encryptedNotes;
    this.keyVersion = data.keyVersion;
    this.resourceStatus = data.resourceStatus;
    this.resourceStatusUpdatedAt = data.resourceStatusUpdatedAt;
    this.resourceStatusUpdatedBy = data.resourceStatusUpdatedBy;
    this.GoldenSet = data.GoldenSet;
    this.EvalScores = data.EvalScores;
  }
}
