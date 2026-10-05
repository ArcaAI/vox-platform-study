import { AutoClassMapper, AutoEntityChangeMapper, BaseMapper, createMapperHandlers } from '../../../common';
import * as Entities from '../../../entities';
import * as Models from '../../../models';

// `ConsultationFeedback` is append-only: no `_metadata`, no `_version`, no
// `updatedBy` / `updatedAt`, no `resourceStatus*` columns — all stripped.
// The transient `comment` is not a column (the model drops it); only
// `encryptedComment` persists.
const FIELDS_NOT_WRITABLE: string[] = [
  'metaData',
  'version',
  'updatedBy',
  'updatedAt',
  'resourceStatus',
  'resourceStatusUpdatedAt',
  'resourceStatusUpdatedBy',
];

function stripNonWritableFields<T extends object>(model: T, fields: string[]): T {
  for (const field of fields) {
    delete (model as Record<string, unknown>)[field];
  }
  return model;
}

export class ConsultationFeedbackEntityMapper extends BaseMapper<Entities.ConsultationFeedbackEntity, Models.ConsultationFeedback> {
  constructor() {
    super();
  }

  public toPersistence(entity: Entities.ConsultationFeedbackEntity): Models.ConsultationFeedback {
    const result = AutoClassMapper(entity, Models.ConsultationFeedback, ConsultationFeedbackEntityMapperHandlers.$toPersistence);
    return stripNonWritableFields(result, FIELDS_NOT_WRITABLE);
  }

  public toPersistenceChanges(entity: Entities.ConsultationFeedbackEntity): Partial<Models.ConsultationFeedback> {
    const result = AutoEntityChangeMapper(entity, Models.ConsultationFeedback, ConsultationFeedbackEntityMapperHandlers.$toPersistence);
    return stripNonWritableFields(result, FIELDS_NOT_WRITABLE);
  }

  public toDomainEntity(dataModel: Models.ConsultationFeedback): Entities.ConsultationFeedbackEntity {
    return AutoClassMapper(dataModel, Entities.ConsultationFeedbackEntity, ConsultationFeedbackEntityMapperHandlers.$toDomain);
  }
}

export const ConsultationFeedbackEntityMapperHandlers = createMapperHandlers<Entities.ConsultationFeedbackEntity, Models.ConsultationFeedback>({
  $toPersistence: {
    // Bytes-safe: return the raw ciphertext Buffer directly.
    encryptedComment: (entity) => entity.encryptedComment ?? null,
  },
  $toDomain: {
    encryptedComment: (model) => model.encryptedComment ?? null,
  },
});
