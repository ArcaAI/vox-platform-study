import { generateId } from '../../../utils';
import { BaseEntityFactoryCreateProps } from '../../../common';
import { DnaWritingSampleEntity } from '../../../entities/generated/core/DnaWritingSampleEntity';
import { DnaSampleSource } from '../../../enums';

export interface CreateDnaWritingSampleProps extends BaseEntityFactoryCreateProps {
  tenantId: string;
  doctorId: string;
  source: DnaSampleSource;
  textCiphertext: Buffer;
  aiDraftCiphertext?: Buffer | null;
  keyVersion?: number | null;
  writtenAt: Date;
  kind?: string | null;
  sourceRef?: string | null;
  contentHash: string;
  ingestBatchId?: string | null;
  consultationId?: string | null;
  contextItemId?: string | null;
  createdAt?: Date;
  updatedAt?: Date;
  createdBy?: string | null;
  updatedBy?: string | null;
}

export class DnaWritingSampleFactory {
  static CreateDnaWritingSample(props: CreateDnaWritingSampleProps): DnaWritingSampleEntity {
    const now = new Date();
    return new DnaWritingSampleEntity({
      id: generateId(),
      createdAt: props.createdAt || now,
      updatedAt: props.updatedAt || now,
      createdBy: props.createdBy ?? null,
      updatedBy: props.updatedBy ?? null,
      tenantId: props.tenantId,
      doctorId: props.doctorId,
      source: props.source,
      textCiphertext: props.textCiphertext,
      aiDraftCiphertext: props.aiDraftCiphertext ?? null,
      keyVersion: props.keyVersion ?? null,
      writtenAt: props.writtenAt,
      kind: props.kind ?? null,
      sourceRef: props.sourceRef ?? null,
      contentHash: props.contentHash,
      ingestBatchId: props.ingestBatchId ?? null,
      consultationId: props.consultationId ?? null,
      contextItemId: props.contextItemId ?? null,
      consumedByReportId: null,
      consumedAt: null,
    });
  }
}
