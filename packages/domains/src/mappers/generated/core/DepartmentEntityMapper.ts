import { AutoClassMapper, AutoEntityChangeMapper, BaseMapper, createMapperHandlers } from '../../../common';
import * as Entities from '../../../entities';
import * as Models from '../../../models';
import * as Mappers from '../../../mappers';

export class DepartmentEntityMapper extends BaseMapper<Entities.DepartmentEntity, Models.Department> {
  constructor() {
    super();
  }

  public toPersistence(entity: Entities.DepartmentEntity): Models.Department {
    return AutoClassMapper(entity, Models.Department, DepartmentEntityMapperHandlers.$toPersistence);
  }

  public toPersistenceChanges(entity: Entities.DepartmentEntity): Partial<Models.Department> {
    return AutoEntityChangeMapper(entity, Models.Department, DepartmentEntityMapperHandlers.$toPersistence);
  }

  public toDomainEntity(dataModel: Models.Department): Entities.DepartmentEntity {
    return AutoClassMapper(dataModel, Entities.DepartmentEntity, DepartmentEntityMapperHandlers.$toDomain);
  }
}

export const DepartmentEntityMapperHandlers = createMapperHandlers<Entities.DepartmentEntity, Models.Department>({
  $toPersistence: {},
  $toDomain: {},
});
