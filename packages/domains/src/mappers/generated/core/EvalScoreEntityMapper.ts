import { AutoClassMapper, AutoEntityChangeMapper, BaseMapper, createMapperHandlers } from '../../../common';
import * as Entities from '../../../entities';
import * as Models from '../../../models';
import * as Mappers from '../../../mappers';

export class EvalScoreEntityMapper extends BaseMapper<Entities.EvalScoreEntity, Models.EvalScore> {
  constructor() {
    super();
  }

  public toPersistence(entity: Entities.EvalScoreEntity): Models.EvalScore {
    return AutoClassMapper(entity, Models.EvalScore, EvalScoreEntityMapperHandlers.$toPersistence);
  }

  public toPersistenceChanges(entity: Entities.EvalScoreEntity): Partial<Models.EvalScore> {
    return AutoEntityChangeMapper(entity, Models.EvalScore, EvalScoreEntityMapperHandlers.$toPersistence);
  }

  public toDomainEntity(dataModel: Models.EvalScore): Entities.EvalScoreEntity {
    return AutoClassMapper(dataModel, Entities.EvalScoreEntity, EvalScoreEntityMapperHandlers.$toDomain);
  }
}

export const EvalScoreEntityMapperHandlers = createMapperHandlers<Entities.EvalScoreEntity, Models.EvalScore>({
  $toPersistence: {},
  $toDomain: {},
});
