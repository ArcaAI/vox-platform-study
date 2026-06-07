import { Injectable } from '@nestjs/common';

import { Repository } from '../../../common';
import { KnowledgeChunkEntityMapper } from '../../../mappers';
import { KnowledgeChunkEntity } from '../../../entities';
import { KnowledgeChunk } from '../../../models';
import { CoreUnitOfWorkService } from '../../../common/unitsOfWork/core';

@Injectable()
export class KnowledgeChunkRepository extends Repository<KnowledgeChunkEntity, KnowledgeChunk> {
  constructor(private readonly unitOfWorkService: CoreUnitOfWorkService) {
    super(unitOfWorkService, 'knowledgeChunk', KnowledgeChunkEntityMapper.getInstance(), undefined, ['text']);
  }

  /**
   * Get all chunks for a knowledge document, ordered by their position in the
   * source (chunkIndex ascending).
   */
  async getByKnowledgeDocument(knowledgeDocumentId: string): Promise<KnowledgeChunkEntity[]> {
    return this.findAll({
      filters: { knowledgeDocumentId },
      sort: [{ chunkIndex: 'asc' }],
    });
  }
}
