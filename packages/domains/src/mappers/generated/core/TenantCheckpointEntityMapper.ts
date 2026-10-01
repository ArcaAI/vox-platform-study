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

export class TenantCheckpointEntityMapper extends BaseMapper<Entities.TenantCheckpointEntity, Models.TenantCheckpoint> {
  constructor() {
    super();
  }

  public toPersistence(entity: Entities.TenantCheckpointEntity): Models.TenantCheckpoint {
    const result = AutoClassMapper(entity, Models.TenantCheckpoint, TenantCheckpointEntityMapperHandlers.$toPersistence);
    return stripNonWritableFields(result, FIELDS_NOT_WRITABLE);
  }

  public toPersistenceChanges(entity: Entities.TenantCheckpointEntity): Partial<Models.TenantCheckpoint> {
    const result = AutoEntityChangeMapper(entity, Models.TenantCheckpoint, TenantCheckpointEntityMapperHandlers.$toPersistence);
    return stripNonWritableFields(result, FIELDS_NOT_WRITABLE);
  }

  public toDomainEntity(dataModel: Models.TenantCheckpoint): Entities.TenantCheckpointEntity {
    return AutoClassMapper(dataModel, Entities.TenantCheckpointEntity, TenantCheckpointEntityMapperHandlers.$toDomain);
  }
}

export const TenantCheckpointEntityMapperHandlers = createMapperHandlers<Entities.TenantCheckpointEntity, Models.TenantCheckpoint>({
  // sizeBytes is a bigint column; the entity exposes a plain number (safe below 2^53).
  $toPersistence: {
    sizeBytes: (entity) => (entity.sizeBytes == null ? null : BigInt(entity.sizeBytes)),
  },
  $toDomain: {
    sizeBytes: (model) => (model.sizeBytes == null ? null : Number(model.sizeBytes)),
  },
});
