import { AutoClassMapper, AutoEntityChangeMapper, BaseMapper, createMapperHandlers } from '../../../common';
import * as Entities from '../../../entities';
import * as Models from '../../../models';
import * as Mappers from '../../../mappers';

// TASK-302 Stream D Phase E.1.1 — `_version` is owned by the database and the
// only legitimate writer is `Repository.updateWithVersion`. Strip it from every
// write path here so the auto-mappers cannot leak it into a Prisma update.
// Mirrors the B.6 treatment on `GlobalSettingEntityMapper`.
const FIELDS_NOT_WRITABLE: string[] = ['version'];

function stripNonWritableFields<T extends object>(model: T, fields: string[]): T {
  for (const field of fields) {
    delete (model as Record<string, unknown>)[field];
  }
  return model;
}

export class TenantEntityMapper extends BaseMapper<Entities.TenantEntity, Models.Tenant> {
  constructor() {
    super();
  }

  public toPersistence(entity: Entities.TenantEntity): Models.Tenant {
    const result = AutoClassMapper(entity, Models.Tenant, TenantEntityMapperHandlers.$toPersistence);
    return stripNonWritableFields(result, FIELDS_NOT_WRITABLE);
  }

  public toPersistenceChanges(entity: Entities.TenantEntity): Partial<Models.Tenant> {
    const result = AutoEntityChangeMapper(entity, Models.Tenant, TenantEntityMapperHandlers.$toPersistence);
    return stripNonWritableFields(result, FIELDS_NOT_WRITABLE);
  }

  public toDomainEntity(dataModel: Models.Tenant): Entities.TenantEntity {
    return AutoClassMapper(dataModel, Entities.TenantEntity, TenantEntityMapperHandlers.$toDomain);
  }
}

export const TenantEntityMapperHandlers = createMapperHandlers<Entities.TenantEntity, Models.Tenant>({
  $toPersistence: {},
  $toDomain: {},
});
