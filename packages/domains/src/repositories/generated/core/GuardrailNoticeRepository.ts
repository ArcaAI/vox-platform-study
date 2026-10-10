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
   * A repeat raise is a NO-OP that returns the stored row as it stands — an
   * acknowledged or resolved notice is never reset to OPEN by the next
   * live-summary re-screen.
   *
   * `created` comes from the INSERT's row count (`ON CONFLICT DO NOTHING`), never
   * from comparing ids: notice ids are deterministic (sha256(tenantId|dedupeKey),
   * or the producer's own id that is also its dedupe key), so a re-raise always
   * carries the stored row's id (TASK-1059 RC-8). Race-free: of two concurrent
   * raises exactly one inserts.
   */
  async upsertByDedupeKey(entity: GuardrailNoticeEntity, tx?: Prisma.TransactionClient | any): Promise<GuardrailNoticeUpsertResult> {
    const delegate = tx ? (tx as Record<string, any>).guardrailNotice : (this as any).db;
    const mapper = (this as any)._mapper as GuardrailNoticeEntityMapper;
    const create = removeNullValues(mapper.toPersistence(entity)) as Record<string, unknown>;
    const { count } = await delegate.createMany({ data: [create], skipDuplicates: true });
    const model = await delegate.findUnique({
      where: { tenantId_dedupeKey: { tenantId: entity.tenantId, dedupeKey: entity.dedupeKey } },
    });
    return { notice: mapper.toDomainEntity(model), created: count > 0 };
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
