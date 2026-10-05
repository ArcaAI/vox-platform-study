/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { generateId } from '../../../utils';
import { BaseEntityFactoryCreateProps } from '../../../common';
import { ConsultationAttachmentEntity, IConsultationAttachmentEntity } from '../../../entities';
import * as Enums from '../../../enums';

export interface CreateConsultationAttachmentProps extends BaseEntityFactoryCreateProps {
  tenantId: IConsultationAttachmentEntity['tenantId'];
  consultationId: IConsultationAttachmentEntity['consultationId'];
  encounterSeq?: IConsultationAttachmentEntity['encounterSeq'];
  purpose?: IConsultationAttachmentEntity['purpose'];
  kind: IConsultationAttachmentEntity['kind'];
  status?: IConsultationAttachmentEntity['status'];
  uploadMode?: IConsultationAttachmentEntity['uploadMode'];
  declaredMime: IConsultationAttachmentEntity['declaredMime'];
  declaredSizeBytes: IConsultationAttachmentEntity['declaredSizeBytes'];
  declaredSha256: IConsultationAttachmentEntity['declaredSha256'];
  bucketName: IConsultationAttachmentEntity['bucketName'];
  objectKey: IConsultationAttachmentEntity['objectKey'];
  encryptedFileName?: IConsultationAttachmentEntity['encryptedFileName'];
  keyVersion?: IConsultationAttachmentEntity['keyVersion'];
  idempotencyKey?: IConsultationAttachmentEntity['idempotencyKey'];
  uploadExpiresAt: IConsultationAttachmentEntity['uploadExpiresAt'];
  intentExpiresAt: IConsultationAttachmentEntity['intentExpiresAt'];
  completedAt?: IConsultationAttachmentEntity['completedAt'];
  failureCode?: IConsultationAttachmentEntity['failureCode'];
  mediaId?: IConsultationAttachmentEntity['mediaId'];
  contextItemId?: IConsultationAttachmentEntity['contextItemId'];
  transcriptionJobId?: IConsultationAttachmentEntity['transcriptionJobId'];
  metaData?: IConsultationAttachmentEntity['metaData'];
  createdAt?: IConsultationAttachmentEntity['createdAt'];
  createdBy?: IConsultationAttachmentEntity['createdBy'];
}

export class ConsultationAttachmentFactory {
  /**
   * Create an upload intent (status INTENT unless stated).
   */
  static CreateConsultationAttachment(props: CreateConsultationAttachmentProps): ConsultationAttachmentEntity {
    const id = generateId();
    const now = new Date();

    return new ConsultationAttachmentEntity({
      id,
      createdAt: props.createdAt || now,
      updatedAt: now,
      createdBy: props.createdBy ?? null,
      updatedBy: null,
      metaData: props.metaData,
      tenantId: props.tenantId,
      consultationId: props.consultationId,
      encounterSeq: props.encounterSeq ?? null,
      purpose: props.purpose ?? Enums.ConsultationAttachmentPurpose.ATTACHMENT,
      kind: props.kind,
      status: props.status ?? Enums.ConsultationAttachmentStatus.INTENT,
      uploadMode: props.uploadMode ?? 'PRESIGNED',
      declaredMime: props.declaredMime,
      declaredSizeBytes: props.declaredSizeBytes,
      declaredSha256: props.declaredSha256,
      bucketName: props.bucketName,
      objectKey: props.objectKey,
      encryptedFileName: props.encryptedFileName ?? null,
      keyVersion: props.keyVersion ?? null,
      idempotencyKey: props.idempotencyKey ?? null,
      uploadExpiresAt: props.uploadExpiresAt,
      intentExpiresAt: props.intentExpiresAt,
      completedAt: props.completedAt ?? null,
      failureCode: props.failureCode ?? null,
      mediaId: props.mediaId ?? null,
      contextItemId: props.contextItemId ?? null,
      transcriptionJobId: props.transcriptionJobId ?? null,
    });
  }
}
