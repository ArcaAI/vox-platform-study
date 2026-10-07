import { AutoClassMapper, AutoEntityChangeMapper, BaseMapper, createMapperHandlers } from '../../../common';
import * as Entities from '../../../entities';
import * as Models from '../../../models';

// TASK-1050 — `GuardrailEvaluation` is append-only (MODELS_WITHOUT_SOFT_DELETE): it keeps
// `_metadata` / `_version` / audit columns but has NO `resourceStatus*` columns. Those and the
// DB-owned `version` are stripped from every write.
const FIELDS_NOT_WRITABLE: string[] = ['version', 'resourceStatus', 'resourceStatusUpdatedAt', 'resourceStatusUpdatedBy'];

function stripNonWritableFields<T extends object>(model: T, fields: string[]): T {
  for (const field of fields) {
    delete (model as Record<string, unknown>)[field];
  }
  return model;
}

export class GuardrailEvaluationEntityMapper extends BaseMapper<Entities.GuardrailEvaluationEntity, Models.GuardrailEvaluation> {
  constructor() {
    super();
  }

  public toPersistence(entity: Entities.GuardrailEvaluationEntity): Models.GuardrailEvaluation {
    const result = AutoClassMapper(entity, Models.GuardrailEvaluation, GuardrailEvaluationEntityMapperHandlers.$toPersistence);
    return stripNonWritableFields(result, FIELDS_NOT_WRITABLE);
  }

  public toPersistenceChanges(entity: Entities.GuardrailEvaluationEntity): Partial<Models.GuardrailEvaluation> {
    const result = AutoEntityChangeMapper(entity, Models.GuardrailEvaluation, GuardrailEvaluationEntityMapperHandlers.$toPersistence);
    return stripNonWritableFields(result, FIELDS_NOT_WRITABLE);
  }

  public toDomainEntity(dataModel: Models.GuardrailEvaluation): Entities.GuardrailEvaluationEntity {
    return AutoClassMapper(dataModel, Entities.GuardrailEvaluationEntity, GuardrailEvaluationEntityMapperHandlers.$toDomain);
  }
}

export const GuardrailEvaluationEntityMapperHandlers = createMapperHandlers<Entities.GuardrailEvaluationEntity, Models.GuardrailEvaluation>({
  $toPersistence: {
    // Binary ciphertext bypasses the generic walk, which would destructure a Buffer into a
    // plain `{0: byte, …}` map (the ContextItemEntityMapper precedent).
    encryptedWithheldContent: (entity) => entity.encryptedWithheldContent ?? null,
  },
  $toDomain: {
    encryptedWithheldContent: (model) => (model.encryptedWithheldContent ? Buffer.from(model.encryptedWithheldContent) : null),
  },
});
