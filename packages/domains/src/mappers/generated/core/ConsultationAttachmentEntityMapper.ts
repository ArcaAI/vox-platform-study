import { AutoClassMapper, AutoEntityChangeMapper, BaseMapper, createMapperHandlers } from '../../../common';
import * as Entities from '../../../entities';
import * as Models from '../../../models';

// `ConsultationAttachment` keeps the standard lifecycle (soft delete,
// `_version`). `_version` is DB-owned and stripped from every write path;
// status moves go through the repository's conditional writers.
const FIELDS_NOT_WRITABLE: string[] = ['version'];

function stripNonWritableFields<T extends object>(model: T, fields: string[]): T {
  for (const field of fields) {
    delete (model as Record<string, unknown>)[field];
  }
  return model;
}

export class ConsultationAttachmentEntityMapper extends BaseMapper<Entities.ConsultationAttachmentEntity, Models.ConsultationAttachment> {
  constructor() {
    super();
  }

  public toPersistence(entity: Entities.ConsultationAttachmentEntity): Models.ConsultationAttachment {
    const result = AutoClassMapper(entity, Models.ConsultationAttachment, ConsultationAttachmentEntityMapperHandlers.$toPersistence);
    return stripNonWritableFields(result, FIELDS_NOT_WRITABLE);
  }

  public toPersistenceChanges(entity: Entities.ConsultationAttachmentEntity): Partial<Models.ConsultationAttachment> {
    const result = AutoEntityChangeMapper(entity, Models.ConsultationAttachment, ConsultationAttachmentEntityMapperHandlers.$toPersistence);
    return stripNonWritableFields(result, FIELDS_NOT_WRITABLE);
  }

  public toDomainEntity(dataModel: Models.ConsultationAttachment): Entities.ConsultationAttachmentEntity {
    return AutoClassMapper(dataModel, Entities.ConsultationAttachmentEntity, ConsultationAttachmentEntityMapperHandlers.$toDomain);
  }
}

export const ConsultationAttachmentEntityMapperHandlers = createMapperHandlers<Entities.ConsultationAttachmentEntity, Models.ConsultationAttachment>({
  $toPersistence: {
    // Bytes-safe: return the raw ciphertext Buffer directly.
    encryptedFileName: (entity) => entity.encryptedFileName ?? null,
  },
  $toDomain: {
    encryptedFileName: (model) => model.encryptedFileName ?? null,
  },
});
