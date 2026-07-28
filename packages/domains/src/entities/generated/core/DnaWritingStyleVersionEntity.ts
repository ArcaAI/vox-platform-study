/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { BusinessException } from '@arcaai/exceptions';
import { BaseTenantEntity, IBaseTenantEntity, Secret } from '../../../common';
import type { DnaWritingStyleReportEntity } from './DnaWritingStyleReportEntity';

export interface IDnaWritingStyleVersionEntity extends IBaseTenantEntity {
  dnaReportId?: string | null;
  versionNumber?: number | null;
  reportData?: Record<string, unknown> | null;
  styleText?: string | null;
  // TASK-551 — snapshot of the report's structured redaction/rewrite rules
  // (transient plaintext; persisted only as `encryptedRedactionRules`).
  redactionRules?: Record<string, unknown> | null;
  // Vault-Transit (hope-phi) ciphertext of the snapshot
  // fields + shared key version. Phase 6 dropped the plaintext columns;
  // plaintext survives only as transient fields repopulated by decrypt-on-read.
  encryptedReportData?: Buffer | null;
  encryptedStyleText?: Buffer | null;
  encryptedRedactionRules?: Buffer | null;
  keyVersion?: number | null;
  changeReason?: string | null;
  changedBy?: string | null;
  DnaWritingStyleReport?: DnaWritingStyleReportEntity | null;
}

export class DnaWritingStyleVersionEntity extends BaseTenantEntity {
  private _dnaReportId?: IDnaWritingStyleVersionEntity['dnaReportId'];
  private _versionNumber?: IDnaWritingStyleVersionEntity['versionNumber'];
  private _reportData?: IDnaWritingStyleVersionEntity['reportData'];
  private _styleText?: IDnaWritingStyleVersionEntity['styleText'];
  private _redactionRules?: IDnaWritingStyleVersionEntity['redactionRules'];
  private _encryptedReportData?: IDnaWritingStyleVersionEntity['encryptedReportData'];
  private _encryptedStyleText?: IDnaWritingStyleVersionEntity['encryptedStyleText'];
  private _encryptedRedactionRules?: IDnaWritingStyleVersionEntity['encryptedRedactionRules'];
  private _keyVersion?: IDnaWritingStyleVersionEntity['keyVersion'];
  private _changeReason?: IDnaWritingStyleVersionEntity['changeReason'];
  private _changedBy?: IDnaWritingStyleVersionEntity['changedBy'];
  private _DnaWritingStyleReport?: IDnaWritingStyleVersionEntity['DnaWritingStyleReport'];

  constructor(init: IDnaWritingStyleVersionEntity) {
    super(init);
    this._dnaReportId = init.dnaReportId;
    this._versionNumber = init.versionNumber;
    this._reportData = init.reportData;
    this._styleText = init.styleText;
    this._redactionRules = init.redactionRules;
    this._encryptedReportData = init.encryptedReportData;
    this._encryptedStyleText = init.encryptedStyleText;
    this._encryptedRedactionRules = init.encryptedRedactionRules;
    this._keyVersion = init.keyVersion;
    this._changeReason = init.changeReason;
    this._changedBy = init.changedBy;
    this._DnaWritingStyleReport = init.DnaWritingStyleReport;
  }

  get dnaReportId(): IDnaWritingStyleVersionEntity['dnaReportId'] {
    return this._dnaReportId;
  }

  set dnaReportId(value: IDnaWritingStyleVersionEntity['dnaReportId']) {
    this.setProperty('dnaReportId', value);
  }

  get versionNumber(): IDnaWritingStyleVersionEntity['versionNumber'] {
    return this._versionNumber ?? null;
  }

  set versionNumber(value: IDnaWritingStyleVersionEntity['versionNumber']) {
    this.setProperty('versionNumber', value);
  }

  // Clinical PHI fields. @Secret() marks them for audit-log
  // redaction (defense-in-depth) alongside the encrypted counterpart.
  @Secret()
  get reportData(): IDnaWritingStyleVersionEntity['reportData'] {
    return this._reportData;
  }

  set reportData(value: IDnaWritingStyleVersionEntity['reportData']) {
    this.setProperty('reportData', value);
  }

  @Secret()
  get styleText(): IDnaWritingStyleVersionEntity['styleText'] {
    return this._styleText;
  }

  set styleText(value: IDnaWritingStyleVersionEntity['styleText']) {
    this.setProperty('styleText', value);
  }

  @Secret()
  get redactionRules(): IDnaWritingStyleVersionEntity['redactionRules'] {
    return this._redactionRules;
  }

  set redactionRules(value: IDnaWritingStyleVersionEntity['redactionRules']) {
    this.setProperty('redactionRules', value);
  }

  // Vault-Transit ciphertext columns. @Secret() guards the
  // ciphertext from audit-log surfaces.
  @Secret()
  get encryptedReportData(): IDnaWritingStyleVersionEntity['encryptedReportData'] {
    return this._encryptedReportData;
  }

  set encryptedReportData(value: IDnaWritingStyleVersionEntity['encryptedReportData']) {
    this.setProperty('encryptedReportData', value);
  }

  @Secret()
  get encryptedStyleText(): IDnaWritingStyleVersionEntity['encryptedStyleText'] {
    return this._encryptedStyleText;
  }

  set encryptedStyleText(value: IDnaWritingStyleVersionEntity['encryptedStyleText']) {
    this.setProperty('encryptedStyleText', value);
  }

  @Secret()
  get encryptedRedactionRules(): IDnaWritingStyleVersionEntity['encryptedRedactionRules'] {
    return this._encryptedRedactionRules;
  }

  set encryptedRedactionRules(value: IDnaWritingStyleVersionEntity['encryptedRedactionRules']) {
    this.setProperty('encryptedRedactionRules', value);
  }

  get keyVersion(): IDnaWritingStyleVersionEntity['keyVersion'] {
    return this._keyVersion;
  }

  set keyVersion(value: IDnaWritingStyleVersionEntity['keyVersion']) {
    this.setProperty('keyVersion', value);
  }

  get changeReason(): IDnaWritingStyleVersionEntity['changeReason'] {
    return this._changeReason;
  }

  set changeReason(value: IDnaWritingStyleVersionEntity['changeReason']) {
    this.setProperty('changeReason', value);
  }

  get changedBy(): IDnaWritingStyleVersionEntity['changedBy'] {
    return this._changedBy;
  }

  set changedBy(value: IDnaWritingStyleVersionEntity['changedBy']) {
    this.setProperty('changedBy', value);
  }

  get DnaWritingStyleReport(): IDnaWritingStyleVersionEntity['DnaWritingStyleReport'] {
    return this._DnaWritingStyleReport;
  }

  set DnaWritingStyleReport(value: IDnaWritingStyleVersionEntity['DnaWritingStyleReport']) {
    this.setProperty('DnaWritingStyleReport', value);
  }
}
