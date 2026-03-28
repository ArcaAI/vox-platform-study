/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { BusinessException } from '@arcaai/exceptions';
import { BaseTenantEntity, IBaseTenantEntity } from '../../../common';
import type { PromptTemplateEntity } from './PromptTemplateEntity';

export interface IPromptVersionEntity extends IBaseTenantEntity {
  promptTemplateId?: string | null;
  versionNumber?: number | null;
  content?: string | null;
  variables?: Record<string, unknown> | null;
  changeReason?: string | null;
  changedBy?: string | null;
  PromptTemplate?: PromptTemplateEntity | null;
}

export class PromptVersionEntity extends BaseTenantEntity {
  private _promptTemplateId?: IPromptVersionEntity['promptTemplateId'];
  private _versionNumber?: IPromptVersionEntity['versionNumber'];
  private _content?: IPromptVersionEntity['content'];
  private _variables?: IPromptVersionEntity['variables'];
  private _changeReason?: IPromptVersionEntity['changeReason'];
  private _changedBy?: IPromptVersionEntity['changedBy'];
  private _PromptTemplate?: IPromptVersionEntity['PromptTemplate'];

  constructor(init: IPromptVersionEntity) {
    super(init);
    this._promptTemplateId = init.promptTemplateId;
    this._versionNumber = init.versionNumber;
    this._content = init.content;
    this._variables = init.variables;
    this._changeReason = init.changeReason;
    this._changedBy = init.changedBy;
    this._PromptTemplate = init.PromptTemplate;
  }

  get promptTemplateId(): IPromptVersionEntity['promptTemplateId'] {
    return this._promptTemplateId;
  }

  set promptTemplateId(value: IPromptVersionEntity['promptTemplateId']) {
    this.setProperty('promptTemplateId', value);
  }

  get versionNumber(): IPromptVersionEntity['versionNumber'] {
    return this._versionNumber ?? null;
  }

  set versionNumber(value: IPromptVersionEntity['versionNumber']) {
    this.setProperty('versionNumber', value);
  }

  get content(): IPromptVersionEntity['content'] {
    return this._content;
  }

  set content(value: IPromptVersionEntity['content']) {
    this.setProperty('content', value);
  }

  get variables(): IPromptVersionEntity['variables'] {
    return this._variables;
  }

  set variables(value: IPromptVersionEntity['variables']) {
    this.setProperty('variables', value);
  }

  get changeReason(): IPromptVersionEntity['changeReason'] {
    return this._changeReason;
  }

  set changeReason(value: IPromptVersionEntity['changeReason']) {
    this.setProperty('changeReason', value);
  }

  get changedBy(): IPromptVersionEntity['changedBy'] {
    return this._changedBy;
  }

  set changedBy(value: IPromptVersionEntity['changedBy']) {
    this.setProperty('changedBy', value);
  }

  get PromptTemplate(): IPromptVersionEntity['PromptTemplate'] {
    return this._PromptTemplate;
  }

  set PromptTemplate(value: IPromptVersionEntity['PromptTemplate']) {
    this.setProperty('PromptTemplate', value);
  }

  public override validate(): void {}
}
