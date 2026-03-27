import { AutoClassMapper, AutoEntityChangeMapper, BaseMapper, createMapperHandlers } from '../../../common';
import * as Entities from '../../../entities';
import * as Models from '../../../models';
import * as Mappers from '../../../mappers';

const FIELDS_NOT_IN_PRISMA: string[] = [
  'createdBy',
  'updatedBy',
  'updatedAt',
  'resourceStatus',
  'resourceStatusUpdatedAt',
  'resourceStatusUpdatedBy',
];

function stripNonPrismaFields<T extends object>(model: T, fields: string[]): T {
  for (const field of fields) {
    delete (model as Record<string, unknown>)[field];
  }
  return model;
}

export class PromptUsageRecordEntityMapper extends BaseMapper<Entities.PromptUsageRecordEntity, Models.PromptUsageRecord> {
  constructor() {
    super();
  }

  public toPersistence(entity: Entities.PromptUsageRecordEntity): Models.PromptUsageRecord {
    const result = AutoClassMapper(entity, Models.PromptUsageRecord, PromptUsageRecordEntityMapperHandlers.$toPersistence);
    return stripNonPrismaFields(result, FIELDS_NOT_IN_PRISMA);
  }

  public toPersistenceChanges(entity: Entities.PromptUsageRecordEntity): Partial<Models.PromptUsageRecord> {
    const result = AutoEntityChangeMapper(entity, Models.PromptUsageRecord, PromptUsageRecordEntityMapperHandlers.$toPersistence);
    return stripNonPrismaFields(result, FIELDS_NOT_IN_PRISMA);
  }

  public toDomainEntity(dataModel: Models.PromptUsageRecord): Entities.PromptUsageRecordEntity {
    return AutoClassMapper(dataModel, Entities.PromptUsageRecordEntity, PromptUsageRecordEntityMapperHandlers.$toDomain);
  }
}

export const PromptUsageRecordEntityMapperHandlers = createMapperHandlers<Entities.PromptUsageRecordEntity, Models.PromptUsageRecord>({
  $toPersistence: {},
  $toDomain: {},
});
