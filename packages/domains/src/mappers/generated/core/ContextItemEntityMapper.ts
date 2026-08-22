import { AutoClassMapper, AutoEntityChangeMapper, BaseMapper, createMapperHandlers } from '../../../common';
import * as Entities from '../../../entities';
import * as Models from '../../../models';
import * as Mappers from '../../../mappers';

// `_version` is DATABASE-OWNED: its only legitimate writer is `Repository.updateWithVersion`'s
// compare-and-set. `ContextItem` is OCC-written (the clinician SOAP-note edit path calls
// `updateWithVersion`), so rule 03 requires the strip here — the same treatment
// `SummaryMetaEntityMapper` and `DepartmentEntityMapper` give it. Reads are unaffected:
// `toDomainEntity` still carries the row's real version onto the entity, which is what the CAS
// needs. `updateWithVersion` also deletes `version` defensively, but that is a second line of
// defense, not a substitute for this one — a write path that does not go through it would
// otherwise leak `_version` into Prisma and silently break optimistic concurrency.
const FIELDS_NOT_WRITABLE: string[] = ['version'];

function stripNonWritableFields<T extends object>(model: T, fields: string[]): T {
  for (const field of fields) {
    delete (model as Record<string, unknown>)[field];
  }
  return model;
}

export class ContextItemEntityMapper extends BaseMapper<Entities.ContextItemEntity, Models.ContextItem> {
  constructor() {
    super();
  }

  public toPersistence(entity: Entities.ContextItemEntity): Models.ContextItem {
    const result = AutoClassMapper(entity, Models.ContextItem, ContextItemEntityMapperHandlers.$toPersistence);
    return stripNonWritableFields(result, FIELDS_NOT_WRITABLE);
  }

  public toPersistenceChanges(entity: Entities.ContextItemEntity): Partial<Models.ContextItem> {
    const result = AutoEntityChangeMapper(entity, Models.ContextItem, ContextItemEntityMapperHandlers.$toPersistence);
    return stripNonWritableFields(result, FIELDS_NOT_WRITABLE);
  }

  public toDomainEntity(dataModel: Models.ContextItem): Entities.ContextItemEntity {
    return AutoClassMapper(dataModel, Entities.ContextItemEntity, ContextItemEntityMapperHandlers.$toDomain);
  }
}

export const ContextItemEntityMapperHandlers = createMapperHandlers<Entities.ContextItemEntity, Models.ContextItem>({
  $toPersistence: {
    // Bypass the generic auto-mapper for binary ciphertext.
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
