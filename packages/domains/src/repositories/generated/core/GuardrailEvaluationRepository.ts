import { Injectable } from '@nestjs/common';
import { Prisma } from '@arcaai/database';

import { Repository } from '../../../common';
import { removeNullValues } from '../../../common/removeNullValues';
import { GuardrailEvaluationEntityMapper } from '../../../mappers';
import { GuardrailEvaluationEntity } from '../../../entities';
import { GuardrailEvaluation } from '../../../models';
import { CoreUnitOfWorkService } from '../../../common/unitsOfWork/core';

/** Outcome of {@link GuardrailEvaluationRepository.createManyIdempotent}. */
export interface GuardrailEvaluationBatchResult {
  /** Rows this call inserted. */
  inserted: number;
  /** Rows already stored under the same `evaluationId` (a redriven outbox batch). */
  duplicates: number;
}

/**
 * TASK-1050 — guardrail evaluations (§9.8.2). Append-only audit facts: no soft
 * delete, no update path. Writes are idempotent on the caller-supplied `id`
 * (the `evaluationId`) via {@link createManyIdempotent}, which is what makes
 * guardrail's at-least-once outbox safe to redrive.
 */
@Injectable()
export class GuardrailEvaluationRepository extends Repository<GuardrailEvaluationEntity, GuardrailEvaluation> {
  constructor(private readonly unitOfWorkService: CoreUnitOfWorkService) {
    super(unitOfWorkService, 'guardrailEvaluation', GuardrailEvaluationEntityMapper.getInstance());
  }

  /**
   * Insert a batch in ONE `createMany` with `skipDuplicates`: an id already
   * stored is skipped, never an error. Pass `tx` to write in the same
   * transaction as the notices and item marking derived from the batch.
   */
  async createManyIdempotent(entities: GuardrailEvaluationEntity[], tx?: Prisma.TransactionClient | any): Promise<GuardrailEvaluationBatchResult> {
    if (entities.length === 0) return { inserted: 0, duplicates: 0 };
    const delegate = tx ? (tx as Record<string, any>).guardrailEvaluation : (this as any).db;
    const mapper = (this as any)._mapper as GuardrailEvaluationEntityMapper;
    const data = entities.map((entity) => removeNullValues(mapper.toPersistence(entity)));
    const { count } = await delegate.createMany({ data, skipDuplicates: true });
    return { inserted: count, duplicates: entities.length - count };
  }

  /** Every evaluation of a consultation in evaluation order. */
  async findByConsultation(tenantId: string, consultationId: string): Promise<GuardrailEvaluationEntity[]> {
    const models = await (this as any).db.findMany({
      where: { tenantId, consultationId },
      orderBy: [{ at: 'asc' }, { id: 'asc' }],
    });
    return models.map((model: GuardrailEvaluation) => (this as any)._mapper.toDomainEntity(model));
  }
}
