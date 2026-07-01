import { AutoClassMapper, AutoEntityChangeMapper, BaseMapper, createMapperHandlers } from '../../../common';
import * as Entities from '../../../entities';
import * as Models from '../../../models';
import * as Mappers from '../../../mappers';

// `_version` is owned by the database and the only legitimate writer is
// `Repository.updateWithVersion`. Strip it from every write path here so the
// auto-mappers cannot leak it into a Prisma update. Mirrors the
// `TenantFrontendConfigEntityMapper` treatment.
const FIELDS_NOT_WRITABLE: string[] = ['version'];

function stripNonWritableFields<T extends object>(model: T, fields: string[]): T {
  for (const field of fields) {
    delete (model as Record<string, unknown>)[field];
  }
  return model;
}

export class PlanEntitlementEntityMapper extends BaseMapper<Entities.PlanEntitlementEntity, Models.PlanEntitlement> {
  constructor() {
    super();
  }

  public toPersistence(entity: Entities.PlanEntitlementEntity): Models.PlanEntitlement {
    const result = AutoClassMapper(entity, Models.PlanEntitlement, PlanEntitlementEntityMapperHandlers.$toPersistence);
    return stripNonWritableFields(result, FIELDS_NOT_WRITABLE);
  }

  public toPersistenceChanges(entity: Entities.PlanEntitlementEntity): Partial<Models.PlanEntitlement> {
    const result = AutoEntityChangeMapper(entity, Models.PlanEntitlement, PlanEntitlementEntityMapperHandlers.$toPersistence);
    return stripNonWritableFields(result, FIELDS_NOT_WRITABLE);
  }

  public toDomainEntity(dataModel: Models.PlanEntitlement): Entities.PlanEntitlementEntity {
    return AutoClassMapper(dataModel, Entities.PlanEntitlementEntity, PlanEntitlementEntityMapperHandlers.$toDomain);
  }
}

export const PlanEntitlementEntityMapperHandlers = createMapperHandlers<Entities.PlanEntitlementEntity, Models.PlanEntitlement>({
  $toPersistence: {},
  $toDomain: {},
});
