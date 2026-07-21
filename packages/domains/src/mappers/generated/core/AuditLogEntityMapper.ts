import { AutoClassMapper, AutoEntityChangeMapper, BaseMapper, createMapperHandlers } from '../../../common';
import * as Entities from '../../../entities';
import * as Models from '../../../models';
import * as Mappers from '../../../mappers';

export class AuditLogEntityMapper extends BaseMapper<Entities.AuditLogEntity, Models.AuditLog> {
  constructor() {
    super();
  }

  public toPersistence(entity: Entities.AuditLogEntity): Models.AuditLog {
    return AutoClassMapper(entity, Models.AuditLog, AuditLogEntityMapperHandlers.$toPersistence);
  }

  public toPersistenceChanges(entity: Entities.AuditLogEntity): Partial<Models.AuditLog> {
    return AutoEntityChangeMapper(entity, Models.AuditLog, AuditLogEntityMapperHandlers.$toPersistence);
  }

  public toDomainEntity(dataModel: Models.AuditLog): Entities.AuditLogEntity {
    return AutoClassMapper(dataModel, Entities.AuditLogEntity, AuditLogEntityMapperHandlers.$toDomain);
  }
}

export const AuditLogEntityMapperHandlers = createMapperHandlers<Entities.AuditLogEntity, Models.AuditLog>({
  $toPersistence: {
    // Bypass the generic auto-mapper for binary ciphertext.
    // BaseEntity.toObject() walks Object.keys on objects, destructively turning a
    // Buffer/Uint8Array into a plain `{0: byte, …}` map (losing the typed-array
    // constructor). Returning the underlying buffer directly preserves it for the
    // Prisma Bytes write path.
    encryptedData: (entity) => entity.encryptedData ?? null,
    encryptedPreviousData: (entity) => entity.encryptedPreviousData ?? null,
  },
  $toDomain: {
    encryptedData: (model) => model.encryptedData ?? null,
    encryptedPreviousData: (model) => model.encryptedPreviousData ?? null,
  },
});
