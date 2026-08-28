import { AutoClassMapper, AutoEntityChangeMapper, BaseMapper, createMapperHandlers } from '../../../common';
import * as Entities from '../../../entities';
import * as Models from '../../../models';

// `_version` is DATABASE-OWNED: its only legitimate writer is
// `Repository.updateWithVersion`'s compare-and-set. `DocumentSection` is the
// most OCC-written model in the platform — per-section optimistic concurrency is
// the entire reason it is a table and not JSON on one blob — so leaking
// `_version` into a Prisma update here would silently break the one guarantee
// the model exists to provide ("a CONFIRMED section is never overwritten by a
// flush"). Same treatment as `ContextItemEntityMapper` / `AiTaskDefaultEntityMapper`.
const FIELDS_NOT_WRITABLE: string[] = ['version'];

// `DocumentSection` has NO `resourceStatus*` columns (per-consultation document
// annotation, no soft-delete — see MODELS_WITHOUT_SOFT_DELETE), but
// `BaseTenantEntity` surfaces them, so they must be stripped or every insert is
// a Prisma validation error. Exactly the `TranscriptSegmentEntityMapper`
// treatment.
const FIELDS_NOT_IN_PRISMA: string[] = ['resourceStatus', 'resourceStatusUpdatedAt', 'resourceStatusUpdatedBy'];

function stripFields<T extends object>(model: T, fields: string[]): T {
  for (const field of fields) {
    delete (model as Record<string, unknown>)[field];
  }
  return model;
}

export class DocumentSectionEntityMapper extends BaseMapper<Entities.DocumentSectionEntity, Models.DocumentSection> {
  constructor() {
    super();
  }

  public toPersistence(entity: Entities.DocumentSectionEntity): Models.DocumentSection {
    const result = AutoClassMapper(entity, Models.DocumentSection, DocumentSectionEntityMapperHandlers.$toPersistence);
    return stripFields(stripFields(result, FIELDS_NOT_IN_PRISMA), FIELDS_NOT_WRITABLE);
  }

  public toPersistenceChanges(entity: Entities.DocumentSectionEntity): Partial<Models.DocumentSection> {
    const result = AutoEntityChangeMapper(entity, Models.DocumentSection, DocumentSectionEntityMapperHandlers.$toPersistence);
    return stripFields(stripFields(result, FIELDS_NOT_IN_PRISMA), FIELDS_NOT_WRITABLE);
  }

  public toDomainEntity(dataModel: Models.DocumentSection): Entities.DocumentSectionEntity {
    return AutoClassMapper(dataModel, Entities.DocumentSectionEntity, DocumentSectionEntityMapperHandlers.$toDomain);
  }
}

export const DocumentSectionEntityMapperHandlers = createMapperHandlers<Entities.DocumentSectionEntity, Models.DocumentSection>({
  $toPersistence: {
    // Bypass the generic auto-mapper for binary ciphertext: `BaseEntity.toObject()`
    // walks `Object.keys` on objects and would destructure a Buffer/Uint8Array
    // into a plain `{0: byte, …}` map, losing the typed-array constructor Prisma's
    // `Bytes` write path needs. Same handler `ContextItemEntityMapper` uses.
    encryptedContent: (entity) => entity.encryptedContent ?? null,
  },
  $toDomain: {
    encryptedContent: (model) => model.encryptedContent ?? null,
  },
});
