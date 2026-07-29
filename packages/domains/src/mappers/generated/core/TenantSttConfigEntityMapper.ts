import { AutoClassMapper, AutoEntityChangeMapper, BaseMapper, createMapperHandlers } from '../../../common';
import * as Entities from '../../../entities';
import * as Models from '../../../models';

// HAND-AUTHORED (the `gen:mapper` generator crashes pre-existingly, stripping
// this very guard before it dies; see the AiProviderConnectionEntityMapper /
// AiTaskDefaultEntityMapper precedents in this folder).
//
// `_version` is owned by the database and the only legitimate writer is
// `Repository.updateWithVersion`. Strip it from every write path here so the
// auto-mappers cannot leak it into a Prisma update. TenantSttConfig IS
// OCC-written (versioned PUT routes).
const FIELDS_NOT_WRITABLE: string[] = ['version'];

function stripNonWritableFields<T extends object>(model: T, fields: string[]): T {
  for (const field of fields) delete (model as Record<string, unknown>)[field];
  return model;
}

export class TenantSttConfigEntityMapper extends BaseMapper<Entities.TenantSttConfigEntity, Models.TenantSttConfig> {
  constructor() {
    super();
  }

  public toPersistence(entity: Entities.TenantSttConfigEntity): Models.TenantSttConfig {
    const result = AutoClassMapper(entity, Models.TenantSttConfig, TenantSttConfigEntityMapperHandlers.$toPersistence);
    return stripNonWritableFields(result, FIELDS_NOT_WRITABLE);
  }

  public toPersistenceChanges(entity: Entities.TenantSttConfigEntity): Partial<Models.TenantSttConfig> {
    const result = AutoEntityChangeMapper(entity, Models.TenantSttConfig, TenantSttConfigEntityMapperHandlers.$toPersistence);
    return stripNonWritableFields(result, FIELDS_NOT_WRITABLE);
  }

  public toDomainEntity(dataModel: Models.TenantSttConfig): Entities.TenantSttConfigEntity {
    return AutoClassMapper(dataModel, Entities.TenantSttConfigEntity, TenantSttConfigEntityMapperHandlers.$toDomain);
  }
}

export const TenantSttConfigEntityMapperHandlers = createMapperHandlers<Entities.TenantSttConfigEntity, Models.TenantSttConfig>({
  $toPersistence: {},
  $toDomain: {},
});
