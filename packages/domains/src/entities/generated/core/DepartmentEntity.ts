/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { BusinessException } from '@arcaai/exceptions';
import { BaseTenantEntity, IBaseTenantEntity } from '../../../common';
import * as Entities from '../../../entities';

export interface IDepartmentEntity extends IBaseTenantEntity {
  code?: string | null;
  name?: string | null;
  description?: string | null;
  parentDepartmentId?: string | null;

  // Prompt configuration (GAP-3: Department-to-prompt mapping)
  defaultSummaryTemplate?: string | null;
  preSummaryPromptId?: string | null;
  newPatientPromptId?: string | null;
  revisitPromptId?: string | null;
  promptConfig?: Record<string, unknown> | null;

  ParentDepartment?: Entities.DepartmentEntity | null;
  ChildDepartments?: Entities.DepartmentEntity[] | null;
  Consultations?: Entities.ConsultationEntity[] | null;
}

export class DepartmentEntity extends BaseTenantEntity {
  private _code?: IDepartmentEntity['code'];
  private _name?: IDepartmentEntity['name'];
  private _description?: IDepartmentEntity['description'];
  private _parentDepartmentId?: IDepartmentEntity['parentDepartmentId'];
  private _defaultSummaryTemplate?: IDepartmentEntity['defaultSummaryTemplate'];
  private _preSummaryPromptId?: IDepartmentEntity['preSummaryPromptId'];
  private _newPatientPromptId?: IDepartmentEntity['newPatientPromptId'];
  private _revisitPromptId?: IDepartmentEntity['revisitPromptId'];
  private _promptConfig?: IDepartmentEntity['promptConfig'];
  private _ParentDepartment?: IDepartmentEntity['ParentDepartment'];
  private _ChildDepartments?: IDepartmentEntity['ChildDepartments'];
  private _Consultations?: IDepartmentEntity['Consultations'];

  constructor(init: IDepartmentEntity) {
    super(init);
    this._code = init.code;
    this._name = init.name;
    this._description = init.description;
    this._parentDepartmentId = init.parentDepartmentId;
    this._defaultSummaryTemplate = init.defaultSummaryTemplate;
    this._preSummaryPromptId = init.preSummaryPromptId;
    this._newPatientPromptId = init.newPatientPromptId;
    this._revisitPromptId = init.revisitPromptId;
    this._promptConfig = init.promptConfig;
    this._ParentDepartment = init.ParentDepartment;
    this._ChildDepartments = init.ChildDepartments;
    this._Consultations = init.Consultations;
  }

  get code(): IDepartmentEntity['code'] {
    return this._code;
  }

  set code(value: IDepartmentEntity['code']) {
    this.setProperty('code', value);
  }

  get name(): IDepartmentEntity['name'] {
    return this._name;
  }

  set name(value: IDepartmentEntity['name']) {
    this.setProperty('name', value);
  }

  get description(): IDepartmentEntity['description'] {
    return this._description;
  }

  set description(value: IDepartmentEntity['description']) {
    this.setProperty('description', value);
  }

  get parentDepartmentId(): IDepartmentEntity['parentDepartmentId'] {
    return this._parentDepartmentId;
  }

  set parentDepartmentId(value: IDepartmentEntity['parentDepartmentId']) {
    this.setProperty('parentDepartmentId', value);
  }

  get defaultSummaryTemplate(): IDepartmentEntity['defaultSummaryTemplate'] {
    return this._defaultSummaryTemplate;
  }

  set defaultSummaryTemplate(value: IDepartmentEntity['defaultSummaryTemplate']) {
    this.setProperty('defaultSummaryTemplate', value);
  }

  get preSummaryPromptId(): IDepartmentEntity['preSummaryPromptId'] {
    return this._preSummaryPromptId;
  }

  set preSummaryPromptId(value: IDepartmentEntity['preSummaryPromptId']) {
    this.setProperty('preSummaryPromptId', value);
  }

  get newPatientPromptId(): IDepartmentEntity['newPatientPromptId'] {
    return this._newPatientPromptId;
  }

  set newPatientPromptId(value: IDepartmentEntity['newPatientPromptId']) {
    this.setProperty('newPatientPromptId', value);
  }

  get revisitPromptId(): IDepartmentEntity['revisitPromptId'] {
    return this._revisitPromptId;
  }

  set revisitPromptId(value: IDepartmentEntity['revisitPromptId']) {
    this.setProperty('revisitPromptId', value);
  }

  get promptConfig(): IDepartmentEntity['promptConfig'] {
    return this._promptConfig;
  }

  set promptConfig(value: IDepartmentEntity['promptConfig']) {
    this.setProperty('promptConfig', value);
  }

  get ParentDepartment(): IDepartmentEntity['ParentDepartment'] {
    return this._ParentDepartment;
  }

  set ParentDepartment(value: IDepartmentEntity['ParentDepartment']) {
    this.setProperty('ParentDepartment', value);
  }

  get ChildDepartments(): IDepartmentEntity['ChildDepartments'] {
    return this._ChildDepartments;
  }

  set ChildDepartments(value: IDepartmentEntity['ChildDepartments']) {
    this.setProperty('ChildDepartments', value);
  }

  get Consultations(): IDepartmentEntity['Consultations'] {
    return this._Consultations;
  }

  set Consultations(value: IDepartmentEntity['Consultations']) {
    this.setProperty('Consultations', value);
  }

  // ============================================
  // Custom Domain Methods
  // ============================================

  /**
   * Check if this is a root department (no parent)
   */
  get isRootDepartment(): boolean {
    return !this._parentDepartmentId;
  }

  /**
   * Check if this department has children
   */
  get hasChildren(): boolean {
    return !!this._ChildDepartments && this._ChildDepartments.length > 0;
  }

  public override validate(): void {
    // code and name are now optional, no validation required
  }
}
