import { AutoClassMapper, AutoEntityChangeMapper, BaseMapper, createMapperHandlers } from '../../../common';
import * as Entities from '../../../entities';
import * as Models from '../../../models';
import * as Mappers from '../../../mappers';

/**
 * The `PipelinePolicyChange` table is append-only (WORM) and intentionally has
 * NO `_metadata` / `_version` / `createdBy` / `updatedBy` / `updatedAt` /
 * `resourceStatus*` columns. The base entity/model carry those inherited
 * fields, so we strip them before persistence to avoid "Unknown argument"
 * Prisma errors. Only `id`, `tenantId`, `createdAt` and the business columns
 * are written. Mirrors `HarnessPolicyChangeEntityMapper`.
 */
function stripNonPersistedFields<T>(model: T): T {
  const raw = model as unknown as Record<string, unknown>;
  delete raw.metaData;
  delete raw.version;
  delete raw.createdBy;
  delete raw.updatedBy;
  delete raw.updatedAt;
  delete raw.resourceStatus;
  delete raw.resourceStatusUpdatedAt;
  delete raw.resourceStatusUpdatedBy;
  return model;
}

/** @deprecated TASK-861 — removed in R4 with `PipelinePolicy` (WORM log stays read-only until the drop). */
export class PipelinePolicyChangeEntityMapper extends BaseMapper<Entities.PipelinePolicyChangeEntity, Models.PipelinePolicyChange> {
  constructor() {
    super();
  }

  public toPersistence(entity: Entities.PipelinePolicyChangeEntity): Models.PipelinePolicyChange {
    const model = AutoClassMapper(entity, Models.PipelinePolicyChange, PipelinePolicyChangeEntityMapperHandlers.$toPersistence);
    return stripNonPersistedFields(model);
  }

  public toPersistenceChanges(entity: Entities.PipelinePolicyChangeEntity): Partial<Models.PipelinePolicyChange> {
    const model = AutoEntityChangeMapper(entity, Models.PipelinePolicyChange, PipelinePolicyChangeEntityMapperHandlers.$toPersistence);
    return stripNonPersistedFields(model);
  }

  public toDomainEntity(dataModel: Models.PipelinePolicyChange): Entities.PipelinePolicyChangeEntity {
    return AutoClassMapper(dataModel, Entities.PipelinePolicyChangeEntity, PipelinePolicyChangeEntityMapperHandlers.$toDomain);
  }
}

export const PipelinePolicyChangeEntityMapperHandlers = createMapperHandlers<Entities.PipelinePolicyChangeEntity, Models.PipelinePolicyChange>({
  $toPersistence: {
    // Preserve the raw Buffer for the Prisma Bytes write path
    // (the generic auto-mapper would destructure a typed array into a byte map).
    encryptedBeforeJson: (entity) => entity.encryptedBeforeJson ?? null,
    encryptedAfterJson: (entity) => entity.encryptedAfterJson ?? null,
  },
  $toDomain: {
    encryptedBeforeJson: (model) => model.encryptedBeforeJson ?? null,
    encryptedAfterJson: (model) => model.encryptedAfterJson ?? null,
  },
});
