/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { generateId } from '../../../utils';
import { BaseEntityFactoryCreateProps } from '../../../common';
import { ConsultationEncounterEntity, IConsultationEncounterEntity } from '../../../entities';
import * as Enums from '../../../enums';

export interface CreateConsultationEncounterProps extends BaseEntityFactoryCreateProps {
  tenantId: IConsultationEncounterEntity['tenantId'];
  consultationId: IConsultationEncounterEntity['consultationId'];
  seq: IConsultationEncounterEntity['seq'];
  visitType: IConsultationEncounterEntity['visitType'];
  externalRef?: IConsultationEncounterEntity['externalRef'];
  startedAt?: IConsultationEncounterEntity['startedAt'];
  endedAt?: IConsultationEncounterEntity['endedAt'];
  recordingStartMs?: IConsultationEncounterEntity['recordingStartMs'];
  recordingEndMs?: IConsultationEncounterEntity['recordingEndMs'];
  metaData?: IConsultationEncounterEntity['metaData'];
  createdAt?: IConsultationEncounterEntity['createdAt'];
  createdBy?: IConsultationEncounterEntity['createdBy'];
}

export class ConsultationEncounterFactory {
  /**
   * Create an encounter row. The caller allocates `seq` (the consultation's
   * new `currentEncounterSeq`).
   */
  static CreateConsultationEncounter(props: CreateConsultationEncounterProps): ConsultationEncounterEntity {
    const id = generateId();
    const now = new Date();

    return new ConsultationEncounterEntity({
      id,
      createdAt: props.createdAt || now,
      updatedAt: now,
      createdBy: props.createdBy ?? null,
      updatedBy: null,
      metaData: props.metaData,
      tenantId: props.tenantId,
      consultationId: props.consultationId,
      seq: props.seq,
      visitType: props.visitType,
      externalRef: props.externalRef ?? null,
      startedAt: props.startedAt ?? now,
      endedAt: props.endedAt ?? null,
      recordingStartMs: props.recordingStartMs ?? null,
      recordingEndMs: props.recordingEndMs ?? null,
    });
  }
}
