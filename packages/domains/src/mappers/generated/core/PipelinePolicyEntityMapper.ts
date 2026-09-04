import { AutoClassMapper, AutoEntityChangeMapper, BaseMapper, createMapperHandlers } from '../../../common';
import * as Entities from '../../../entities';
import * as Models from '../../../models';
import * as Mappers from '../../../mappers';

// `PipelinePolicy` is OCC-WRITTEN (`pipeline-policy.service.ts:206,338` call
// `repository.updateWithVersion`), so `03-domain-layer.md` makes this strip mandatory: `_version`
// is owned by the database and its only legitimate writer is `Repository.updateWithVersion`.
// `updateWithVersion` also destructures `version` out defensively, but its own comment calls that
// "defense in depth ON TOP OF the mapper `$toPersistence` handler" — this is the layer it names.
// Mirrors the `AiTaskDefaultEntityMapper` / `DepartmentEntityMapper` treatment.
const FIELDS_NOT_WRITABLE: string[] = ['version'];

function stripNonWritableFields<T extends object>(model: T, fields: string[]): T {
  for (const field of fields) {
    delete (model as Record<string, unknown>)[field];
  }
  return model;
}

/** @deprecated TASK-861 — removed in R4. Its toggles become `enabled` flags on the nodes of the assigned workflow (`WorkflowAssignment`, TASK-864). */
export class PipelinePolicyEntityMapper extends BaseMapper<Entities.PipelinePolicyEntity, Models.PipelinePolicy> {
  constructor() {
    super();
  }

  public toPersistence(entity: Entities.PipelinePolicyEntity): Models.PipelinePolicy {
    const result = AutoClassMapper(entity, Models.PipelinePolicy, PipelinePolicyEntityMapperHandlers.$toPersistence);
    return stripNonWritableFields(result, FIELDS_NOT_WRITABLE);
  }

  public toPersistenceChanges(entity: Entities.PipelinePolicyEntity): Partial<Models.PipelinePolicy> {
    const result = AutoEntityChangeMapper(entity, Models.PipelinePolicy, PipelinePolicyEntityMapperHandlers.$toPersistence);
    return stripNonWritableFields(result, FIELDS_NOT_WRITABLE);
  }

  public toDomainEntity(dataModel: Models.PipelinePolicy): Entities.PipelinePolicyEntity {
    return AutoClassMapper(dataModel, Entities.PipelinePolicyEntity, PipelinePolicyEntityMapperHandlers.$toDomain);
  }
}

export const PipelinePolicyEntityMapperHandlers = createMapperHandlers<Entities.PipelinePolicyEntity, Models.PipelinePolicy>({
  $toPersistence: {},
  $toDomain: {},
});
