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
  public changeReason: string | null;
  public changedBy: string | null;
  public changeSource: string | null;
  // Plaintext content / contentDiff / changeSummary /
  // fieldChanges columns DROPPED; persistence is ciphertext-only. The entity
  // keeps these as transient fields repopulated by repository decrypt-on-read.
  // Vault-Transit ciphertext columns + shared key version.
  public encryptedContent: Uint8Array | null;
  public encryptedContentDiff: Uint8Array | null;
  public encryptedChangeSummary: Uint8Array | null;
  public encryptedFieldChanges: Uint8Array | null;
  public keyVersion: number | null;
  // Clinician attestation (confirm-before-commit gate)
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
    this.changeReason = data.changeReason;
    this.changedBy = data.changedBy;
    this.changeSource = data.changeSource;
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
