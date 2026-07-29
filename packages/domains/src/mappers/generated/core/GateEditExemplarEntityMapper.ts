import { AutoClassMapper, AutoEntityChangeMapper, BaseMapper, createMapperHandlers } from '../../../common';
import * as Entities from '../../../entities';
import * as Models from '../../../models';

// `_version` is owned by the database and the only legitimate writer is
// `Repository.updateWithVersion`. Strip it from every write path here so the
// auto-mappers cannot leak it into a Prisma update. Mirrors the
// `DepartmentEntityMapper` treatment.
const FIELDS_NOT_WRITABLE: string[] = ['version'];

function stripNonWritableFields<T extends object>(model: T, fields: string[]): T {
  for (const field of fields) {
    delete (model as Record<string, unknown>)[field];
  }
  return model;
}

export class GateEditExemplarEntityMapper extends BaseMapper<Entities.GateEditExemplarEntity, Models.GateEditExemplar> {
  constructor() {
    super();
  }

  public toPersistence(entity: Entities.GateEditExemplarEntity): Models.GateEditExemplar {
    const result = AutoClassMapper(entity, Models.GateEditExemplar, GateEditExemplarEntityMapperHandlers.$toPersistence);
    return stripNonWritableFields(result, FIELDS_NOT_WRITABLE);
  }

  public toPersistenceChanges(entity: Entities.GateEditExemplarEntity): Partial<Models.GateEditExemplar> {
    const result = AutoEntityChangeMapper(entity, Models.GateEditExemplar, GateEditExemplarEntityMapperHandlers.$toPersistence);
    return stripNonWritableFields(result, FIELDS_NOT_WRITABLE);
  }

  public toDomainEntity(dataModel: Models.GateEditExemplar): Entities.GateEditExemplarEntity {
    return AutoClassMapper(dataModel, Entities.GateEditExemplarEntity, GateEditExemplarEntityMapperHandlers.$toDomain);
  }
}

export const GateEditExemplarEntityMapperHandlers = createMapperHandlers<Entities.GateEditExemplarEntity, Models.GateEditExemplar>({
  $toPersistence: {},
  $toDomain: {},
});
