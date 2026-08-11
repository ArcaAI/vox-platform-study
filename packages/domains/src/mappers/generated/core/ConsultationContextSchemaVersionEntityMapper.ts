import { AutoClassMapper, AutoEntityChangeMapper, BaseMapper, createMapperHandlers } from '../../../common';
import * as Entities from '../../../entities';
import * as Models from '../../../models';

// The version table is an IMMUTABLE snapshot: it has no `updatedAt`/`updatedBy`
// and no `resourceStatus*` columns in Prisma, but `BaseTenantEntity` surfaces
// them, so they must be stripped or every insert is a Prisma validation error.
// Exactly the `PromptVersionEntityMapper` treatment.
const FIELDS_NOT_IN_PRISMA: string[] = ['updatedAt', 'updatedBy', 'resourceStatus', 'resourceStatusUpdatedAt', 'resourceStatusUpdatedBy'];

// `_version` is owned by the database. Stripped separately from the list above
// because it exists as a COLUMN here (the row is a BaseTenantDataModel) — it is
// simply never writable from a mapper.
const FIELDS_NOT_WRITABLE: string[] = ['version'];

function stripFields<T extends object>(model: T, fields: string[]): T {
  for (const field of fields) {
    delete (model as Record<string, unknown>)[field];
  }
  return model;
}

export class ConsultationContextSchemaVersionEntityMapper extends BaseMapper<
  Entities.ConsultationContextSchemaVersionEntity,
  Models.ConsultationContextSchemaVersion
> {
  constructor() {
    super();
  }

  public toPersistence(entity: Entities.ConsultationContextSchemaVersionEntity): Models.ConsultationContextSchemaVersion {
    const result = AutoClassMapper(
      entity,
      Models.ConsultationContextSchemaVersion,
      ConsultationContextSchemaVersionEntityMapperHandlers.$toPersistence,
    );
    return stripFields(stripFields(result, FIELDS_NOT_IN_PRISMA), FIELDS_NOT_WRITABLE);
  }

  public toPersistenceChanges(
    entity: Entities.ConsultationContextSchemaVersionEntity,
  ): Partial<Models.ConsultationContextSchemaVersion> {
    const result = AutoEntityChangeMapper(
      entity,
      Models.ConsultationContextSchemaVersion,
      ConsultationContextSchemaVersionEntityMapperHandlers.$toPersistence,
    );
    return stripFields(stripFields(result, FIELDS_NOT_IN_PRISMA), FIELDS_NOT_WRITABLE);
  }

  public toDomainEntity(dataModel: Models.ConsultationContextSchemaVersion): Entities.ConsultationContextSchemaVersionEntity {
    return AutoClassMapper(
      dataModel,
      Entities.ConsultationContextSchemaVersionEntity,
      ConsultationContextSchemaVersionEntityMapperHandlers.$toDomain,
    );
  }
}

export const ConsultationContextSchemaVersionEntityMapperHandlers = createMapperHandlers<
  Entities.ConsultationContextSchemaVersionEntity,
  Models.ConsultationContextSchemaVersion
>({
  $toPersistence: {},
  $toDomain: {},
});
