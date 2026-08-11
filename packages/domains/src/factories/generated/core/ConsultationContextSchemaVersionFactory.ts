/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { BaseEntityFactoryCreateProps } from '../../../common';
import { ConsultationContextSchemaVersionEntity, IConsultationContextSchemaVersionEntity } from '../../../entities';
import { generateId } from '../../../utils';

export interface CreateConsultationContextSchemaVersionProps extends BaseEntityFactoryCreateProps {
  tenantId: IConsultationContextSchemaVersionEntity['tenantId'];
  schemaId: IConsultationContextSchemaVersionEntity['schemaId'];
  versionNumber: IConsultationContextSchemaVersionEntity['versionNumber'];
  definition: IConsultationContextSchemaVersionEntity['definition'];
  checksum: IConsultationContextSchemaVersionEntity['checksum'];
  changeReason?: IConsultationContextSchemaVersionEntity['changeReason'];

  createdAt?: IConsultationContextSchemaVersionEntity['createdAt'];
  createdBy?: IConsultationContextSchemaVersionEntity['createdBy'];
}

export class ConsultationContextSchemaVersionFactory {
  /**
   * One immutable published snapshot. `checksum` is supplied by the caller
   * rather than computed here so the SAME canonicalisation used to decide
   * "is this republish a no-op" is the one persisted — a second
   * implementation here would be a second source of truth.
   *
   * No `updatedAt`/`updatedBy`: the row is never updated (the mapper strips
   * them, mirroring `PromptVersionEntityMapper`).
   */
  static CreateConsultationContextSchemaVersion(
    props: CreateConsultationContextSchemaVersionProps,
  ): ConsultationContextSchemaVersionEntity {
    const id = generateId();
    const now = new Date();

    return new ConsultationContextSchemaVersionEntity({
      id,

      createdAt: props.createdAt || now,
      updatedAt: props.createdAt || now,
      createdBy: props.createdBy ?? null,
      updatedBy: null,

      tenantId: props.tenantId,
      schemaId: props.schemaId,
      versionNumber: props.versionNumber,
      definition: props.definition,
      checksum: props.checksum,
      changeReason: props.changeReason ?? null,
    });
  }
}
