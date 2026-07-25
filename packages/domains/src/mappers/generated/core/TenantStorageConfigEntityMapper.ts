import { AutoClassMapper, AutoEntityChangeMapper, BaseMapper, createMapperHandlers } from '../../../common';
import * as Entities from '../../../entities';
import * as Models from '../../../models';

// `_version` is owned by the database and the only legitimate writer is
// `Repository.updateWithVersion`. `TenantStorageConfig` became OCC-written when
// the SYSTEM-tenant platform-default row gained an `If-Match` PUT route, so the
// strip is required here for the same reason it exists on
// `DepartmentEntityMapper` / `GlobalSettingEntityMapper`: without it the
// auto-mappers leak `version` into a Prisma update and silently defeat
// optimistic concurrency.
const FIELDS_NOT_WRITABLE: string[] = ['version'];

function stripNonWritableFields<T extends object>(model: T, fields: string[]): T {
  for (const field of fields) {
    delete (model as Record<string, unknown>)[field];
  }
  return model;
}

export class TenantStorageConfigEntityMapper extends BaseMapper<Entities.TenantStorageConfigEntity, Models.TenantStorageConfig> {
  constructor() {
    super();
  }

  public toPersistence(entity: Entities.TenantStorageConfigEntity): Models.TenantStorageConfig {
    const result = AutoClassMapper(entity, Models.TenantStorageConfig, TenantStorageConfigEntityMapperHandlers.$toPersistence);
    return stripNonWritableFields(result, FIELDS_NOT_WRITABLE);
  }

  public toPersistenceChanges(entity: Entities.TenantStorageConfigEntity): Partial<Models.TenantStorageConfig> {
    const result = AutoEntityChangeMapper(entity, Models.TenantStorageConfig, TenantStorageConfigEntityMapperHandlers.$toPersistence);
    return stripNonWritableFields(result, FIELDS_NOT_WRITABLE);
  }

  public toDomainEntity(dataModel: Models.TenantStorageConfig): Entities.TenantStorageConfigEntity {
    return AutoClassMapper(dataModel, Entities.TenantStorageConfigEntity, TenantStorageConfigEntityMapperHandlers.$toDomain);
  }
}

export const TenantStorageConfigEntityMapperHandlers = createMapperHandlers<Entities.TenantStorageConfigEntity, Models.TenantStorageConfig>({
  $toPersistence: {},
  $toDomain: {},
});
