import { AutoClassMapper, AutoEntityChangeMapper, BaseMapper, createMapperHandlers } from '../../../common';
import * as Entities from '../../../entities';
import * as Models from '../../../models';

// `_version` is owned by the database; only `Repository.updateWithVersion`
// writes it. Strip it from every write path so the auto-mappers cannot leak it
// into a Prisma update.
const FIELDS_NOT_WRITABLE: string[] = ['version'];

function stripNonWritableFields<T extends object>(model: T, fields: string[]): T {
  for (const field of fields) {
    delete (model as Record<string, unknown>)[field];
  }
  return model;
}

export class TenantCheckpointRestoreEntityMapper extends BaseMapper<Entities.TenantCheckpointRestoreEntity, Models.TenantCheckpointRestore> {
  constructor() {
    super();
  }

  public toPersistence(entity: Entities.TenantCheckpointRestoreEntity): Models.TenantCheckpointRestore {
    const result = AutoClassMapper(entity, Models.TenantCheckpointRestore, TenantCheckpointRestoreEntityMapperHandlers.$toPersistence);
    return stripNonWritableFields(result, FIELDS_NOT_WRITABLE);
  }

  public toPersistenceChanges(entity: Entities.TenantCheckpointRestoreEntity): Partial<Models.TenantCheckpointRestore> {
    const result = AutoEntityChangeMapper(entity, Models.TenantCheckpointRestore, TenantCheckpointRestoreEntityMapperHandlers.$toPersistence);
    return stripNonWritableFields(result, FIELDS_NOT_WRITABLE);
  }

  public toDomainEntity(dataModel: Models.TenantCheckpointRestore): Entities.TenantCheckpointRestoreEntity {
    return AutoClassMapper(dataModel, Entities.TenantCheckpointRestoreEntity, TenantCheckpointRestoreEntityMapperHandlers.$toDomain);
  }
}

export const TenantCheckpointRestoreEntityMapperHandlers = createMapperHandlers<Entities.TenantCheckpointRestoreEntity, Models.TenantCheckpointRestore>({
  $toPersistence: {},
  $toDomain: {},
});
