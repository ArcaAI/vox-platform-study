import { AutoClassMapper, AutoEntityChangeMapper, BaseMapper, createMapperHandlers } from '../../../common';
import * as Entities from '../../../entities';
import * as Models from '../../../models';
import * as Mappers from '../../../mappers';

// TASK-302 Stream D Phase B (B.6) — `_version` is owned by the database and the
// only legitimate writer is `Repository.updateWithVersion`. Strip it from every
// write path here so the auto-mappers cannot leak it into a Prisma update.
const FIELDS_NOT_WRITABLE: string[] = ['version'];

function stripNonWritableFields<T extends object>(model: T, fields: string[]): T {
  for (const field of fields) {
    delete (model as Record<string, unknown>)[field];
  }
  return model;
}

export class GlobalSettingEntityMapper extends BaseMapper<Entities.GlobalSettingEntity, Models.GlobalSetting> {
  constructor() {
    super();
  }

  public toPersistence(entity: Entities.GlobalSettingEntity): Models.GlobalSetting {
    const result = AutoClassMapper(entity, Models.GlobalSetting, GlobalSettingEntityMapperHandlers.$toPersistence);
    return stripNonWritableFields(result, FIELDS_NOT_WRITABLE);
  }

  public toPersistenceChanges(entity: Entities.GlobalSettingEntity): Partial<Models.GlobalSetting> {
    const result = AutoEntityChangeMapper(entity, Models.GlobalSetting, GlobalSettingEntityMapperHandlers.$toPersistence);
    return stripNonWritableFields(result, FIELDS_NOT_WRITABLE);
  }

  public toDomainEntity(dataModel: Models.GlobalSetting): Entities.GlobalSettingEntity {
    return AutoClassMapper(dataModel, Entities.GlobalSettingEntity, GlobalSettingEntityMapperHandlers.$toDomain);
  }
}

export const GlobalSettingEntityMapperHandlers = createMapperHandlers<Entities.GlobalSettingEntity, Models.GlobalSetting>({
  $toPersistence: {
    // TASK-302 Phase 4 — bypass the generic auto-mapper for binary ciphertext.
    // BaseEntity.toObject() calls convertEntityValue() which walks Object.keys
    // on objects, which destructively destructures Buffer/Uint8Array into a
    // plain `{0: byte, 1: byte, …}` map (losing the typed-array constructor).
    // Returning the underlying typed array directly from the entity getter
    // preserves the buffer for the Prisma write path (Bytes column).
    encryptedValue: (entity) => entity.encryptedValue ?? null,
  },
  $toDomain: {
    encryptedValue: (model) => model.encryptedValue ?? null,
  },
});
