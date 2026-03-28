/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { generateId } from '../../../utils';
import { BaseEntityFactoryCreateProps } from '../../../common';
import { ConsultationEntity, IConsultationEntity } from '../../../entities';
import * as Enums from '../../../enums';
import * as Entities from '../../../entities';

export interface CreateConsultationProps extends BaseEntityFactoryCreateProps {
  patientId: IConsultationEntity['patientId'];
  appointmentDate: IConsultationEntity['appointmentDate'];
  doctorId: IConsultationEntity['doctorId'];
  departmentId?: IConsultationEntity['departmentId'];
  parentConsultationId?: IConsultationEntity['parentConsultationId'];
  metadata?: IConsultationEntity['metadata'];
  tenantId?: IConsultationEntity['tenantId'];

  createdAt?: IConsultationEntity['createdAt'];
  updatedAt?: IConsultationEntity['updatedAt'];
  createdBy?: IConsultationEntity['createdBy'];
  updatedBy?: IConsultationEntity['updatedBy'];
}

export class ConsultationFactory {
  /**
   * Create a new consultation
   * - If parentConsultationId is null/undefined: new-visit
   * - If parentConsultationId is set: re-visit
   */
  static CreateConsultation(props: CreateConsultationProps): ConsultationEntity {
    const id = generateId();
    const now = new Date();

    return new ConsultationEntity({
      id,

      createdAt: props.createdAt || now,
      updatedAt: props.updatedAt || now,
      createdBy: props.createdBy ?? null,
      updatedBy: props.updatedBy || null,

      patientId: props.patientId,
      appointmentDate: props.appointmentDate,
      doctorId: props.doctorId,
      departmentId: props.departmentId ?? null,
      parentConsultationId: props.parentConsultationId ?? null,
      metadata: props.metadata ?? null,
      tenantId: props.tenantId ?? '',
    });
  }

  /**
   * Convenience: Create a new-visit consultation (first of the day)
   */
  static CreateNewVisit(props: Omit<CreateConsultationProps, 'parentConsultationId'>): ConsultationEntity {
    return this.CreateConsultation({ ...props, parentConsultationId: undefined });
  }

  /**
   * Convenience: Create a re-visit consultation (follow-up)
   */
  static CreateRevisit(props: CreateConsultationProps & { parentConsultationId: string }): ConsultationEntity {
    return this.CreateConsultation(props);
  }
}
