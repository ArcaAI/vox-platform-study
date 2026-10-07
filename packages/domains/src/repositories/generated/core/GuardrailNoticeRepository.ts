import { Injectable } from '@nestjs/common';
import { Prisma } from '@arcaai/database';

import { Repository } from '../../../common';
import { removeNullValues } from '../../../common/removeNullValues';
import { GuardrailNoticeEntityMapper } from '../../../mappers';
import { GuardrailNoticeEntity } from '../../../entities';
import { GuardrailNotice } from '../../../models';
import { CoreUnitOfWorkService } from '../../../common/unitsOfWork/core';
import { GuardrailNoticeStatus } from '../../../enums';

/** Outcome of {@link GuardrailNoticeRepository.upsertByDedupeKey}. */
export interface GuardrailNoticeUpsertResult {
  /** The stored notice: the new row, or the one already raised under the dedupe key. */
  notice: GuardrailNoticeEntity;
  /** `true` only when this call inserted the row — emit the client notice only then. */
  created: boolean;
}

/**
 * TASK-1050 — the standard client notices (§9.7.3). No soft delete: a notice
 * moves OPEN → ACKNOWLEDGED → RESOLVED through its own `status`. OCC-written:
 * acknowledge / resolve go through `updateWithVersion`.
 */
@Injectable()
export class GuardrailNoticeRepository extends Repository<GuardrailNoticeEntity, GuardrailNotice> {
  constructor(private readonly unitOfWorkService: CoreUnitOfWorkService) {
    super(unitOfWorkService, 'guardrailNotice', GuardrailNoticeEntityMapper.getInstance());
  }

  /**
   * Insert the notice unless one with the same `(tenantId, dedupeKey)` exists.
   * A repeat raise is a NO-OP (`update: {}`) that returns the stored row as it
   * stands — an acknowledged or resolved notice is never reset to OPEN by the
   * next live-summary re-screen.
   */
  async upsertByDedupeKey(entity: GuardrailNoticeEntity, tx?: Prisma.TransactionClient | any): Promise<GuardrailNoticeUpsertResult> {
    const delegate = tx ? (tx as Record<string, any>).guardrailNotice : (this as any).db;
    const mapper = (this as any)._mapper as GuardrailNoticeEntityMapper;
    const create = removeNullValues(mapper.toPersistence(entity)) as Record<string, unknown>;
    const model = await delegate.upsert({
      where: { tenantId_dedupeKey: { tenantId: entity.tenantId, dedupeKey: entity.dedupeKey } },
      create,
      update: {},
    });
    return { notice: mapper.toDomainEntity(model), created: model.id === entity.id };
  }

  /** The consultation's OPEN notices, oldest first. */
  async findOpenByConsultation(tenantId: string, consultationId: string): Promise<GuardrailNoticeEntity[]> {
    const models = await (this as any).db.findMany({
      where: { tenantId, consultationId, status: GuardrailNoticeStatus.OPEN },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    return models.map((model: GuardrailNotice) => (this as any)._mapper.toDomainEntity(model));
  }
}
