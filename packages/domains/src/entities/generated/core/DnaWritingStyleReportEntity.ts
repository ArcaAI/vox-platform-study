/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { BusinessException } from '@arcaai/exceptions';
import { BaseTenantEntity, IBaseTenantEntity, Secret } from '../../../common';
import * as Entities from '../../../entities';
import type { DnaWritingStyleVersionEntity } from './DnaWritingStyleVersionEntity';

export interface IDnaWritingStyleReportEntity extends IBaseTenantEntity {
  doctorId?: string | null;
  departmentId?: string | null;
  reportData?: Record<string, unknown> | null;
  styleText?: string | null;
  // Structured DNA redaction/rewrite rules
  // ({ rules: [{ id, type, match, pattern, replacement?, note? }] }). Transient
  // plaintext (repopulated by decrypt-on-read); persisted ONLY as the
  // `encryptedRedactionRules` ciphertext below.
  redactionRules?: Record<string, unknown> | null;
  // Vault-Transit (hope-phi) ciphertext of the
  // writing-style fields + shared key version. Phase 6 dropped the plaintext
  // columns; plaintext survives only as transient fields repopulated by
  // decrypt-on-read.
  encryptedReportData?: Buffer | null;
  encryptedStyleText?: Buffer | null;
  encryptedRedactionRules?: Buffer | null;
  keyVersion?: number | null;
  isLatest?: boolean | null;
  currentVersionNumber?: number | null;
  Doctor?: Entities.UserEntity | null;
  Department?: Entities.DepartmentEntity | null;
  Versions?: DnaWritingStyleVersionEntity[] | null;
}

export class DnaWritingStyleReportEntity extends BaseTenantEntity {
  private _doctorId?: IDnaWritingStyleReportEntity['doctorId'];
  private _departmentId?: IDnaWritingStyleReportEntity['departmentId'];
  private _reportData?: IDnaWritingStyleReportEntity['reportData'];
  private _styleText?: IDnaWritingStyleReportEntity['styleText'];
  private _redactionRules?: IDnaWritingStyleReportEntity['redactionRules'];
  private _encryptedReportData?: IDnaWritingStyleReportEntity['encryptedReportData'];
  private _encryptedStyleText?: IDnaWritingStyleReportEntity['encryptedStyleText'];
  private _encryptedRedactionRules?: IDnaWritingStyleReportEntity['encryptedRedactionRules'];
  private _keyVersion?: IDnaWritingStyleReportEntity['keyVersion'];
  private _isLatest?: IDnaWritingStyleReportEntity['isLatest'];
  private _currentVersionNumber?: IDnaWritingStyleReportEntity['currentVersionNumber'];
  private _Doctor?: IDnaWritingStyleReportEntity['Doctor'];
  private _Department?: IDnaWritingStyleReportEntity['Department'];
  private _Versions?: IDnaWritingStyleReportEntity['Versions'];

  constructor(init: IDnaWritingStyleReportEntity) {
    super(init);
    this._doctorId = init.doctorId;
    this._departmentId = init.departmentId;
    this._reportData = init.reportData;
    this._styleText = init.styleText;
    this._redactionRules = init.redactionRules;
    this._encryptedReportData = init.encryptedReportData;
    this._encryptedStyleText = init.encryptedStyleText;
    this._encryptedRedactionRules = init.encryptedRedactionRules;
    this._keyVersion = init.keyVersion;
    this._isLatest = init.isLatest;
    this._currentVersionNumber = init.currentVersionNumber;
    this._Doctor = init.Doctor;
    this._Department = init.Department;
    this._Versions = init.Versions;
  }

  get doctorId(): IDnaWritingStyleReportEntity['doctorId'] {
    return this._doctorId;
  }

  set doctorId(value: IDnaWritingStyleReportEntity['doctorId']) {
    this.setProperty('doctorId', value);
  }

  get departmentId(): IDnaWritingStyleReportEntity['departmentId'] {
    return this._departmentId;
  }

