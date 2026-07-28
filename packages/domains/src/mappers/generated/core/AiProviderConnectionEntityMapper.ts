import { AutoClassMapper, AutoEntityChangeMapper, BaseMapper, createMapperHandlers } from '../../../common';
import * as Entities from '../../../entities';
import * as Models from '../../../models';

// HAND-AUTHORED (the `gen:mapper` generator crashes pre-existingly;
// see the AiTaskDefaultEntityMapper precedent in this folder).
//
// `_version` is owned by the database and the only legitimate writer is
// `Repository.updateWithVersion`. Strip it from every write path here so the
// auto-mappers cannot leak it into a Prisma update. Mirrors the
// `DepartmentEntityMapper` / `AiTaskDefaultEntityMapper` treatment — this model
// IS OCC-written (versioned PATCH routes).
const FIELDS_NOT_WRITABLE: string[] = ['version'];

function stripNonWritableFields<T extends object>(model: T, fields: string[]): T {
  for (const field of fields) delete (model as Record<string, unknown>)[field];
  return model;
}

export class AiProviderConnectionEntityMapper extends BaseMapper<
  Entities.AiProviderConnectionEntity,
  Models.AiProviderConnection
> {
  constructor() {
    super();
  }

  public toPersistence(entity: Entities.AiProviderConnectionEntity): Models.AiProviderConnection {
    const result = AutoClassMapper(
      entity,
      Models.AiProviderConnection,
      AiProviderConnectionEntityMapperHandlers.$toPersistence,
    );
    return stripNonWritableFields(result, FIELDS_NOT_WRITABLE);
  }

  public toPersistenceChanges(
    entity: Entities.AiProviderConnectionEntity,
  ): Partial<Models.AiProviderConnection> {
    const result = AutoEntityChangeMapper(
      entity,
      Models.AiProviderConnection,
      AiProviderConnectionEntityMapperHandlers.$toPersistence,
    );
    return stripNonWritableFields(result, FIELDS_NOT_WRITABLE);
  }

  public toDomainEntity(dataModel: Models.AiProviderConnection): Entities.AiProviderConnectionEntity {
    return AutoClassMapper(
      dataModel,
      Entities.AiProviderConnectionEntity,
      AiProviderConnectionEntityMapperHandlers.$toDomain,
    );
  }
}

export const AiProviderConnectionEntityMapperHandlers = createMapperHandlers<
  Entities.AiProviderConnectionEntity,
  Models.AiProviderConnection
>({
  $toPersistence: {},
  $toDomain: {},
});
