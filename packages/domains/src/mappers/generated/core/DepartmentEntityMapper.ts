import { AutoClassMapper, AutoEntityChangeMapper, BaseMapper, createMapperHandlers } from '../../../common';
import * as Entities from '../../../entities';
import * as Models from '../../../models';
import * as Mappers from '../../../mappers';

// `_version` is owned by the database and the
// only legitimate writer is `Repository.updateWithVersion`. Strip it from every
// write path here so the auto-mappers cannot leak it into a Prisma update.
// Mirrors the B.6 / E.1.1 treatment on `GlobalSettingEntityMapper` and
// `TenantEntityMapper`.
const FIELDS_NOT_WRITABLE: string[] = ['version'];

function stripNonWritableFields<T extends object>(model: T, fields: string[]): T {
  for (const field of fields) {
    delete (model as Record<string, unknown>)[field];
  }
  return model;
}

export class DepartmentEntityMapper extends BaseMapper<Entities.DepartmentEntity, Models.Department> {
  constructor() {
    super();
  }

  public toPersistence(entity: Entities.DepartmentEntity): Models.Department {
    const result = AutoClassMapper(entity, Models.Department, DepartmentEntityMapperHandlers.$toPersistence);
    return stripNonWritableFields(result, FIELDS_NOT_WRITABLE);
  }

  public toPersistenceChanges(entity: Entities.DepartmentEntity): Partial<Models.Department> {
    const result = AutoEntityChangeMapper(entity, Models.Department, DepartmentEntityMapperHandlers.$toPersistence);
    return stripNonWritableFields(result, FIELDS_NOT_WRITABLE);
  }

  public toDomainEntity(dataModel: Models.Department): Entities.DepartmentEntity {
    return AutoClassMapper(dataModel, Entities.DepartmentEntity, DepartmentEntityMapperHandlers.$toDomain);
  }
}

export const DepartmentEntityMapperHandlers = createMapperHandlers<Entities.DepartmentEntity, Models.Department>({
  $toPersistence: {},
  $toDomain: {},
});
