import { AutoClassMapper, AutoEntityChangeMapper, BaseMapper, createMapperHandlers } from '../../../common';
import * as Entities from '../../../entities';
import * as Models from '../../../models';
import * as Mappers from '../../../mappers';

// TASK-816 D-23 — `HarnessPolicy` is OCC-WRITTEN (`harness-policy.service.ts` calls
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

export class HarnessPolicyEntityMapper extends BaseMapper<Entities.HarnessPolicyEntity, Models.HarnessPolicy> {
  constructor() {
    super();
  }

  public toPersistence(entity: Entities.HarnessPolicyEntity): Models.HarnessPolicy {
    const result = AutoClassMapper(entity, Models.HarnessPolicy, HarnessPolicyEntityMapperHandlers.$toPersistence);
    return stripNonWritableFields(result, FIELDS_NOT_WRITABLE);
  }

  public toPersistenceChanges(entity: Entities.HarnessPolicyEntity): Partial<Models.HarnessPolicy> {
    const result = AutoEntityChangeMapper(entity, Models.HarnessPolicy, HarnessPolicyEntityMapperHandlers.$toPersistence);
    return stripNonWritableFields(result, FIELDS_NOT_WRITABLE);
  }

  public toDomainEntity(dataModel: Models.HarnessPolicy): Entities.HarnessPolicyEntity {
    return AutoClassMapper(dataModel, Entities.HarnessPolicyEntity, HarnessPolicyEntityMapperHandlers.$toDomain);
  }
}

export const HarnessPolicyEntityMapperHandlers = createMapperHandlers<Entities.HarnessPolicyEntity, Models.HarnessPolicy>({
  $toPersistence: {},
  $toDomain: {},
});
