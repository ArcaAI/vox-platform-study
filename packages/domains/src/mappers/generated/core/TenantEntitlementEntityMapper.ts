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

export class TenantEntitlementEntityMapper extends BaseMapper<Entities.TenantEntitlementEntity, Models.TenantEntitlement> {
  constructor() {
    super();
  }

  public toPersistence(entity: Entities.TenantEntitlementEntity): Models.TenantEntitlement {
    const result = AutoClassMapper(entity, Models.TenantEntitlement, TenantEntitlementEntityMapperHandlers.$toPersistence);
    return stripNonWritableFields(result, FIELDS_NOT_WRITABLE);
  }

  public toPersistenceChanges(entity: Entities.TenantEntitlementEntity): Partial<Models.TenantEntitlement> {
    const result = AutoEntityChangeMapper(entity, Models.TenantEntitlement, TenantEntitlementEntityMapperHandlers.$toPersistence);
    return stripNonWritableFields(result, FIELDS_NOT_WRITABLE);
  }

  public toDomainEntity(dataModel: Models.TenantEntitlement): Entities.TenantEntitlementEntity {
    return AutoClassMapper(dataModel, Entities.TenantEntitlementEntity, TenantEntitlementEntityMapperHandlers.$toDomain);
  }
}

export const TenantEntitlementEntityMapperHandlers = createMapperHandlers<Entities.TenantEntitlementEntity, Models.TenantEntitlement>({
  $toPersistence: {},
  $toDomain: {},
});
