import { AutoClassMapper, AutoEntityChangeMapper, BaseMapper, createMapperHandlers } from '../../../common';
import * as Entities from '../../../entities';
import * as Models from '../../../models';

// `_version` is owned by the database and the only legitimate writer is
// `Repository.updateWithVersion`. This model IS OCC-written (the admin PATCH
// route carries If-Match), so the strip is load-bearing: without it the
// auto-mappers leak `version` into a Prisma update and every compare-and-set
// silently stops meaning anything. Mirrors `AiTaskDefaultEntityMapper`.
const FIELDS_NOT_WRITABLE: string[] = ['version'];

function stripNonWritableFields<T extends object>(model: T, fields: string[]): T {
  for (const field of fields) {
    delete (model as Record<string, unknown>)[field];
  }
  return model;
}

export class ConsultationContextSchemaEntityMapper extends BaseMapper<
  Entities.ConsultationContextSchemaEntity,
  Models.ConsultationContextSchema
> {
  constructor() {
    super();
  }

  public toPersistence(entity: Entities.ConsultationContextSchemaEntity): Models.ConsultationContextSchema {
    const result = AutoClassMapper(
      entity,
      Models.ConsultationContextSchema,
      ConsultationContextSchemaEntityMapperHandlers.$toPersistence,
    );
    return stripNonWritableFields(result, FIELDS_NOT_WRITABLE);
  }

  public toPersistenceChanges(entity: Entities.ConsultationContextSchemaEntity): Partial<Models.ConsultationContextSchema> {
    const result = AutoEntityChangeMapper(
      entity,
      Models.ConsultationContextSchema,
      ConsultationContextSchemaEntityMapperHandlers.$toPersistence,
    );
    return stripNonWritableFields(result, FIELDS_NOT_WRITABLE);
  }

  public toDomainEntity(dataModel: Models.ConsultationContextSchema): Entities.ConsultationContextSchemaEntity {
    return AutoClassMapper(
      dataModel,
      Entities.ConsultationContextSchemaEntity,
      ConsultationContextSchemaEntityMapperHandlers.$toDomain,
    );
  }
}

export const ConsultationContextSchemaEntityMapperHandlers = createMapperHandlers<
  Entities.ConsultationContextSchemaEntity,
  Models.ConsultationContextSchema
>({
  $toPersistence: {},
  $toDomain: {},
});
