import { AutoClassMapper, AutoEntityChangeMapper, BaseMapper, createMapperHandlers } from '../../../common';
import * as Entities from '../../../entities';
import * as Models from '../../../models';
import * as Mappers from '../../../mappers';

export class KnowledgeChunkEntityMapper extends BaseMapper<Entities.KnowledgeChunkEntity, Models.KnowledgeChunk> {
  constructor() {
    super();
  }

  public toPersistence(entity: Entities.KnowledgeChunkEntity): Models.KnowledgeChunk {
    return AutoClassMapper(entity, Models.KnowledgeChunk, KnowledgeChunkEntityMapperHandlers.$toPersistence);
  }

  public toPersistenceChanges(entity: Entities.KnowledgeChunkEntity): Partial<Models.KnowledgeChunk> {
    return AutoEntityChangeMapper(entity, Models.KnowledgeChunk, KnowledgeChunkEntityMapperHandlers.$toPersistence);
  }

  public toDomainEntity(dataModel: Models.KnowledgeChunk): Entities.KnowledgeChunkEntity {
    return AutoClassMapper(dataModel, Entities.KnowledgeChunkEntity, KnowledgeChunkEntityMapperHandlers.$toDomain);
  }
}

export const KnowledgeChunkEntityMapperHandlers = createMapperHandlers<Entities.KnowledgeChunkEntity, Models.KnowledgeChunk>(
  {
    $toPersistence: {},
    $toDomain: {},
  },
);
