import { AutoClassMapper, AutoEntityChangeMapper, BaseMapper, createMapperHandlers } from '../../../common';
import * as Entities from '../../../entities';
import * as Models from '../../../models';

// `_version` is owned by the database and the only legitimate writer is
// `Repository.updateWithVersion`. Strip it from every write path here so the
// auto-mappers cannot leak it into a Prisma update. Mirrors the
// `AiTaskDefaultEntityMapper` / `DepartmentEntityMapper` treatment.
//
// NOTE — `policyVersion` is deliberately NOT in this list. It is the AUTHORED,
// supersede-only revision (a real column a human writes, and
// stripping it would make a new revision unsavable. Only the OCC counter is
// non-writable.
const FIELDS_NOT_WRITABLE: string[] = ['version'];

function stripNonWritableFields<T extends object>(model: T, fields: string[]): T {
  for (const field of fields) {
    delete (model as Record<string, unknown>)[field];
  }
  return model;
}

export class AiRoutingPolicyEntityMapper extends BaseMapper<Entities.AiRoutingPolicyEntity, Models.AiRoutingPolicy> {
  constructor() {
    super();
  }

  public toPersistence(entity: Entities.AiRoutingPolicyEntity): Models.AiRoutingPolicy {
    const result = AutoClassMapper(entity, Models.AiRoutingPolicy, AiRoutingPolicyEntityMapperHandlers.$toPersistence);
    return stripNonWritableFields(result, FIELDS_NOT_WRITABLE);
  }

  public toPersistenceChanges(entity: Entities.AiRoutingPolicyEntity): Partial<Models.AiRoutingPolicy> {
    const result = AutoEntityChangeMapper(entity, Models.AiRoutingPolicy, AiRoutingPolicyEntityMapperHandlers.$toPersistence);
    return stripNonWritableFields(result, FIELDS_NOT_WRITABLE);
  }

  public toDomainEntity(dataModel: Models.AiRoutingPolicy): Entities.AiRoutingPolicyEntity {
    return AutoClassMapper(dataModel, Entities.AiRoutingPolicyEntity, AiRoutingPolicyEntityMapperHandlers.$toDomain);
  }
}

export const AiRoutingPolicyEntityMapperHandlers = createMapperHandlers<Entities.AiRoutingPolicyEntity, Models.AiRoutingPolicy>({
  $toPersistence: {},
  $toDomain: {},
});
