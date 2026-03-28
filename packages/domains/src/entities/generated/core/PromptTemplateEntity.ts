/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { BusinessException } from '@arcaai/exceptions';
import { BaseTaggedEntity, IBaseTaggedEntity } from '../../../common';
import * as Entities from '../../../entities';
import { ResourceStatusType } from '../../../enums';
import type { PromptVersionEntity } from './PromptVersionEntity';

export interface IPromptTemplateEntity extends IBaseTaggedEntity {
  name?: string | null;
  description?: string | null;
  content?: string | null;
  category?: string | null;
  variables?: Record<string, unknown> | null;
  currentVersionNumber?: number | null;
  departmentId?: string | null;
  Versions?: PromptVersionEntity[] | null;
  Department?: Entities.DepartmentEntity | null;
}

export class PromptTemplateEntity extends BaseTaggedEntity {
  private _name?: IPromptTemplateEntity['name'];
  private _description?: IPromptTemplateEntity['description'];
  private _content?: IPromptTemplateEntity['content'];
  private _category?: IPromptTemplateEntity['category'];
  private _variables?: IPromptTemplateEntity['variables'];
  private _currentVersionNumber?: IPromptTemplateEntity['currentVersionNumber'];
  private _departmentId?: IPromptTemplateEntity['departmentId'];
  private _Versions?: IPromptTemplateEntity['Versions'];
  private _Department?: IPromptTemplateEntity['Department'];

  constructor(init: IPromptTemplateEntity) {
    super(init);
    this._name = init.name;
    this._description = init.description;
    this._content = init.content;
    this._category = init.category;
    this._variables = init.variables;
    this._currentVersionNumber = init.currentVersionNumber;
    this._departmentId = init.departmentId;
    this._Versions = init.Versions;
    this._Department = init.Department;
  }

  get name(): IPromptTemplateEntity['name'] {
    return this._name;
  }

  set name(value: IPromptTemplateEntity['name']) {
    this.setProperty('name', value);
  }

  get description(): IPromptTemplateEntity['description'] {
    return this._description;
  }

  set description(value: IPromptTemplateEntity['description']) {
    this.setProperty('description', value);
  }

  get content(): IPromptTemplateEntity['content'] {
    return this._content;
  }

  set content(value: IPromptTemplateEntity['content']) {
    this.setProperty('content', value);
  }

  get category(): IPromptTemplateEntity['category'] {
    return this._category;
  }

  set category(value: IPromptTemplateEntity['category']) {
    this.setProperty('category', value);
  }

  get variables(): IPromptTemplateEntity['variables'] {
    return this._variables;
  }

  set variables(value: IPromptTemplateEntity['variables']) {
    this.setProperty('variables', value);
  }

  get currentVersionNumber(): IPromptTemplateEntity['currentVersionNumber'] {
    return this._currentVersionNumber ?? null;
  }

  set currentVersionNumber(value: IPromptTemplateEntity['currentVersionNumber']) {
    this.setProperty('currentVersionNumber', value);
  }

  get departmentId(): IPromptTemplateEntity['departmentId'] {
    return this._departmentId;
  }

  set departmentId(value: IPromptTemplateEntity['departmentId']) {
    this.setProperty('departmentId', value);
  }

  get Versions(): IPromptTemplateEntity['Versions'] {
    return this._Versions;
  }

  set Versions(value: IPromptTemplateEntity['Versions']) {
    this.setProperty('Versions', value);
  }

  get Department(): IPromptTemplateEntity['Department'] {
    return this._Department;
  }

  set Department(value: IPromptTemplateEntity['Department']) {
    this.setProperty('Department', value);
  }

  public isActive(): boolean {
    return this.resourceStatus === ResourceStatusType.ENABLED;
  }

  public incrementVersion(): void {
    const current = this._currentVersionNumber ?? 0;
    this.setProperty('currentVersionNumber', current + 1);
  }

  public override validate(): void {}
}
