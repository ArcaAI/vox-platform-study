import { AutoClassMapper, AutoEntityChangeMapper, BaseMapper, createMapperHandlers } from '../../../common';
import * as Entities from '../../../entities';
import * as Models from '../../../models';

// The version table is an IMMUTABLE snapshot: it has no `updatedAt`/`updatedBy`
// and no `resourceStatus*` columns in Prisma, but `BaseTenantEntity` surfaces
// them, so they must be stripped or every insert is a Prisma validation error.
// Exactly the `ConsultationContextSchemaVersionEntityMapper` /
// `PromptVersionEntityMapper` treatment.
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

export class DepartmentAgentVersionEntityMapper extends BaseMapper<Entities.DepartmentAgentVersionEntity, Models.DepartmentAgentVersion> {
  constructor() {
    super();
  }

  public toPersistence(entity: Entities.DepartmentAgentVersionEntity): Models.DepartmentAgentVersion {
    const result = AutoClassMapper(entity, Models.DepartmentAgentVersion, DepartmentAgentVersionEntityMapperHandlers.$toPersistence);
    return stripFields(stripFields(result, FIELDS_NOT_IN_PRISMA), FIELDS_NOT_WRITABLE);
  }

  public toPersistenceChanges(entity: Entities.DepartmentAgentVersionEntity): Partial<Models.DepartmentAgentVersion> {
    const result = AutoEntityChangeMapper(entity, Models.DepartmentAgentVersion, DepartmentAgentVersionEntityMapperHandlers.$toPersistence);
    return stripFields(stripFields(result, FIELDS_NOT_IN_PRISMA), FIELDS_NOT_WRITABLE);
  }

  public toDomainEntity(dataModel: Models.DepartmentAgentVersion): Entities.DepartmentAgentVersionEntity {
    return AutoClassMapper(dataModel, Entities.DepartmentAgentVersionEntity, DepartmentAgentVersionEntityMapperHandlers.$toDomain);
  }
}

// `Agent` needs no suppression entry: `Models.DepartmentAgentVersion.Agent` is
// `@VirtualDbProperty()`-marked (stripped from Prisma writes by the
// repository layer itself), exactly the `ConsultationContextSchemaVersionEntityMapper`
// / `Schema` treatment.
export const DepartmentAgentVersionEntityMapperHandlers = createMapperHandlers<
  Entities.DepartmentAgentVersionEntity,
  Models.DepartmentAgentVersion
>({
  $toPersistence: {},
  $toDomain: {},
});
