import { AutoClassMapper, AutoEntityChangeMapper, BaseMapper, createMapperHandlers } from '../../../common';
import * as Entities from '../../../entities';
import * as Models from '../../../models';
import * as Mappers from '../../../mappers';

export class EvalRunEntityMapper extends BaseMapper<Entities.EvalRunEntity, Models.EvalRun> {
  constructor() {
    super();
  }

  public toPersistence(entity: Entities.EvalRunEntity): Models.EvalRun {
    return AutoClassMapper(entity, Models.EvalRun, EvalRunEntityMapperHandlers.$toPersistence);
  }

  public toPersistenceChanges(entity: Entities.EvalRunEntity): Partial<Models.EvalRun> {
    return AutoEntityChangeMapper(entity, Models.EvalRun, EvalRunEntityMapperHandlers.$toPersistence);
  }

  public toDomainEntity(dataModel: Models.EvalRun): Entities.EvalRunEntity {
    return AutoClassMapper(dataModel, Entities.EvalRunEntity, EvalRunEntityMapperHandlers.$toDomain);
  }
}

export const EvalRunEntityMapperHandlers = createMapperHandlers<Entities.EvalRunEntity, Models.EvalRun>({
  $toPersistence: {},
  $toDomain: {},
});
