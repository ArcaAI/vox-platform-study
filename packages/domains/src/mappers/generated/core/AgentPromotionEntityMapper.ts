import { AutoClassMapper, AutoEntityChangeMapper, BaseMapper, createMapperHandlers } from '../../../common';
import * as Entities from '../../../entities';
import * as Models from '../../../models';

// TASK-663 — the promotion table is an IMMUTABLE, WORM record: it has no
// `updatedAt`/`updatedBy` and no `resourceStatus*` columns in Prisma, but
// `BaseTenantEntity` surfaces them, so they must be stripped or every insert is
// a Prisma validation error. Exactly the `DepartmentAgentVersionEntityMapper` /
// `ConsultationContextSchemaVersionEntityMapper` treatment.
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

export class AgentPromotionEntityMapper extends BaseMapper<Entities.AgentPromotionEntity, Models.AgentPromotion> {
  constructor() {
    super();
  }

  public toPersistence(entity: Entities.AgentPromotionEntity): Models.AgentPromotion {
    const result = AutoClassMapper(entity, Models.AgentPromotion, AgentPromotionEntityMapperHandlers.$toPersistence);
    return stripFields(stripFields(result, FIELDS_NOT_IN_PRISMA), FIELDS_NOT_WRITABLE);
  }

  public toPersistenceChanges(entity: Entities.AgentPromotionEntity): Partial<Models.AgentPromotion> {
    const result = AutoEntityChangeMapper(entity, Models.AgentPromotion, AgentPromotionEntityMapperHandlers.$toPersistence);
    return stripFields(stripFields(result, FIELDS_NOT_IN_PRISMA), FIELDS_NOT_WRITABLE);
  }

  public toDomainEntity(dataModel: Models.AgentPromotion): Entities.AgentPromotionEntity {
    return AutoClassMapper(dataModel, Entities.AgentPromotionEntity, AgentPromotionEntityMapperHandlers.$toDomain);
  }
}

// No suppression entries needed: the model carries no relation properties at
// all (every id column is a loose `String` with no `@relation` — see
// department-agent.prisma, where the reason is spelled out: two of the four
// name rows in the SOURCE tenant).
export const AgentPromotionEntityMapperHandlers = createMapperHandlers<Entities.AgentPromotionEntity, Models.AgentPromotion>({
  $toPersistence: {},
  $toDomain: {},
});
