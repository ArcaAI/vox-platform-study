import { AutoClassMapper, AutoEntityChangeMapper, BaseMapper, createMapperHandlers } from '../../../common';
import * as Entities from '../../../entities';
import * as Models from '../../../models';
import * as Mappers from '../../../mappers';

/**
 * The `HarnessAuditEvent` table is append-only (WORM) and intentionally has NO
 * `_metadata` / `_version` / `createdBy` / `updatedBy` / `updatedAt` /
 * `resourceStatus*` columns. The base entity/model carry those inherited
 * fields, so we strip them before persistence to avoid "Unknown argument"
 * Prisma errors. Only `id`, `tenantId`, `createdAt` and the business columns
 * are written. Mirrors `ContextItemVersionEntityMapper`.
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

export class HarnessAuditEventEntityMapper extends BaseMapper<Entities.HarnessAuditEventEntity, Models.HarnessAuditEvent> {
  constructor() {
    super();
  }

  public toPersistence(entity: Entities.HarnessAuditEventEntity): Models.HarnessAuditEvent {
    const model = AutoClassMapper(entity, Models.HarnessAuditEvent, HarnessAuditEventEntityMapperHandlers.$toPersistence);
    return stripNonPersistedFields(model);
  }

  public toPersistenceChanges(entity: Entities.HarnessAuditEventEntity): Partial<Models.HarnessAuditEvent> {
    const model = AutoEntityChangeMapper(entity, Models.HarnessAuditEvent, HarnessAuditEventEntityMapperHandlers.$toPersistence);
    return stripNonPersistedFields(model);
  }

  public toDomainEntity(dataModel: Models.HarnessAuditEvent): Entities.HarnessAuditEventEntity {
    return AutoClassMapper(dataModel, Entities.HarnessAuditEventEntity, HarnessAuditEventEntityMapperHandlers.$toDomain);
  }
}

export const HarnessAuditEventEntityMapperHandlers = createMapperHandlers<
  Entities.HarnessAuditEventEntity,
  Models.HarnessAuditEvent
>({
  $toPersistence: {
    // TASK-369 Phase 3D — bypass the generic auto-mapper for binary ciphertext.
    // BaseEntity.toObject() walks Object.keys on objects, destructively turning a
    // Buffer/Uint8Array into a plain `{0: byte, …}` map (losing the typed-array
    // constructor). Returning the underlying buffer directly preserves it for the
    // Prisma Bytes write path.
    encryptedSensorScores: (entity) => entity.encryptedSensorScores ?? null,
    encryptedCitations: (entity) => entity.encryptedCitations ?? null,
  },
  $toDomain: {
    encryptedSensorScores: (model) => model.encryptedSensorScores ?? null,
    encryptedCitations: (model) => model.encryptedCitations ?? null,
  },
});
