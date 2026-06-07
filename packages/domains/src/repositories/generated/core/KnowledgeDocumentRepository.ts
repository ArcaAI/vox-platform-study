import { Injectable } from '@nestjs/common';

import { Repository } from '../../../common';
import { KnowledgeDocumentEntityMapper } from '../../../mappers';
import { KnowledgeDocumentEntity } from '../../../entities';
import { KnowledgeDocument } from '../../../models';
import { CoreUnitOfWorkService } from '../../../common/unitsOfWork/core';

@Injectable()
export class KnowledgeDocumentRepository extends Repository<KnowledgeDocumentEntity, KnowledgeDocument> {
  constructor(private readonly unitOfWorkService: CoreUnitOfWorkService) {
    super(unitOfWorkService, 'knowledgeDocument', KnowledgeDocumentEntityMapper.getInstance(), undefined, ['title', 'source']);
  }
}
