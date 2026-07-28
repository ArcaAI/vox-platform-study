import { AutoClassMapper, AutoEntityChangeMapper, BaseMapper, createMapperHandlers } from '../../../common';
import * as Entities from '../../../entities';
import * as Models from '../../../models';
import * as Mappers from '../../../mappers';

export class KnowledgeDocumentEntityMapper extends BaseMapper<Entities.KnowledgeDocumentEntity, Models.KnowledgeDocument> {
  constructor() {
    super();
  }

  public toPersistence(entity: Entities.KnowledgeDocumentEntity): Models.KnowledgeDocument {
    return AutoClassMapper(entity, Models.KnowledgeDocument, KnowledgeDocumentEntityMapperHandlers.$toPersistence);
  }

  public toPersistenceChanges(entity: Entities.KnowledgeDocumentEntity): Partial<Models.KnowledgeDocument> {
    return AutoEntityChangeMapper(entity, Models.KnowledgeDocument, KnowledgeDocumentEntityMapperHandlers.$toPersistence);
  }

  public toDomainEntity(dataModel: Models.KnowledgeDocument): Entities.KnowledgeDocumentEntity {
    return AutoClassMapper(dataModel, Entities.KnowledgeDocumentEntity, KnowledgeDocumentEntityMapperHandlers.$toDomain);
  }
}

export const KnowledgeDocumentEntityMapperHandlers = createMapperHandlers<Entities.KnowledgeDocumentEntity, Models.KnowledgeDocument>({
  $toPersistence: {},
  $toDomain: {},
});
