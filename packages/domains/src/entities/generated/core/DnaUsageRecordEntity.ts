/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { BusinessException } from '@arcaai/exceptions';
import { BaseTenantEntity, IBaseTenantEntity } from '../../../common';

export interface IDnaUsageRecordEntity extends IBaseTenantEntity {
  doctorId?: string | null;
  dnaReportId?: string | null;
  dnaVersionNumber?: number | null;
  consultationId?: string | null;
  departmentId?: string | null;
}

export class DnaUsageRecordEntity extends BaseTenantEntity {
  private _doctorId?: IDnaUsageRecordEntity['doctorId'];
  private _dnaReportId?: IDnaUsageRecordEntity['dnaReportId'];
  private _dnaVersionNumber?: IDnaUsageRecordEntity['dnaVersionNumber'];
  private _consultationId?: IDnaUsageRecordEntity['consultationId'];
  private _departmentId?: IDnaUsageRecordEntity['departmentId'];

  constructor(init: IDnaUsageRecordEntity) {
    super(init);
    this._doctorId = init.doctorId;
    this._dnaReportId = init.dnaReportId;
    this._dnaVersionNumber = init.dnaVersionNumber;
    this._consultationId = init.consultationId;
    this._departmentId = init.departmentId;
  }

  get doctorId(): IDnaUsageRecordEntity['doctorId'] {
    return this._doctorId;
  }

  set doctorId(value: IDnaUsageRecordEntity['doctorId']) {
    this.setProperty('doctorId', value);
  }

  get dnaReportId(): IDnaUsageRecordEntity['dnaReportId'] {
    return this._dnaReportId;
  }

  set dnaReportId(value: IDnaUsageRecordEntity['dnaReportId']) {
    this.setProperty('dnaReportId', value);
  }

  get dnaVersionNumber(): IDnaUsageRecordEntity['dnaVersionNumber'] {
    return this._dnaVersionNumber ?? null;
  }

  set dnaVersionNumber(value: IDnaUsageRecordEntity['dnaVersionNumber']) {
    this.setProperty('dnaVersionNumber', value);
  }

  get consultationId(): IDnaUsageRecordEntity['consultationId'] {
    return this._consultationId;
  }

  set consultationId(value: IDnaUsageRecordEntity['consultationId']) {
    this.setProperty('consultationId', value);
  }

  get departmentId(): IDnaUsageRecordEntity['departmentId'] {
    return this._departmentId;
  }

  set departmentId(value: IDnaUsageRecordEntity['departmentId']) {
    this.setProperty('departmentId', value);
  }

}
