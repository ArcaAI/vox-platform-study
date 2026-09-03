import { AutoClassMapper, AutoEntityChangeMapper, BaseMapper, createMapperHandlers } from '../../../common';
import * as Entities from '../../../entities';
import * as Models from '../../../models';

// `_version` is owned by the database and the only legitimate writer is
// `Repository.updateWithVersion`. `WorkflowDefinition` IS OCC-written
// authoring PATCH routes carry If-Match against this row), so the strip is
// load-bearing: without it the auto-mappers leak `version` into a Prisma
// update and every compare-and-set silently stops meaning anything. Mirrors
// `AiTaskDefaultEntityMapper` / `ConsultationContextSchemaEntityMapper`.
const FIELDS_NOT_WRITABLE: string[] = ['version'];

function stripNonWritableFields<T extends object>(model: T, fields: string[]): T {
  for (const field of fields) {
    delete (model as Record<string, unknown>)[field];
  }
  return model;
}

export class WorkflowDefinitionEntityMapper extends BaseMapper<Entities.WorkflowDefinitionEntity, Models.WorkflowDefinition> {
  constructor() {
    super();
  }

  public toPersistence(entity: Entities.WorkflowDefinitionEntity): Models.WorkflowDefinition {
    const result = AutoClassMapper(entity, Models.WorkflowDefinition, WorkflowDefinitionEntityMapperHandlers.$toPersistence);
    return stripNonWritableFields(result, FIELDS_NOT_WRITABLE);
  }

  public toPersistenceChanges(entity: Entities.WorkflowDefinitionEntity): Partial<Models.WorkflowDefinition> {
    const result = AutoEntityChangeMapper(entity, Models.WorkflowDefinition, WorkflowDefinitionEntityMapperHandlers.$toPersistence);
    return stripNonWritableFields(result, FIELDS_NOT_WRITABLE);
  }

  public toDomainEntity(dataModel: Models.WorkflowDefinition): Entities.WorkflowDefinitionEntity {
    return AutoClassMapper(dataModel, Entities.WorkflowDefinitionEntity, WorkflowDefinitionEntityMapperHandlers.$toDomain);
  }
}

export const WorkflowDefinitionEntityMapperHandlers = createMapperHandlers<
  Entities.WorkflowDefinitionEntity,
  Models.WorkflowDefinition
>({
  $toPersistence: {},
  $toDomain: {},
});
