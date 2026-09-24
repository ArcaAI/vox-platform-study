import { AutoClassMapper, AutoEntityChangeMapper, BaseMapper, createMapperHandlers } from '../../../common';
import * as Entities from '../../../entities';
import * as Models from '../../../models';

// `_version` is owned by the database and the only legitimate writer is
// `Repository.updateWithVersion`. Strip it from every write path here so the
// auto-mappers cannot leak it into a Prisma update — this model is
// OCC-written (versioned PATCH routes on the admin residency-policy surface),
// mirroring `AiRoutingPolicyEntityMapper` / `DepartmentEntityMapper`.
const FIELDS_NOT_WRITABLE: string[] = ['version'];

function stripNonWritableFields<T extends object>(model: T, fields: string[]): T {
  for (const field of fields) {
    delete (model as Record<string, unknown>)[field];
  }
  return model;
}

export class ModelResidencyPolicyEntityMapper extends BaseMapper<Entities.ModelResidencyPolicyEntity, Models.ModelResidencyPolicy> {
  constructor() {
    super();
  }

  public toPersistence(entity: Entities.ModelResidencyPolicyEntity): Models.ModelResidencyPolicy {
    const result = AutoClassMapper(entity, Models.ModelResidencyPolicy, ModelResidencyPolicyEntityMapperHandlers.$toPersistence);
    return stripNonWritableFields(result, FIELDS_NOT_WRITABLE);
  }

  public toPersistenceChanges(entity: Entities.ModelResidencyPolicyEntity): Partial<Models.ModelResidencyPolicy> {
    const result = AutoEntityChangeMapper(entity, Models.ModelResidencyPolicy, ModelResidencyPolicyEntityMapperHandlers.$toPersistence);
    return stripNonWritableFields(result, FIELDS_NOT_WRITABLE);
  }

  public toDomainEntity(dataModel: Models.ModelResidencyPolicy): Entities.ModelResidencyPolicyEntity {
    return AutoClassMapper(dataModel, Entities.ModelResidencyPolicyEntity, ModelResidencyPolicyEntityMapperHandlers.$toDomain);
  }
}

export const ModelResidencyPolicyEntityMapperHandlers = createMapperHandlers<Entities.ModelResidencyPolicyEntity, Models.ModelResidencyPolicy>({
  $toPersistence: {},
  $toDomain: {},
});
