/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { generateId } from '../../../utils';
import { BaseEntityFactoryCreateProps } from '../../../common';
import { ConsultationFeedbackEntity, IConsultationFeedbackEntity } from '../../../entities';
import * as Enums from '../../../enums';

export interface CreateConsultationFeedbackProps extends BaseEntityFactoryCreateProps {
  tenantId: IConsultationFeedbackEntity['tenantId'];
  consultationId: IConsultationFeedbackEntity['consultationId'];
  encounterSeq?: IConsultationFeedbackEntity['encounterSeq'];
  actorUserId: IConsultationFeedbackEntity['actorUserId'];
  actorCredentialClass: IConsultationFeedbackEntity['actorCredentialClass'];
  actorPrincipalId?: IConsultationFeedbackEntity['actorPrincipalId'];
  clientApp?: IConsultationFeedbackEntity['clientApp'];
  clientSurface?: IConsultationFeedbackEntity['clientSurface'];
  targetKind?: IConsultationFeedbackEntity['targetKind'];
  targetContextItemId?: IConsultationFeedbackEntity['targetContextItemId'];
  targetVersionNumber?: IConsultationFeedbackEntity['targetVersionNumber'];
  targetSectionKey?: IConsultationFeedbackEntity['targetSectionKey'];
  targetDocumentKey?: IConsultationFeedbackEntity['targetDocumentKey'];
  targetEntityRef?: IConsultationFeedbackEntity['targetEntityRef'];
  entityLabel?: IConsultationFeedbackEntity['entityLabel'];
  targetKey?: IConsultationFeedbackEntity['targetKey'];
  rating?: IConsultationFeedbackEntity['rating'];
  reasonCodes?: IConsultationFeedbackEntity['reasonCodes'];
  comment?: IConsultationFeedbackEntity['comment'];
  encryptedComment?: IConsultationFeedbackEntity['encryptedComment'];
  keyVersion?: IConsultationFeedbackEntity['keyVersion'];
  mediaIds?: IConsultationFeedbackEntity['mediaIds'];
  correctionContextItemId?: IConsultationFeedbackEntity['correctionContextItemId'];
  correctionVersionNumber?: IConsultationFeedbackEntity['correctionVersionNumber'];
  provenance?: IConsultationFeedbackEntity['provenance'];
  provAgentSlug?: IConsultationFeedbackEntity['provAgentSlug'];
  provAgentVersion?: IConsultationFeedbackEntity['provAgentVersion'];
  provModelName?: IConsultationFeedbackEntity['provModelName'];
  provPromptVersion?: IConsultationFeedbackEntity['provPromptVersion'];
  provWorkflowRunId?: IConsultationFeedbackEntity['provWorkflowRunId'];
  provActivityRunId?: IConsultationFeedbackEntity['provActivityRunId'];
  idempotencyKey?: IConsultationFeedbackEntity['idempotencyKey'];
  isLatest?: IConsultationFeedbackEntity['isLatest'];
  supersedesId?: IConsultationFeedbackEntity['supersedesId'];
  createdAt?: IConsultationFeedbackEntity['createdAt'];
  createdBy?: IConsultationFeedbackEntity['createdBy'];
}

export class ConsultationFeedbackFactory {
  /**
   * Create one feedback fact (isLatest true; `appendWithSupersede` flips the prior row).
   */
  static CreateConsultationFeedback(props: CreateConsultationFeedbackProps): ConsultationFeedbackEntity {
    const id = generateId();
    const now = new Date();

    return new ConsultationFeedbackEntity({
      id,
      createdAt: props.createdAt || now,
      updatedAt: now,
      createdBy: props.createdBy ?? null,
      updatedBy: null,
      tenantId: props.tenantId,
      consultationId: props.consultationId,
      encounterSeq: props.encounterSeq ?? null,
      actorUserId: props.actorUserId,
      actorCredentialClass: props.actorCredentialClass,
      actorPrincipalId: props.actorPrincipalId ?? null,
      clientApp: props.clientApp ?? null,
      clientSurface: props.clientSurface ?? null,
      targetKind: props.targetKind ?? null,
      targetContextItemId: props.targetContextItemId ?? null,
      targetVersionNumber: props.targetVersionNumber ?? null,
      targetSectionKey: props.targetSectionKey ?? null,
      targetDocumentKey: props.targetDocumentKey ?? null,
      targetEntityRef: props.targetEntityRef ?? null,
      entityLabel: props.entityLabel ?? null,
      targetKey: props.targetKey ?? null,
      rating: props.rating ?? null,
      reasonCodes: props.reasonCodes ?? [],
      comment: props.comment ?? null,
      encryptedComment: props.encryptedComment ?? null,
      keyVersion: props.keyVersion ?? null,
      mediaIds: props.mediaIds ?? [],
      correctionContextItemId: props.correctionContextItemId ?? null,
      correctionVersionNumber: props.correctionVersionNumber ?? null,
      provenance: props.provenance ?? null,
      provAgentSlug: props.provAgentSlug ?? null,
      provAgentVersion: props.provAgentVersion ?? null,
      provModelName: props.provModelName ?? null,
      provPromptVersion: props.provPromptVersion ?? null,
      provWorkflowRunId: props.provWorkflowRunId ?? null,
      provActivityRunId: props.provActivityRunId ?? null,
      idempotencyKey: props.idempotencyKey ?? null,
      isLatest: props.isLatest ?? true,
      supersedesId: props.supersedesId ?? null,
    });
  }
}