  set departmentId(value: IDnaWritingStyleReportEntity['departmentId']) {
    this.setProperty('departmentId', value);
  }

  // Clinical PHI fields. @Secret() marks them for audit-log
  // redaction (defense-in-depth) alongside the encrypted counterpart.
  @Secret()
  get reportData(): IDnaWritingStyleReportEntity['reportData'] {
    return this._reportData;
  }

  set reportData(value: IDnaWritingStyleReportEntity['reportData']) {
    this.setProperty('reportData', value);
  }

  @Secret()
  get styleText(): IDnaWritingStyleReportEntity['styleText'] {
    return this._styleText;
  }

  set styleText(value: IDnaWritingStyleReportEntity['styleText']) {
    this.setProperty('styleText', value);
  }

  @Secret()
  get redactionRules(): IDnaWritingStyleReportEntity['redactionRules'] {
    return this._redactionRules;
  }

  set redactionRules(value: IDnaWritingStyleReportEntity['redactionRules']) {
    this.setProperty('redactionRules', value);
  }

  // Vault-Transit ciphertext columns. @Secret() guards the
  // ciphertext from audit-log surfaces.
  @Secret()
  get encryptedReportData(): IDnaWritingStyleReportEntity['encryptedReportData'] {
    return this._encryptedReportData;
  }

  set encryptedReportData(value: IDnaWritingStyleReportEntity['encryptedReportData']) {
    this.setProperty('encryptedReportData', value);
  }

  @Secret()
  get encryptedStyleText(): IDnaWritingStyleReportEntity['encryptedStyleText'] {
    return this._encryptedStyleText;
  }

  set encryptedStyleText(value: IDnaWritingStyleReportEntity['encryptedStyleText']) {
    this.setProperty('encryptedStyleText', value);
  }

  @Secret()
  get encryptedRedactionRules(): IDnaWritingStyleReportEntity['encryptedRedactionRules'] {
    return this._encryptedRedactionRules;
  }

  set encryptedRedactionRules(value: IDnaWritingStyleReportEntity['encryptedRedactionRules']) {
    this.setProperty('encryptedRedactionRules', value);
  }

  get keyVersion(): IDnaWritingStyleReportEntity['keyVersion'] {
    return this._keyVersion;
  }

  set keyVersion(value: IDnaWritingStyleReportEntity['keyVersion']) {
    this.setProperty('keyVersion', value);
  }

  get isLatest(): IDnaWritingStyleReportEntity['isLatest'] {
    return this._isLatest ?? null;
  }

  set isLatest(value: IDnaWritingStyleReportEntity['isLatest']) {
    this.setProperty('isLatest', value);
  }

  get currentVersionNumber(): IDnaWritingStyleReportEntity['currentVersionNumber'] {
    return this._currentVersionNumber ?? null;
  }

  set currentVersionNumber(value: IDnaWritingStyleReportEntity['currentVersionNumber']) {
    this.setProperty('currentVersionNumber', value);
  }

  get Doctor(): IDnaWritingStyleReportEntity['Doctor'] {
    return this._Doctor;
  }

  set Doctor(value: IDnaWritingStyleReportEntity['Doctor']) {
    this.setProperty('Doctor', value);
  }

  get Department(): IDnaWritingStyleReportEntity['Department'] {
    return this._Department;
  }

  set Department(value: IDnaWritingStyleReportEntity['Department']) {
    this.setProperty('Department', value);
  }

  get Versions(): IDnaWritingStyleReportEntity['Versions'] {
    return this._Versions;
  }

  set Versions(value: IDnaWritingStyleReportEntity['Versions']) {
    this.setProperty('Versions', value);
  }

  public markAsLatest(): void {
    this.setProperty('isLatest', true);
  }

  public unmarkAsLatest(): void {
    this.setProperty('isLatest', false);
  }

  public incrementVersion(): void {
    const current = this._currentVersionNumber ?? 0;
    this.setProperty('currentVersionNumber', current + 1);
  }
}
