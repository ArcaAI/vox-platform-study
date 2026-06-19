/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { BaseTenantDataModel, VirtualDbProperty } from '../../../common';
import { JsonValue } from '../../../interfaces';
import * as Enums from '../../../enums';
import * as Models from './';

export class GoldenCase extends BaseTenantDataModel {
  public goldenSetId: string;
  public label: string | null;
  public transcript: string;
  public referenceNote: string;
  // TASK-369 Phase 3C — Vault-Transit ciphertext columns + shared key version.
  public encryptedTranscript: Uint8Array | null;
  public encryptedReferenceNote: Uint8Array | null;
  public keyVersion: number | null;
  public resourceStatus: Enums.ResourceStatusType;
  public resourceStatusUpdatedAt: Date | null;
  public resourceStatusUpdatedBy: string | null;
  @VirtualDbProperty()
  public GoldenSet: Models.GoldenSet | undefined;
  @VirtualDbProperty()
  public EvalScores: Models.EvalScore[] | undefined;

  constructor(data: GoldenCase & BaseTenantDataModel) {
    super(data);
    this.goldenSetId = data.goldenSetId;
    this.label = data.label;
    this.transcript = data.transcript;
    this.referenceNote = data.referenceNote;
    this.encryptedTranscript = data.encryptedTranscript;
    this.encryptedReferenceNote = data.encryptedReferenceNote;
    this.keyVersion = data.keyVersion;
    this.resourceStatus = data.resourceStatus;
    this.resourceStatusUpdatedAt = data.resourceStatusUpdatedAt;
    this.resourceStatusUpdatedBy = data.resourceStatusUpdatedBy;
    this.GoldenSet = data.GoldenSet;
    this.EvalScores = data.EvalScores;
  }
}
