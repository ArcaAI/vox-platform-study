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

/** @deprecated TASK-861 — removed in R4 with `AsrPipeline`; the Agent's rows-are-versions model replaces it. */
export class AsrPipelineVersionEntityMapper extends BaseMapper<Entities.AsrPipelineVersionEntity, Models.AsrPipelineVersion> {
  constructor() {
    super();
  }

  public toPersistence(entity: Entities.AsrPipelineVersionEntity): Models.AsrPipelineVersion {
    const result = AutoClassMapper(entity, Models.AsrPipelineVersion, AsrPipelineVersionEntityMapperHandlers.$toPersistence);
    return stripNonPrismaFields(result, FIELDS_NOT_IN_PRISMA);
  }

  public toPersistenceChanges(entity: Entities.AsrPipelineVersionEntity): Partial<Models.AsrPipelineVersion> {
    const result = AutoEntityChangeMapper(entity, Models.AsrPipelineVersion, AsrPipelineVersionEntityMapperHandlers.$toPersistence);
    return stripNonPrismaFields(result, FIELDS_NOT_IN_PRISMA);
  }

  public toDomainEntity(dataModel: Models.AsrPipelineVersion): Entities.AsrPipelineVersionEntity {
    return AutoClassMapper(dataModel, Entities.AsrPipelineVersionEntity, AsrPipelineVersionEntityMapperHandlers.$toDomain);
  }
}

export const AsrPipelineVersionEntityMapperHandlers = createMapperHandlers<Entities.AsrPipelineVersionEntity, Models.AsrPipelineVersion>({
  $toPersistence: {},
  $toDomain: {},
});
