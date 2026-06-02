import { AutoClassMapper, AutoEntityChangeMapper, BaseMapper, createMapperHandlers } from '../../../common';
import * as Entities from '../../../entities';
import * as Models from '../../../models';
import * as Mappers from '../../../mappers';

// `_version` is owned by the database and the only legitimate writer is
// `Repository.updateWithVersion`. Strip it from every write path here so the
// auto-mappers cannot leak it into a Prisma update. Mirrors the
// `DepartmentEntityMapper` treatment.
const FIELDS_NOT_WRITABLE: string[] = ['version'];

function stripNonWritableFields<T extends object>(model: T, fields: string[]): T {
  for (const field of fields) {
    delete (model as Record<string, unknown>)[field];
  }
  return model;
}

export class TenantFrontendConfigEntityMapper extends BaseMapper<Entities.TenantFrontendConfigEntity, Models.TenantFrontendConfig> {
  constructor() {
    super();
  }

  public toPersistence(entity: Entities.TenantFrontendConfigEntity): Models.TenantFrontendConfig {
    const result = AutoClassMapper(entity, Models.TenantFrontendConfig, TenantFrontendConfigEntityMapperHandlers.$toPersistence);
    return stripNonWritableFields(result, FIELDS_NOT_WRITABLE);
  }

  public toPersistenceChanges(entity: Entities.TenantFrontendConfigEntity): Partial<Models.TenantFrontendConfig> {
    const result = AutoEntityChangeMapper(entity, Models.TenantFrontendConfig, TenantFrontendConfigEntityMapperHandlers.$toPersistence);
    return stripNonWritableFields(result, FIELDS_NOT_WRITABLE);
  }

  public toDomainEntity(dataModel: Models.TenantFrontendConfig): Entities.TenantFrontendConfigEntity {
    return AutoClassMapper(dataModel, Entities.TenantFrontendConfigEntity, TenantFrontendConfigEntityMapperHandlers.$toDomain);
  }
}

export const TenantFrontendConfigEntityMapperHandlers = createMapperHandlers<Entities.TenantFrontendConfigEntity, Models.TenantFrontendConfig>({
  $toPersistence: {},
  $toDomain: {},
});
