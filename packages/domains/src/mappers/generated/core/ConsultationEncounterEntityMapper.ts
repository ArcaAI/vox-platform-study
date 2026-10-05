import { AutoClassMapper, AutoEntityChangeMapper, BaseMapper, createMapperHandlers } from '../../../common';
import * as Entities from '../../../entities';
import * as Models from '../../../models';

// `ConsultationEncounter` has `_version` (DB-owned; only
// `Repository.updateWithVersion` writes it) and NO `resourceStatus*` columns
// (MODELS_WITHOUT_SOFT_DELETE). Both are stripped from every write path.
const FIELDS_NOT_WRITABLE: string[] = ['version', 'resourceStatus', 'resourceStatusUpdatedAt', 'resourceStatusUpdatedBy'];

function stripNonWritableFields<T extends object>(model: T, fields: string[]): T {
  for (const field of fields) {
    delete (model as Record<string, unknown>)[field];
  }
  return model;
}

export class ConsultationEncounterEntityMapper extends BaseMapper<Entities.ConsultationEncounterEntity, Models.ConsultationEncounter> {
  constructor() {
    super();
  }

  public toPersistence(entity: Entities.ConsultationEncounterEntity): Models.ConsultationEncounter {
    const result = AutoClassMapper(entity, Models.ConsultationEncounter, ConsultationEncounterEntityMapperHandlers.$toPersistence);
    return stripNonWritableFields(result, FIELDS_NOT_WRITABLE);
  }

  public toPersistenceChanges(entity: Entities.ConsultationEncounterEntity): Partial<Models.ConsultationEncounter> {
    const result = AutoEntityChangeMapper(entity, Models.ConsultationEncounter, ConsultationEncounterEntityMapperHandlers.$toPersistence);
    return stripNonWritableFields(result, FIELDS_NOT_WRITABLE);
  }

  public toDomainEntity(dataModel: Models.ConsultationEncounter): Entities.ConsultationEncounterEntity {
    return AutoClassMapper(dataModel, Entities.ConsultationEncounterEntity, ConsultationEncounterEntityMapperHandlers.$toDomain);
  }
}

export const ConsultationEncounterEntityMapperHandlers = createMapperHandlers<Entities.ConsultationEncounterEntity, Models.ConsultationEncounter>({
  $toPersistence: {},
  $toDomain: {},
});
