/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { generateId } from '../../../utils';
import { BaseEntityFactoryCreateProps } from '../../../common';
import { ConsultationApprovalEntity, IConsultationApprovalEntity } from '../../../entities';
import * as Enums from '../../../enums';

export interface CreateConsultationApprovalProps extends BaseEntityFactoryCreateProps {
  tenantId: IConsultationApprovalEntity['tenantId'];
  consultationId: IConsultationApprovalEntity['consultationId'];
  approvedBy: IConsultationApprovalEntity['approvedBy'];
  approvedAt?: IConsultationApprovalEntity['approvedAt'];
  consultationVersion: IConsultationApprovalEntity['consultationVersion'];
  encounterCount: IConsultationApprovalEntity['encounterCount'];
  snapshot: IConsultationApprovalEntity['snapshot'];
  snapshotHash: IConsultationApprovalEntity['snapshotHash'];
  attestationHash?: IConsultationApprovalEntity['attestationHash'];
  metaData?: IConsultationApprovalEntity['metaData'];
  createdAt?: IConsultationApprovalEntity['createdAt'];
  createdBy?: IConsultationApprovalEntity['createdBy'];
}

export class ConsultationApprovalFactory {
  /**
   * Create an approval snapshot row (ids and versions only, never content).
   */
  static CreateConsultationApproval(props: CreateConsultationApprovalProps): ConsultationApprovalEntity {
    const id = generateId();
    const now = new Date();

    return new ConsultationApprovalEntity({
      id,
      createdAt: props.createdAt || now,
      updatedAt: now,
      createdBy: props.createdBy ?? null,
      updatedBy: null,
      metaData: props.metaData,
      tenantId: props.tenantId,
      consultationId: props.consultationId,
      approvedBy: props.approvedBy,
      approvedAt: props.approvedAt ?? now,
      consultationVersion: props.consultationVersion,
      encounterCount: props.encounterCount,
      snapshot: props.snapshot,
      snapshotHash: props.snapshotHash,
      attestationHash: props.attestationHash ?? null,
    });
  }
}
