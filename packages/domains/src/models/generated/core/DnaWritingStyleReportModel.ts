/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { BaseTenantDataModel, VirtualDbProperty } from '../../../common';
import { JsonValue } from '../../../interfaces';
import * as Enums from '../../../enums';
import * as Models from './';

export class DnaWritingStyleReport extends BaseTenantDataModel {
  public doctorId: string;
  // Plaintext reportData / styleText columns DROPPED;
  // persistence is ciphertext-only. The entity keeps these as transient fields
  // repopulated by repository decrypt-on-read.
  // Vault-Transit ciphertext columns + shared key version.
  public encryptedReportData: Uint8Array | null;
  public encryptedStyleText: Uint8Array | null;
  public encryptedRedactionRules: Uint8Array | null;
  public keyVersion: number | null;
  public isLatest: boolean;
  public currentVersionNumber: number;
  public resourceStatus: Enums.ResourceStatusType;
  public resourceStatusUpdatedAt: Date | null;
  public resourceStatusUpdatedBy: string | null;
  @VirtualDbProperty()
  public Doctor: Models.User | undefined;
  @VirtualDbProperty()
  public Versions: Models.DnaWritingStyleVersion[] | undefined;

  constructor(data: DnaWritingStyleReport & BaseTenantDataModel) {
    super(data);
    this.doctorId = data.doctorId;
    this.encryptedReportData = data.encryptedReportData;
    this.encryptedStyleText = data.encryptedStyleText;
    this.encryptedRedactionRules = data.encryptedRedactionRules;
    this.keyVersion = data.keyVersion;
    this.isLatest = data.isLatest;
    this.currentVersionNumber = data.currentVersionNumber;
    this.resourceStatus = data.resourceStatus;
    this.resourceStatusUpdatedAt = data.resourceStatusUpdatedAt;
    this.resourceStatusUpdatedBy = data.resourceStatusUpdatedBy;
    this.Doctor = data.Doctor;
    this.Versions = data.Versions;
  }
}
