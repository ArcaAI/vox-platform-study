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
  // TASK-1020 D-2 — the caller's own encounter id (the `open` key when present)
  externalRef?: IConsultationEntity['externalRef'];
  // Lifecycle state (defaults to OPEN) and background processing (defaults to IDLE)
  status?: IConsultationEntity['status'];
  processing?: IConsultationEntity['processing'];
  // The open encounter (defaults to 1) and when the consultation was last active (defaults to now)
  currentEncounterSeq?: IConsultationEntity['currentEncounterSeq'];
  lastActivityAt?: IConsultationEntity['lastActivityAt'];
  // Health-flag projection on the active phase; not a state of its own
  degradedReasons?: IConsultationEntity['degradedReasons'];
  // Typed promotion of the legacy `metadata.summaryLanguage` (TASK-1004 D-3)
  spokenLanguageMode?: IConsultationEntity['spokenLanguageMode'];
  tenantId: IConsultationEntity['tenantId'];

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
      externalRef: props.externalRef ?? null,
      status: props.status ?? Enums.ConsultationStatus.OPEN,
      processing: props.processing ?? Enums.ConsultationProcessing.IDLE,
      processingReason: null,
      processingRefs: [],
      processingPrior: null,
      processingUpdatedAt: null,
      lastActivityAt: props.lastActivityAt ?? now,
      reopenCount: 0,
      currentEncounterSeq: props.currentEncounterSeq ?? 1,
      segmentSeqHead: 0,
      recordingCursorMs: 0,
      approvedAt: null,
      closedAt: null,
      closedReason: null,
      degradedReasons: props.degradedReasons ?? [],
      spokenLanguageMode: props.spokenLanguageMode ?? null,
      tenantId: props.tenantId,
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
