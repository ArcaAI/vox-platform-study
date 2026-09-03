import { AutoClassMapper, AutoEntityChangeMapper, BaseMapper, createMapperHandlers } from '../../../common';
import * as Entities from '../../../entities';
import * as Models from '../../../models';

// `_version` is owned by the database and the only legitimate writer is
// `Repository.updateWithVersion`. `WorkflowInvariantRule` IS OCC-written (the
// rule-set admin PATCH route carries If-Match —), so the strip
// is load-bearing: without it the auto-mappers leak `version` into a Prisma
// update and every compare-and-set silently stops meaning anything. Mirrors
// `WorkflowDefinitionEntityMapper` / `AiTaskDefaultEntityMapper`.
const FIELDS_NOT_WRITABLE: string[] = ['version'];

function stripNonWritableFields<T extends object>(model: T, fields: string[]): T {
  for (const field of fields) {
    delete (model as Record<string, unknown>)[field];
  }
  return model;
}

export class WorkflowInvariantRuleEntityMapper extends BaseMapper<Entities.WorkflowInvariantRuleEntity, Models.WorkflowInvariantRule> {
  constructor() {
    super();
  }

  public toPersistence(entity: Entities.WorkflowInvariantRuleEntity): Models.WorkflowInvariantRule {
    const result = AutoClassMapper(entity, Models.WorkflowInvariantRule, WorkflowInvariantRuleEntityMapperHandlers.$toPersistence);
    return stripNonWritableFields(result, FIELDS_NOT_WRITABLE);
  }

  public toPersistenceChanges(entity: Entities.WorkflowInvariantRuleEntity): Partial<Models.WorkflowInvariantRule> {
    const result = AutoEntityChangeMapper(entity, Models.WorkflowInvariantRule, WorkflowInvariantRuleEntityMapperHandlers.$toPersistence);
    return stripNonWritableFields(result, FIELDS_NOT_WRITABLE);
  }

  public toDomainEntity(dataModel: Models.WorkflowInvariantRule): Entities.WorkflowInvariantRuleEntity {
    return AutoClassMapper(dataModel, Entities.WorkflowInvariantRuleEntity, WorkflowInvariantRuleEntityMapperHandlers.$toDomain);
  }
}

export const WorkflowInvariantRuleEntityMapperHandlers = createMapperHandlers<
  Entities.WorkflowInvariantRuleEntity,
  Models.WorkflowInvariantRule
>({
  $toPersistence: {},
  $toDomain: {},
});
