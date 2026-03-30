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

export class DnaUsageRecordEntityMapper extends BaseMapper<Entities.DnaUsageRecordEntity, Models.DnaUsageRecord> {
  constructor() {
    super();
  }

  public toPersistence(entity: Entities.DnaUsageRecordEntity): Models.DnaUsageRecord {
    const result = AutoClassMapper(entity, Models.DnaUsageRecord, DnaUsageRecordEntityMapperHandlers.$toPersistence);
    return stripNonPrismaFields(result, FIELDS_NOT_IN_PRISMA);
  }

  public toPersistenceChanges(entity: Entities.DnaUsageRecordEntity): Partial<Models.DnaUsageRecord> {
    const result = AutoEntityChangeMapper(entity, Models.DnaUsageRecord, DnaUsageRecordEntityMapperHandlers.$toPersistence);
    return stripNonPrismaFields(result, FIELDS_NOT_IN_PRISMA);
  }

  public toDomainEntity(dataModel: Models.DnaUsageRecord): Entities.DnaUsageRecordEntity {
    return AutoClassMapper(dataModel, Entities.DnaUsageRecordEntity, DnaUsageRecordEntityMapperHandlers.$toDomain);
  }
}

export const DnaUsageRecordEntityMapperHandlers = createMapperHandlers<Entities.DnaUsageRecordEntity, Models.DnaUsageRecord>({
  $toPersistence: {},
  $toDomain: {},
});
