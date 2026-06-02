import { AutoClassMapper, AutoEntityChangeMapper, BaseMapper, createMapperHandlers } from '../../../common';
import * as Entities from '../../../entities';
import * as Models from '../../../models';
import * as Mappers from '../../../mappers';

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

export class UserDepartmentEntityMapper extends BaseMapper<Entities.UserDepartmentEntity, Models.UserDepartment> {
  constructor() {
    super();
  }

  public toPersistence(entity: Entities.UserDepartmentEntity): Models.UserDepartment {
    const result = AutoClassMapper(entity, Models.UserDepartment, UserDepartmentEntityMapperHandlers.$toPersistence);
    return stripNonWritableFields(result, FIELDS_NOT_WRITABLE);
  }

  public toPersistenceChanges(entity: Entities.UserDepartmentEntity): Partial<Models.UserDepartment> {
    const result = AutoEntityChangeMapper(entity, Models.UserDepartment, UserDepartmentEntityMapperHandlers.$toPersistence);
    return stripNonWritableFields(result, FIELDS_NOT_WRITABLE);
  }

  public toDomainEntity(dataModel: Models.UserDepartment): Entities.UserDepartmentEntity {
    return AutoClassMapper(dataModel, Entities.UserDepartmentEntity, UserDepartmentEntityMapperHandlers.$toDomain);
  }
}

export const UserDepartmentEntityMapperHandlers = createMapperHandlers<Entities.UserDepartmentEntity, Models.UserDepartment>({
  $toPersistence: {},
  $toDomain: {},
});
