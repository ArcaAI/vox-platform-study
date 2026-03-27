/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import Decimal from 'decimal.js';
import { BusinessException } from '@arcaai/exceptions';
import { BaseTenantEntity, IBaseTenantEntity } from '../../../common';
import { JsonValue } from '../../../interfaces';
import * as Enums from '../../../enums';
import * as Entities from '../../../entities';

export interface IConsultationEntity extends IBaseTenantEntity {
  patientId: string;
  appointmentDate: Date;
  doctorId: string;
  departmentId?: string | null;
  parentConsultationId?: string | null;
  metadata?: JsonValue | null;
  Doctor?: Entities.UserEntity | null;
  Department?: Entities.DepartmentEntity | null;
  ParentConsultation?: Entities.ConsultationEntity | null;
  ChildConsultations?: Entities.ConsultationEntity[] | null;
  ContextItems?: Entities.ContextItemEntity[] | null;
}

export class ConsultationEntity extends BaseTenantEntity {
  private _patientId: IConsultationEntity['patientId'];
  private _appointmentDate: IConsultationEntity['appointmentDate'];
  private _doctorId: IConsultationEntity['doctorId'];
  private _departmentId?: IConsultationEntity['departmentId'];
  private _parentConsultationId?: IConsultationEntity['parentConsultationId'];
  private _metadata?: IConsultationEntity['metadata'];
  private _Doctor?: IConsultationEntity['Doctor'];
  private _Department?: IConsultationEntity['Department'];
  private _ParentConsultation?: IConsultationEntity['ParentConsultation'];
  private _ChildConsultations?: IConsultationEntity['ChildConsultations'];
  private _ContextItems?: IConsultationEntity['ContextItems'];

  constructor(init: IConsultationEntity) {
    super(init);
    this._patientId = init.patientId;
    this._appointmentDate = init.appointmentDate;
    this._doctorId = init.doctorId;
    this._departmentId = init.departmentId;
    this._parentConsultationId = init.parentConsultationId;
    this._metadata = init.metadata;
    this._Doctor = init.Doctor;
    this._Department = init.Department;
    this._ParentConsultation = init.ParentConsultation;
    this._ChildConsultations = init.ChildConsultations;
    this._ContextItems = init.ContextItems;
  }

  get patientId(): IConsultationEntity['patientId'] {
    return this._patientId;
  }

  set patientId(value: IConsultationEntity['patientId']) {
    this.setProperty('patientId', value);
  }

  get appointmentDate(): IConsultationEntity['appointmentDate'] {
    return this._appointmentDate;
  }

  set appointmentDate(value: IConsultationEntity['appointmentDate']) {
    this.setProperty('appointmentDate', value);
  }

  get doctorId(): IConsultationEntity['doctorId'] {
    return this._doctorId;
  }

  set doctorId(value: IConsultationEntity['doctorId']) {
    this.setProperty('doctorId', value);
  }

  get departmentId(): IConsultationEntity['departmentId'] {
    return this._departmentId;
  }

  set departmentId(value: IConsultationEntity['departmentId']) {
    this.setProperty('departmentId', value);
  }

  get parentConsultationId(): IConsultationEntity['parentConsultationId'] {
    return this._parentConsultationId;
  }

  set parentConsultationId(value: IConsultationEntity['parentConsultationId']) {
    this.setProperty('parentConsultationId', value);
  }

  get metadata(): IConsultationEntity['metadata'] {
    return this._metadata;
  }

  set metadata(value: IConsultationEntity['metadata']) {
    this.setProperty('metadata', value);
  }

  get Doctor(): IConsultationEntity['Doctor'] {
    return this._Doctor;
  }

  set Doctor(value: IConsultationEntity['Doctor']) {
    this.setProperty('Doctor', value);
  }

  get Department(): IConsultationEntity['Department'] {
    return this._Department;
  }

  set Department(value: IConsultationEntity['Department']) {
    this.setProperty('Department', value);
  }

  get ParentConsultation(): IConsultationEntity['ParentConsultation'] {
    return this._ParentConsultation;
  }

  set ParentConsultation(value: IConsultationEntity['ParentConsultation']) {
    this.setProperty('ParentConsultation', value);
  }

  get ChildConsultations(): IConsultationEntity['ChildConsultations'] {
    return this._ChildConsultations;
  }

  set ChildConsultations(value: IConsultationEntity['ChildConsultations']) {
    this.setProperty('ChildConsultations', value);
  }

  get ContextItems(): IConsultationEntity['ContextItems'] {
    return this._ContextItems;
  }

  set ContextItems(value: IConsultationEntity['ContextItems']) {
    this.setProperty('ContextItems', value);
  }

  // ============================================
  // Custom Domain Methods
  // ============================================

  /**
   * Check if this is a new-visit (first consultation of the day)
   */
  get isNewVisit(): boolean {
    return !this._parentConsultationId;
  }

  /**
   * Check if this is a re-visit (follow-up consultation)
   */
  get isRevisit(): boolean {
    return !!this._parentConsultationId;
  }

  public override validate(): void {
    if (!this._patientId) {
      throw new BusinessException('Patient ID is required');
    }
    if (!this._doctorId) {
      throw new BusinessException('Doctor ID is required');
    }
    if (!this._appointmentDate) {
      throw new BusinessException('Appointment date is required');
    }
  }
}
