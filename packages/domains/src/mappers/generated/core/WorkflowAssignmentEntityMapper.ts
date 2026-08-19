import { AutoClassMapper, AutoEntityChangeMapper, BaseMapper, createMapperHandlers } from '../../../common';
import * as Entities from '../../../entities';
import * as Models from '../../../models';

// `_version` is owned by the database and the only legitimate writer is
// `Repository.updateWithVersion`. Strip it from every write path here so the
// auto-mappers cannot leak it into a Prisma update. This model IS OCC-written
// (its update route carries `@RequiresIfMatch()` + `@ExpectedVersion()`,
// rule 05), so this guard is required, not optional.
const FIELDS_NOT_WRITABLE: string[] = ['version'];

function stripNonWritableFields<T extends object>(model: T, fields: string[]): T {
  for (const field of fields) {
    delete (model as Record<string, unknown>)[field];
  }
  return model;
}

export class WorkflowAssignmentEntityMapper extends BaseMapper<Entities.WorkflowAssignmentEntity, Models.WorkflowAssignment> {
  constructor() {
    super();
  }

  public toPersistence(entity: Entities.WorkflowAssignmentEntity): Models.WorkflowAssignment {
    const result = AutoClassMapper(entity, Models.WorkflowAssignment, WorkflowAssignmentEntityMapperHandlers.$toPersistence);
    return stripNonWritableFields(result, FIELDS_NOT_WRITABLE);
  }

  public toPersistenceChanges(entity: Entities.WorkflowAssignmentEntity): Partial<Models.WorkflowAssignment> {
    const result = AutoEntityChangeMapper(entity, Models.WorkflowAssignment, WorkflowAssignmentEntityMapperHandlers.$toPersistence);
    return stripNonWritableFields(result, FIELDS_NOT_WRITABLE);
  }

  public toDomainEntity(dataModel: Models.WorkflowAssignment): Entities.WorkflowAssignmentEntity {
    return AutoClassMapper(dataModel, Entities.WorkflowAssignmentEntity, WorkflowAssignmentEntityMapperHandlers.$toDomain);
  }
}

export const WorkflowAssignmentEntityMapperHandlers = createMapperHandlers<Entities.WorkflowAssignmentEntity, Models.WorkflowAssignment>({
  $toPersistence: {},
  $toDomain: {},
});
