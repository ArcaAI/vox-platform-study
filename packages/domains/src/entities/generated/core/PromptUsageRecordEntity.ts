/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { BusinessException } from '@arcaai/exceptions';
import { BaseTenantEntity, IBaseTenantEntity } from '../../../common';

export interface IPromptUsageRecordEntity extends IBaseTenantEntity {
  promptTemplateId?: string | null;
  promptVersionNumber?: number | null;
  consultationId?: string | null;
  doctorId?: string | null;
  departmentId?: string | null;
}

export class PromptUsageRecordEntity extends BaseTenantEntity {
  private _promptTemplateId?: IPromptUsageRecordEntity['promptTemplateId'];
  private _promptVersionNumber?: IPromptUsageRecordEntity['promptVersionNumber'];
  private _consultationId?: IPromptUsageRecordEntity['consultationId'];
  private _doctorId?: IPromptUsageRecordEntity['doctorId'];
  private _departmentId?: IPromptUsageRecordEntity['departmentId'];

  constructor(init: IPromptUsageRecordEntity) {
    super(init);
    this._promptTemplateId = init.promptTemplateId;
    this._promptVersionNumber = init.promptVersionNumber;
    this._consultationId = init.consultationId;
    this._doctorId = init.doctorId;
    this._departmentId = init.departmentId;
  }

  get promptTemplateId(): IPromptUsageRecordEntity['promptTemplateId'] {
    return this._promptTemplateId;
  }

  set promptTemplateId(value: IPromptUsageRecordEntity['promptTemplateId']) {
    this.setProperty('promptTemplateId', value);
  }

  get promptVersionNumber(): IPromptUsageRecordEntity['promptVersionNumber'] {
    return this._promptVersionNumber ?? null;
  }

  set promptVersionNumber(value: IPromptUsageRecordEntity['promptVersionNumber']) {
    this.setProperty('promptVersionNumber', value);
  }

  get consultationId(): IPromptUsageRecordEntity['consultationId'] {
    return this._consultationId;
  }

  set consultationId(value: IPromptUsageRecordEntity['consultationId']) {
    this.setProperty('consultationId', value);
  }

  get doctorId(): IPromptUsageRecordEntity['doctorId'] {
    return this._doctorId;
  }

  set doctorId(value: IPromptUsageRecordEntity['doctorId']) {
    this.setProperty('doctorId', value);
  }

  get departmentId(): IPromptUsageRecordEntity['departmentId'] {
    return this._departmentId;
  }

  set departmentId(value: IPromptUsageRecordEntity['departmentId']) {
    this.setProperty('departmentId', value);
  }

}
