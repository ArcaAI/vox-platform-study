import { AutoClassMapper, AutoEntityChangeMapper, BaseMapper, createMapperHandlers } from '../../../common';
import * as Entities from '../../../entities';
import * as Models from '../../../models';
import * as Mappers from '../../../mappers';

export class GlobalSettingEntityMapper extends BaseMapper<Entities.GlobalSettingEntity, Models.GlobalSetting> {
  constructor() {
    super();
  }

  public toPersistence(entity: Entities.GlobalSettingEntity): Models.GlobalSetting {
    return AutoClassMapper(entity, Models.GlobalSetting, GlobalSettingEntityMapperHandlers.$toPersistence);
  }

  public toPersistenceChanges(entity: Entities.GlobalSettingEntity): Partial<Models.GlobalSetting> {
    return AutoEntityChangeMapper(entity, Models.GlobalSetting, GlobalSettingEntityMapperHandlers.$toPersistence);
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
