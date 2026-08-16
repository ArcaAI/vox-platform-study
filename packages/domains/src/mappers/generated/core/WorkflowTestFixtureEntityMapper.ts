import { AutoClassMapper, AutoEntityChangeMapper, BaseMapper, createMapperHandlers } from '../../../common';
import * as Entities from '../../../entities';
import * as Models from '../../../models';

// `_version` is owned by the database and the only legitimate writer is
// `Repository.updateWithVersion`. Strip it from every write path here so the
// auto-mappers cannot leak it into a Prisma update. Mirrors the
// `AiTaskDefaultEntityMapper`/`DepartmentEntityMapper` treatment. This model
// IS OCC-written (its update route carries `@RequiresIfMatch()` +
// `@ExpectedVersion()`, rule 05), so this guard is required, not optional.
const FIELDS_NOT_WRITABLE: string[] = ['version'];

function stripNonWritableFields<T extends object>(model: T, fields: string[]): T {
  for (const field of fields) {
    delete (model as Record<string, unknown>)[field];
  }
  return model;
}

export class WorkflowTestFixtureEntityMapper extends BaseMapper<Entities.WorkflowTestFixtureEntity, Models.WorkflowTestFixture> {
  constructor() {
    super();
  }

  public toPersistence(entity: Entities.WorkflowTestFixtureEntity): Models.WorkflowTestFixture {
    const result = AutoClassMapper(entity, Models.WorkflowTestFixture, WorkflowTestFixtureEntityMapperHandlers.$toPersistence);
    return stripNonWritableFields(result, FIELDS_NOT_WRITABLE);
  }

  public toPersistenceChanges(entity: Entities.WorkflowTestFixtureEntity): Partial<Models.WorkflowTestFixture> {
    const result = AutoEntityChangeMapper(entity, Models.WorkflowTestFixture, WorkflowTestFixtureEntityMapperHandlers.$toPersistence);
    return stripNonWritableFields(result, FIELDS_NOT_WRITABLE);
  }

  public toDomainEntity(dataModel: Models.WorkflowTestFixture): Entities.WorkflowTestFixtureEntity {
    return AutoClassMapper(dataModel, Entities.WorkflowTestFixtureEntity, WorkflowTestFixtureEntityMapperHandlers.$toDomain);
  }
}

export const WorkflowTestFixtureEntityMapperHandlers = createMapperHandlers<Entities.WorkflowTestFixtureEntity, Models.WorkflowTestFixture>({
  $toPersistence: {},
  $toDomain: {},
});
