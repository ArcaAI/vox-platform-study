/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { BaseTenantDataModel, VirtualDbProperty } from '../../../common';
import { JsonValue } from '../../../interfaces';
import * as Enums from '../../../enums';
import * as Models from './';

export class ContextItemVersion extends BaseTenantDataModel {
  public contextItemId: string;
  public versionNumber: number;
  public content: string | null;
  public contentDiff: string | null;
  public changeReason: string | null;
  public changeSummary: string | null;
  public changedBy: string | null;
  public changeSource: string | null;
  public fieldChanges: JsonValue | null;
  // TASK-369 Phase 3C — Vault-Transit ciphertext columns + shared key version.
  public encryptedContent: Uint8Array | null;
  public encryptedContentDiff: Uint8Array | null;
  public encryptedChangeSummary: Uint8Array | null;
  public encryptedFieldChanges: Uint8Array | null;
  public keyVersion: number | null;
  // TASK-330 Phase 1 — clinician attestation (confirm-before-commit gate)
  public attestedAt: Date | null;
  public attestedBy: string | null;
  public attestationHash: string | null;
  public modelName: string | null;
  public modelVersion: string | null;
  public sensorScores: JsonValue | null;
  @VirtualDbProperty()
  public ContextItem: Models.ContextItem | undefined;

  constructor(data: ContextItemVersion & BaseTenantDataModel) {
    super(data);
    this.contextItemId = data.contextItemId;
    this.versionNumber = data.versionNumber;
    this.content = data.content;
    this.contentDiff = data.contentDiff;
    this.changeReason = data.changeReason;
    this.changeSummary = data.changeSummary;
    this.changedBy = data.changedBy;
    this.changeSource = data.changeSource;
    this.fieldChanges = data.fieldChanges;
    this.encryptedContent = data.encryptedContent;
    this.encryptedContentDiff = data.encryptedContentDiff;
    this.encryptedChangeSummary = data.encryptedChangeSummary;
    this.encryptedFieldChanges = data.encryptedFieldChanges;
    this.keyVersion = data.keyVersion;
    this.attestedAt = data.attestedAt;
    this.attestedBy = data.attestedBy;
    this.attestationHash = data.attestationHash;
    this.modelName = data.modelName;
    this.modelVersion = data.modelVersion;
    this.sensorScores = data.sensorScores;
    this.ContextItem = data.ContextItem;
  }
}
