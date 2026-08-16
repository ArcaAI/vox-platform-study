import { AutoClassMapper, AutoEntityChangeMapper, BaseMapper, createMapperHandlers } from '../../../common';
import * as Entities from '../../../entities';
import * as Models from '../../../models';
import * as Mappers from '../../../mappers';

// TASK-711: Consultation lifecycle writes now go through
// `ConsultationRepository.updateWithVersion` (transitionTo, prime/close/reopen,
// harness writers). `_version` is owned by the database and the only
// legitimate writer is `Repository.updateWithVersion`. Strip it from every
// write path here so the auto-mappers cannot leak it into a Prisma update.
// Mirrors the `AiTaskDefaultEntityMapper` / `DepartmentEntityMapper` treatment.
const FIELDS_NOT_WRITABLE: string[] = ['version'];

function stripNonWritableFields<T extends object>(model: T, fields: string[]): T {
  for (const field of fields) {
    delete (model as Record<string, unknown>)[field];
  }
  return model;
}

export class ConsultationEntityMapper extends BaseMapper<Entities.ConsultationEntity, Models.Consultation> {
  constructor() {
    super();
  }

  public toPersistence(entity: Entities.ConsultationEntity): Models.Consultation {
    const result = AutoClassMapper(entity, Models.Consultation, ConsultationEntityMapperHandlers.$toPersistence);
    return stripNonWritableFields(result, FIELDS_NOT_WRITABLE);
  }

  public toPersistenceChanges(entity: Entities.ConsultationEntity): Partial<Models.Consultation> {
    const result = AutoEntityChangeMapper(entity, Models.Consultation, ConsultationEntityMapperHandlers.$toPersistence);
    return stripNonWritableFields(result, FIELDS_NOT_WRITABLE);
  }

  public toDomainEntity(dataModel: Models.Consultation): Entities.ConsultationEntity {
    return AutoClassMapper(dataModel, Entities.ConsultationEntity, ConsultationEntityMapperHandlers.$toDomain);
  }
}

export const ConsultationEntityMapperHandlers = createMapperHandlers<Entities.ConsultationEntity, Models.Consultation>({
  $toPersistence: {},
  $toDomain: {},
});
