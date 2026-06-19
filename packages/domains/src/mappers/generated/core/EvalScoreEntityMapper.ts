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
  $toPersistence: {
    // TASK-369 Phase 3C — return the raw ciphertext Buffer directly so the
    // generic auto-mapper does not destructure the typed array (see
    // ContextItemEntityMapper for the rationale).
    encryptedRationale: (entity) => entity.encryptedRationale ?? null,
    encryptedDetails: (entity) => entity.encryptedDetails ?? null,
  },
  $toDomain: {
    encryptedRationale: (model) => model.encryptedRationale ?? null,
    encryptedDetails: (model) => model.encryptedDetails ?? null,
  },
});
