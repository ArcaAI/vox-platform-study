import { AutoClassMapper, AutoEntityChangeMapper, BaseMapper, createMapperHandlers } from '../../../common';
import * as Entities from '../../../entities';
import * as Models from '../../../models';
import * as Mappers from '../../../mappers';

// `_version` is database-owned (initial
// value at `Prisma.create()` and atomic `version + 1` bump inside the
// repository's Compare-And-Set predicate). Stripping it here on every
// write makes accidental client-supplied `version` payloads no-ops.
const FIELDS_NOT_WRITABLE: string[] = ['version'];

function stripNonWritableFields<T extends object>(model: T, fields: string[]): T {
  for (const field of fields) {
    if (field in model) {
      delete (model as Record<string, unknown>)[field];
    }
  }
  return model;
}

export class AsrPipelineEntityMapper extends BaseMapper<Entities.AsrPipelineEntity, Models.AsrPipeline> {
  constructor() {
    super();
  }

  public toPersistence(entity: Entities.AsrPipelineEntity): Models.AsrPipeline {
    const result = AutoClassMapper(entity, Models.AsrPipeline, AsrPipelineEntityMapperHandlers.$toPersistence);
    return stripNonWritableFields(result, FIELDS_NOT_WRITABLE);
  }

  public toPersistenceChanges(entity: Entities.AsrPipelineEntity): Partial<Models.AsrPipeline> {
    const result = AutoEntityChangeMapper(entity, Models.AsrPipeline, AsrPipelineEntityMapperHandlers.$toPersistence);
    return stripNonWritableFields(result, FIELDS_NOT_WRITABLE);
  }

  public toDomainEntity(dataModel: Models.AsrPipeline): Entities.AsrPipelineEntity {
    return AutoClassMapper(dataModel, Entities.AsrPipelineEntity, AsrPipelineEntityMapperHandlers.$toDomain);
  }
}

export const AsrPipelineEntityMapperHandlers = createMapperHandlers<Entities.AsrPipelineEntity, Models.AsrPipeline>({
  $toPersistence: {
    // Handle TranscriptionJobs relation - exclude from persistence
    TranscriptionJobs: () => undefined,
  },
  $toDomain: {
    // Handle TranscriptionJobs relation mapping
    TranscriptionJobs: (obj: any) => {
      if (!obj.TranscriptionJobs || obj.TranscriptionJobs.length === 0) return undefined;
      const mapper = Mappers.TranscriptionJobEntityMapper.getInstance();
      return obj.TranscriptionJobs.map((job: any) => mapper.toDomainEntity(job));
    },
  },
});
