import { AutoClassMapper, AutoEntityChangeMapper, BaseMapper, createMapperHandlers } from '../../../common';
import * as Entities from '../../../entities';
import * as Models from '../../../models';

// `_version` is owned by the database and the only legitimate writer is
// `Repository.updateWithVersion`. Strip it from every write path here so the
// auto-mappers cannot leak it into a Prisma update. `RateLimitRule` IS
// OCC-written (the admin PATCH route carries If-Match), so this strip is
// load-bearing, not ceremonial. Mirrors the `DepartmentEntityMapper` treatment.
const FIELDS_NOT_WRITABLE: string[] = ['version'];

function stripNonWritableFields<T extends object>(model: T, fields: string[]): T {
  for (const field of fields) {
    delete (model as Record<string, unknown>)[field];
  }
  return model;
}

export class RateLimitRuleEntityMapper extends BaseMapper<Entities.RateLimitRuleEntity, Models.RateLimitRule> {
  constructor() {
    super();
  }

  public toPersistence(entity: Entities.RateLimitRuleEntity): Models.RateLimitRule {
    const result = AutoClassMapper(entity, Models.RateLimitRule, RateLimitRuleEntityMapperHandlers.$toPersistence);
    return stripNonWritableFields(result, FIELDS_NOT_WRITABLE);
  }

  public toPersistenceChanges(entity: Entities.RateLimitRuleEntity): Partial<Models.RateLimitRule> {
    const result = AutoEntityChangeMapper(entity, Models.RateLimitRule, RateLimitRuleEntityMapperHandlers.$toPersistence);
    return stripNonWritableFields(result, FIELDS_NOT_WRITABLE);
  }

  public toDomainEntity(dataModel: Models.RateLimitRule): Entities.RateLimitRuleEntity {
    return AutoClassMapper(dataModel, Entities.RateLimitRuleEntity, RateLimitRuleEntityMapperHandlers.$toDomain);
  }
}

export const RateLimitRuleEntityMapperHandlers = createMapperHandlers<Entities.RateLimitRuleEntity, Models.RateLimitRule>({
  $toPersistence: {},
  $toDomain: {},
});
