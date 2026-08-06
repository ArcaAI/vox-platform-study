import { AutoClassMapper, AutoEntityChangeMapper, BaseMapper, createMapperHandlers } from '../../../common';
import * as Entities from '../../../entities';
import * as Models from '../../../models';

// `_version` is owned by the database and the only legitimate writer is
// `Repository.updateWithVersion`. Strip it from every write path here so the
// auto-mappers cannot leak it into a Prisma update — the rate card is admin-managed and effective-dated; a superseding write must not carry a stale OCC token.
// Mirrors the `DepartmentEntityMapper` / `AiTaskDefaultEntityMapper` treatment.
//
// `resourceStatus*` is NOT stripped: unlike its append-only siblings in this
// plane, `AiPriceBook` keeps the standard soft-delete lifecycle and those columns
// exist.
const FIELDS_NOT_WRITABLE: string[] = ['version'];

function stripNonWritableFields<T extends object>(model: T, fields: string[]): T {
  for (const field of fields) {
    delete (model as Record<string, unknown>)[field];
  }
  return model;
}

export class AiPriceBookEntityMapper extends BaseMapper<Entities.AiPriceBookEntity, Models.AiPriceBook> {
  constructor() {
    super();
  }

  public toPersistence(entity: Entities.AiPriceBookEntity): Models.AiPriceBook {
    const result = AutoClassMapper(entity, Models.AiPriceBook, AiPriceBookEntityMapperHandlers.$toPersistence);
    return stripNonWritableFields(result, FIELDS_NOT_WRITABLE);
  }

  public toPersistenceChanges(entity: Entities.AiPriceBookEntity): Partial<Models.AiPriceBook> {
    const result = AutoEntityChangeMapper(entity, Models.AiPriceBook, AiPriceBookEntityMapperHandlers.$toPersistence);
    return stripNonWritableFields(result, FIELDS_NOT_WRITABLE);
  }

  public toDomainEntity(dataModel: Models.AiPriceBook): Entities.AiPriceBookEntity {
    return AutoClassMapper(dataModel, Entities.AiPriceBookEntity, AiPriceBookEntityMapperHandlers.$toDomain);
  }
}

export const AiPriceBookEntityMapperHandlers = createMapperHandlers<Entities.AiPriceBookEntity, Models.AiPriceBook>({
  $toPersistence: {},
  $toDomain: {},
});
