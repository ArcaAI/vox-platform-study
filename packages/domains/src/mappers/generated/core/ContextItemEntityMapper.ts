import { AutoClassMapper, AutoEntityChangeMapper, BaseMapper, createMapperHandlers } from '../../../common';
import * as Entities from '../../../entities';
import * as Models from '../../../models';
import * as Mappers from '../../../mappers';

export class ContextItemEntityMapper extends BaseMapper<Entities.ContextItemEntity, Models.ContextItem> {
  constructor() {
    super();
  }

  public toPersistence(entity: Entities.ContextItemEntity): Models.ContextItem {
    return AutoClassMapper(entity, Models.ContextItem, ContextItemEntityMapperHandlers.$toPersistence);
  }

  public toPersistenceChanges(entity: Entities.ContextItemEntity): Partial<Models.ContextItem> {
    return AutoEntityChangeMapper(entity, Models.ContextItem, ContextItemEntityMapperHandlers.$toPersistence);
  }

  public toDomainEntity(dataModel: Models.ContextItem): Entities.ContextItemEntity {
    return AutoClassMapper(dataModel, Entities.ContextItemEntity, ContextItemEntityMapperHandlers.$toDomain);
  }
}

export const ContextItemEntityMapperHandlers = createMapperHandlers<Entities.ContextItemEntity, Models.ContextItem>({
  $toPersistence: {
    // TASK-369 Phase 3B — bypass the generic auto-mapper for binary ciphertext.
    // BaseEntity.toObject() calls convertEntityValue() which walks Object.keys
    // on objects, destructively destructuring Buffer/Uint8Array into a plain
    // `{0: byte, …}` map (losing the typed-array constructor). Returning the
    // underlying buffer directly preserves it for the Prisma Bytes write path.
    encryptedContent: (entity) => entity.encryptedContent ?? null,
  },
  $toDomain: {
    encryptedContent: (model) => model.encryptedContent ?? null,
    // Map nested AudioRecordings relation
    AudioRecordings: (obj: any) =>
      obj.AudioRecordings?.map((item: any) => Mappers.AudioRecordingEntityMapper.getInstance().toDomainEntity(item)) || null,
    // Map nested SummaryMeta relation (1:1)
    SummaryMeta: (obj: any) => (obj.SummaryMeta ? Mappers.SummaryMetaEntityMapper.getInstance().toDomainEntity(obj.SummaryMeta) : null),
    // Map nested NamedEntities relation
    NamedEntities: (obj: any) => obj.NamedEntities?.map((item: any) => Mappers.NamedEntityEntityMapper.getInstance().toDomainEntity(item)) || null,
    // Map nested Versions relation
    Versions: (obj: any) => obj.Versions?.map((item: any) => Mappers.ContextItemVersionEntityMapper.getInstance().toDomainEntity(item)) || null,
  },
});
