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

export class TenantUsageMeterEntityMapper extends BaseMapper<Entities.TenantUsageMeterEntity, Models.TenantUsageMeter> {
  constructor() {
    super();
  }

  public toPersistence(entity: Entities.TenantUsageMeterEntity): Models.TenantUsageMeter {
    const result = AutoClassMapper(entity, Models.TenantUsageMeter, TenantUsageMeterEntityMapperHandlers.$toPersistence);
    return stripNonWritableFields(result, FIELDS_NOT_WRITABLE);
  }

  public toPersistenceChanges(entity: Entities.TenantUsageMeterEntity): Partial<Models.TenantUsageMeter> {
    const result = AutoEntityChangeMapper(entity, Models.TenantUsageMeter, TenantUsageMeterEntityMapperHandlers.$toPersistence);
    return stripNonWritableFields(result, FIELDS_NOT_WRITABLE);
  }

  public toDomainEntity(dataModel: Models.TenantUsageMeter): Entities.TenantUsageMeterEntity {
    return AutoClassMapper(dataModel, Entities.TenantUsageMeterEntity, TenantUsageMeterEntityMapperHandlers.$toDomain);
  }
}

export const TenantUsageMeterEntityMapperHandlers = createMapperHandlers<Entities.TenantUsageMeterEntity, Models.TenantUsageMeter>({
  $toPersistence: {},
  $toDomain: {},
});
