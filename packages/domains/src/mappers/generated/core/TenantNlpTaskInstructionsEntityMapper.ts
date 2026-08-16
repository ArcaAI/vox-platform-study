import { AutoClassMapper, AutoEntityChangeMapper, BaseMapper, createMapperHandlers } from '../../../common';
import * as Entities from '../../../entities';
import * as Models from '../../../models';

// `_version` is owned by the database and the only legitimate writer is
// `Repository.updateWithVersion`. Strip it from every write path here so the
// auto-mappers cannot leak it into a Prisma update. Mirrors the
// `AiTaskDefaultEntityMapper` treatment (this model is OCC-written).
const FIELDS_NOT_WRITABLE: string[] = ['version'];

function stripNonWritableFields<T extends object>(model: T, fields: string[]): T {
  for (const field of fields) {
    delete (model as Record<string, unknown>)[field];
  }
  return model;
}

export class TenantNlpTaskInstructionsEntityMapper extends BaseMapper<
  Entities.TenantNlpTaskInstructionsEntity,
  Models.TenantNlpTaskInstructions
> {
  constructor() {
    super();
  }

  public toPersistence(entity: Entities.TenantNlpTaskInstructionsEntity): Models.TenantNlpTaskInstructions {
    const result = AutoClassMapper(
      entity,
      Models.TenantNlpTaskInstructions,
      TenantNlpTaskInstructionsEntityMapperHandlers.$toPersistence,
    );
    return stripNonWritableFields(result, FIELDS_NOT_WRITABLE);
  }

  public toPersistenceChanges(
    entity: Entities.TenantNlpTaskInstructionsEntity,
  ): Partial<Models.TenantNlpTaskInstructions> {
    const result = AutoEntityChangeMapper(
      entity,
      Models.TenantNlpTaskInstructions,
      TenantNlpTaskInstructionsEntityMapperHandlers.$toPersistence,
    );
    return stripNonWritableFields(result, FIELDS_NOT_WRITABLE);
  }

  public toDomainEntity(dataModel: Models.TenantNlpTaskInstructions): Entities.TenantNlpTaskInstructionsEntity {
    return AutoClassMapper(
      dataModel,
      Entities.TenantNlpTaskInstructionsEntity,
      TenantNlpTaskInstructionsEntityMapperHandlers.$toDomain,
    );
  }
}

export const TenantNlpTaskInstructionsEntityMapperHandlers = createMapperHandlers<
  Entities.TenantNlpTaskInstructionsEntity,
  Models.TenantNlpTaskInstructions
>({
  $toPersistence: {},
  $toDomain: {},
});
