/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { BaseTenantDataModel, VirtualDbProperty } from '../../../common';
import { JsonValue } from '../../../interfaces';
import * as Enums from '../../../enums';
import * as Models from './';

export class Highlight extends BaseTenantDataModel {
  public consultationId: string;
  public sourceContextItemId: string | null;
  public targetKind: Enums.HighlightTargetKind;
  public exact: string;
  public prefix: string | null;
  public suffix: string | null;
  public startOffset: number;
  public endOffset: number;
  public color: string | null;
  public label: string | null;
  public note: string | null;
  // TASK-369 Phase 3C — Vault-Transit ciphertext columns + shared key version.
  public encryptedExact: Uint8Array | null;
  public encryptedPrefix: Uint8Array | null;
  public encryptedSuffix: Uint8Array | null;
  public encryptedNote: Uint8Array | null;
  public keyVersion: number | null;
  public resourceStatus: Enums.ResourceStatusType;
  public resourceStatusUpdatedAt: Date | null;
  public resourceStatusUpdatedBy: string | null;
  @VirtualDbProperty()
  public Consultation: Models.Consultation | undefined;

  constructor(data: Highlight & BaseTenantDataModel) {
    super(data);
    this.consultationId = data.consultationId;
    this.sourceContextItemId = data.sourceContextItemId;
    this.targetKind = data.targetKind;
    this.exact = data.exact;
    this.prefix = data.prefix;
    this.suffix = data.suffix;
    this.startOffset = data.startOffset;
    this.endOffset = data.endOffset;
    this.color = data.color;
    this.label = data.label;
    this.note = data.note;
    this.encryptedExact = data.encryptedExact;
    this.encryptedPrefix = data.encryptedPrefix;
    this.encryptedSuffix = data.encryptedSuffix;
    this.encryptedNote = data.encryptedNote;
    this.keyVersion = data.keyVersion;
    this.resourceStatus = data.resourceStatus;
    this.resourceStatusUpdatedAt = data.resourceStatusUpdatedAt;
    this.resourceStatusUpdatedBy = data.resourceStatusUpdatedBy;
    this.Consultation = data.Consultation;
  }
}
