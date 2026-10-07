import { AutoClassMapper, AutoEntityChangeMapper, BaseMapper, createMapperHandlers } from '../../../common';
import * as Entities from '../../../entities';
import * as Models from '../../../models';

// TASK-1050 — `GuardrailPolicyRevision` is append-only (MODELS_WITHOUT_SOFT_DELETE): no
// `resourceStatus*` columns. Those and the DB-owned `version` are stripped from every write.
const FIELDS_NOT_WRITABLE: string[] = ['version', 'resourceStatus', 'resourceStatusUpdatedAt', 'resourceStatusUpdatedBy'];

function stripNonWritableFields<T extends object>(model: T, fields: string[]): T {
  for (const field of fields) {
    delete (model as Record<string, unknown>)[field];
  }
  return model;
}

export class GuardrailPolicyRevisionEntityMapper extends BaseMapper<Entities.GuardrailPolicyRevisionEntity, Models.GuardrailPolicyRevision> {
  constructor() {
    super();
  }

  public toPersistence(entity: Entities.GuardrailPolicyRevisionEntity): Models.GuardrailPolicyRevision {
    const result = AutoClassMapper(entity, Models.GuardrailPolicyRevision, GuardrailPolicyRevisionEntityMapperHandlers.$toPersistence);
    return stripNonWritableFields(result, FIELDS_NOT_WRITABLE);
  }

  public toPersistenceChanges(entity: Entities.GuardrailPolicyRevisionEntity): Partial<Models.GuardrailPolicyRevision> {
    const result = AutoEntityChangeMapper(entity, Models.GuardrailPolicyRevision, GuardrailPolicyRevisionEntityMapperHandlers.$toPersistence);
    return stripNonWritableFields(result, FIELDS_NOT_WRITABLE);
  }

  public toDomainEntity(dataModel: Models.GuardrailPolicyRevision): Entities.GuardrailPolicyRevisionEntity {
    return AutoClassMapper(dataModel, Entities.GuardrailPolicyRevisionEntity, GuardrailPolicyRevisionEntityMapperHandlers.$toDomain);
  }
}

export const GuardrailPolicyRevisionEntityMapperHandlers = createMapperHandlers<
  Entities.GuardrailPolicyRevisionEntity,
  Models.GuardrailPolicyRevision
>({
  $toPersistence: {},
  $toDomain: {},
});
