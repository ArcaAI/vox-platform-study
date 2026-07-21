import { AutoClassMapper, AutoEntityChangeMapper, BaseMapper, createMapperHandlers } from '../../../common';
import * as Entities from '../../../entities';
import * as Models from '../../../models';
import * as Mappers from '../../../mappers';

export class GoldenCaseEntityMapper extends BaseMapper<Entities.GoldenCaseEntity, Models.GoldenCase> {
  constructor() {
    super();
  }

  public toPersistence(entity: Entities.GoldenCaseEntity): Models.GoldenCase {
    return AutoClassMapper(entity, Models.GoldenCase, GoldenCaseEntityMapperHandlers.$toPersistence);
  }

  public toPersistenceChanges(entity: Entities.GoldenCaseEntity): Partial<Models.GoldenCase> {
    return AutoEntityChangeMapper(entity, Models.GoldenCase, GoldenCaseEntityMapperHandlers.$toPersistence);
  }

  public toDomainEntity(dataModel: Models.GoldenCase): Entities.GoldenCaseEntity {
    return AutoClassMapper(dataModel, Entities.GoldenCaseEntity, GoldenCaseEntityMapperHandlers.$toDomain);
  }
}

export const GoldenCaseEntityMapperHandlers = createMapperHandlers<Entities.GoldenCaseEntity, Models.GoldenCase>({
  $toPersistence: {
    // Return the raw ciphertext Buffer directly so the
    // generic auto-mapper does not destructure the typed array (see
    // ContextItemEntityMapper for the rationale).
    encryptedTranscript: (entity) => entity.encryptedTranscript ?? null,
    encryptedReferenceNote: (entity) => entity.encryptedReferenceNote ?? null,
  },
  $toDomain: {
    encryptedTranscript: (model) => model.encryptedTranscript ?? null,
    encryptedReferenceNote: (model) => model.encryptedReferenceNote ?? null,
  },
});
