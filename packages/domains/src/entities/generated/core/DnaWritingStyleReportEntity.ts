/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { BusinessException } from '@arcaai/exceptions';
import { BaseTenantEntity, IBaseTenantEntity } from '../../../common';
import * as Entities from '../../../entities';
import type { DnaWritingStyleVersionEntity } from './DnaWritingStyleVersionEntity';

export interface IDnaWritingStyleReportEntity extends IBaseTenantEntity {
  doctorId?: string | null;
  departmentId?: string | null;
  reportData?: Record<string, unknown> | null;
  styleText?: string | null;
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

  get reportData(): IDnaWritingStyleReportEntity['reportData'] {
    return this._reportData;
  }

  set reportData(value: IDnaWritingStyleReportEntity['reportData']) {
    this.setProperty('reportData', value);
  }

  get styleText(): IDnaWritingStyleReportEntity['styleText'] {
    return this._styleText;
  }

  set styleText(value: IDnaWritingStyleReportEntity['styleText']) {
    this.setProperty('styleText', value);
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
