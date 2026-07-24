import { Injectable } from '@nestjs/common';
import { Prisma } from '@arcaai/database';

import { Repository } from '../../../common';
import { removeNullValues } from '../../../common/removeNullValues';
import { NamedEntityEntityMapper } from '../../../mappers';
import { NamedEntityEntity } from '../../../entities';
import { NamedEntity } from '../../../models';
import { CoreUnitOfWorkService } from '../../../common/unitsOfWork/core';

@Injectable()
export class NamedEntityRepository extends Repository<NamedEntityEntity, NamedEntity> {
  constructor(private readonly unitOfWorkService: CoreUnitOfWorkService) {
    super(unitOfWorkService, 'namedEntity', NamedEntityEntityMapper.getInstance());
  }

  // ============================================
  // Custom Query Methods
  // ============================================

  /**
   * Find all named entities for a context item
   */
  async findByContextItem(contextItemId: string): Promise<NamedEntityEntity[]> {
    const models = await (this as any).db.findMany({
      where: { contextItemId },
      orderBy: { startOffset: 'asc' },
    });

    return models.map((model: NamedEntity) => (this as any)._mapper.toDomainEntity(model));
  }

  /**
   * Find ALL named entities for a consultation (across every
   * ContextItem in it), WITH their transcript-span offsets + ontology codes.
   * Used by the SummaryProcessor to inject grounded NER into the LLM prompt.
   * Ordered by transcript span then in-source offset for stable citation order.
   */
  async findByConsultation(consultationId: string): Promise<NamedEntityEntity[]> {
    const models = await (this as any).db.findMany({
      where: { ContextItem: { consultationId } },
      orderBy: [{ transcriptStartOffset: 'asc' }, { startOffset: 'asc' }],
    });

    return models.map((model: NamedEntity) => (this as any)._mapper.toDomainEntity(model));
  }

  /**
   * Find named entities by class name
   */
  async findByClassName(contextItemId: string, className: string): Promise<NamedEntityEntity[]> {
    const models = await (this as any).db.findMany({
      where: { contextItemId, className },
      orderBy: { startOffset: 'asc' },
    });

    return models.map((model: NamedEntity) => (this as any)._mapper.toDomainEntity(model));
  }

  /**
   * Find high confidence entities (>= 0.8)
   */
  async findHighConfidence(contextItemId: string): Promise<NamedEntityEntity[]> {
    const models = await (this as any).db.findMany({
      where: {
        contextItemId,
        confidence: { gte: 0.8 },
      },
      orderBy: { confidence: 'desc' },
    });

    return models.map((model: NamedEntity) => (this as any)._mapper.toDomainEntity(model));
  }

  /**
   * Find medications for a context item
   */
  async findMedications(contextItemId: string): Promise<NamedEntityEntity[]> {
    return this.findByClassName(contextItemId, NamedEntityEntity.CLASS_MEDICATION);
  }

  /**
   * Find conditions for a context item
   */
  async findConditions(contextItemId: string): Promise<NamedEntityEntity[]> {
    return this.findByClassName(contextItemId, NamedEntityEntity.CLASS_CONDITION);
  }

  /**
   * Find procedures for a context item
   */
  async findProcedures(contextItemId: string): Promise<NamedEntityEntity[]> {
    return this.findByClassName(contextItemId, NamedEntityEntity.CLASS_PROCEDURE);
  }

  /**
   * Find anatomy entities for a context item
   */
  async findAnatomy(contextItemId: string): Promise<NamedEntityEntity[]> {
    return this.findByClassName(contextItemId, NamedEntityEntity.CLASS_ANATOMY);
  }

  /**
   * Find entities by text (case-insensitive search)
   */
  async findByText(text: string, limit: number = 100): Promise<NamedEntityEntity[]> {
    const models = await (this as any).db.findMany({
      where: {
        text: {
          contains: text,
          mode: 'insensitive',
        },
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });

    return models.map((model: NamedEntity) => (this as any)._mapper.toDomainEntity(model));
  }

  /**
   * Find entities by normalized text
   */
  async findByNormalizedText(normalizedText: string): Promise<NamedEntityEntity[]> {
    const models = await (this as any).db.findMany({
      where: { normalizedText },
      orderBy: { createdAt: 'desc' },
    });

    return models.map((model: NamedEntity) => (this as any)._mapper.toDomainEntity(model));
  }

  /**
   * Count entities by class for a context item
   */
  async countByClass(contextItemId: string): Promise<Record<string, number>> {
    const result = await (this as any).db.groupBy({
      by: ['className'],
      where: { contextItemId },
      _count: { className: true },
    });

    return result.reduce((acc: Record<string, number>, item: any) => {
      acc[item.className] = item._count.className;
      return acc;
    }, {});
  }

  /**
   * Find entities by AI model
   */
  async findByAiModel(aiModelId: string, limit: number = 100): Promise<NamedEntityEntity[]> {
    const models = await (this as any).db.findMany({
      where: { aiModelId },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });

    return models.map((model: NamedEntity) => (this as any)._mapper.toDomainEntity(model));
  }

  /**
   * Get average confidence by class for a context item
   */
  async getAverageConfidenceByClass(contextItemId: string): Promise<Record<string, number>> {
    const result = await (this as any).db.groupBy({
      by: ['className'],
      where: { contextItemId },
      _avg: { confidence: true },
    });

    return result.reduce((acc: Record<string, number>, item: any) => {
      acc[item.className] = item._avg.confidence ?? 0;
      return acc;
    }, {});
  }

  /**
   * Delete all entities for a context item
   */
  async deleteByContextItem(contextItemId: string): Promise<number> {
    const result = await (this as any).db.deleteMany({
      where: { contextItemId },
    });
    return result.count;
  }

  /**
   * Batch-insert NamedEntity rows in ONE `createMany` round trip (F-14 — the
   * harness NER persist path was previously one INSERT + one per-row Transit
   * encryption call per entity, every regen iteration). Entity ids are
   * pre-generated UUIDv7s from `NamedEntityFactory`, so `createMany` (which
   * never returns rows) loses nothing the caller needs — callers must still
   * encrypt each entity (`encryptFieldsIntoEntity`) BEFORE calling this, since
   * encryption happens per-entity and `createMany` only performs the final
   * batched SQL insert. `skipDuplicates: true` matches the base
   * `Repository.createMany` default. Accepts an optional transaction client,
   * mirroring the `tx?` contract on `Repository.create`/`updateWithVersion`.
   */
  async createMany(entities: NamedEntityEntity[], tx?: Prisma.TransactionClient | any): Promise<{ count: number }> {
    if (entities.length === 0) {
      return { count: 0 };
    }
    const mapper = (this as any)._mapper;
    const data = entities.map((entity) => removeNullValues(mapper.toPersistence(entity)));
    const delegate = tx ? (tx as Record<string, any>)[this._modelName] : (this as any).db;
    const result = await delegate.createMany({ data, skipDuplicates: true });
    return { count: result.count };
  }
}
