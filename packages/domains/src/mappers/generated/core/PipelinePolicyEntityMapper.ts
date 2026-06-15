import { AutoClassMapper, AutoEntityChangeMapper, BaseMapper, createMapperHandlers } from '../../../common';
import * as Entities from '../../../entities';
import * as Models from '../../../models';
import * as Mappers from '../../../mappers';

export class PipelinePolicyEntityMapper extends BaseMapper<Entities.PipelinePolicyEntity, Models.PipelinePolicy> {
  constructor() {
    super();
  }

  public toPersistence(entity: Entities.PipelinePolicyEntity): Models.PipelinePolicy {
    return AutoClassMapper(entity, Models.PipelinePolicy, PipelinePolicyEntityMapperHandlers.$toPersistence);
  }

  public toPersistenceChanges(entity: Entities.PipelinePolicyEntity): Partial<Models.PipelinePolicy> {
    return AutoEntityChangeMapper(entity, Models.PipelinePolicy, PipelinePolicyEntityMapperHandlers.$toPersistence);
  }

  public toDomainEntity(dataModel: Models.PipelinePolicy): Entities.PipelinePolicyEntity {
    return AutoClassMapper(dataModel, Entities.PipelinePolicyEntity, PipelinePolicyEntityMapperHandlers.$toDomain);
  }
}

export const PipelinePolicyEntityMapperHandlers = createMapperHandlers<Entities.PipelinePolicyEntity, Models.PipelinePolicy>({
  $toPersistence: {},
  $toDomain: {},
});
