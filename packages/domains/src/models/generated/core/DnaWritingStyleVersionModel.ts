/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { BaseTenantDataModel, VirtualDbProperty } from '../../../common';
import { JsonValue } from '../../../interfaces';
import * as Enums from '../../../enums';
import * as Models from './';

export class DnaWritingStyleVersion extends BaseTenantDataModel {
  public dnaReportId: string;
  public versionNumber: number;
  // Plaintext reportData / styleText columns DROPPED;
  // persistence is ciphertext-only. The entity keeps these as transient fields
  // repopulated by repository decrypt-on-read.
  // Vault-Transit ciphertext columns + shared key version.
  public encryptedReportData: Uint8Array | null;
  public encryptedStyleText: Uint8Array | null;
  public encryptedRedactionRules: Uint8Array | null;
  public keyVersion: number | null;
  public changeReason: string | null;
  public changedBy: string | null;
  @VirtualDbProperty()
  public DnaWritingStyleReport: Models.DnaWritingStyleReport | undefined;

  constructor(data: DnaWritingStyleVersion & BaseTenantDataModel) {
    super(data);
    this.dnaReportId = data.dnaReportId;
    this.versionNumber = data.versionNumber;
    this.encryptedReportData = data.encryptedReportData;
    this.encryptedStyleText = data.encryptedStyleText;
    this.encryptedRedactionRules = data.encryptedRedactionRules;
    this.keyVersion = data.keyVersion;
    this.changeReason = data.changeReason;
    this.changedBy = data.changedBy;
    this.DnaWritingStyleReport = data.DnaWritingStyleReport;
  }
}
