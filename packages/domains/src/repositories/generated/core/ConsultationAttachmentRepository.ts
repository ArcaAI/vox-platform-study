import { Injectable } from '@nestjs/common';
import { Prisma } from '@arcaai/database';

import { Repository } from '../../../common';
import { ConsultationAttachmentEntityMapper } from '../../../mappers';
import { ConsultationAttachmentEntity } from '../../../entities';
import { ConsultationAttachment } from '../../../models';
import { CoreUnitOfWorkService } from '../../../common/unitsOfWork/core';
import { ConsultationAttachmentPurpose, ConsultationAttachmentStatus, ResourceStatusType } from '../../../enums';

/** Rows one reaper call reads at most. */
const REAP_BATCH_LIMIT = 200;

/**
 * Consultation attachments (upload intents through READY / FAILED / EXPIRED).
 * Status moves that two actors can race — a late `complete` against the intent
 * reaper — go through {@link compareAndSetStatus}, a conditional update that
 * exactly one caller wins.
 */
@Injectable()
export class ConsultationAttachmentRepository extends Repository<ConsultationAttachmentEntity, ConsultationAttachment> {
  constructor(private readonly unitOfWorkService: CoreUnitOfWorkService) {
    super(unitOfWorkService, 'consultationAttachment', ConsultationAttachmentEntityMapper.getInstance());
  }

  /**
   * INTENT rows whose intent window closed before `now`, oldest first, capped
   * at `limit` (default 200). Cross-tenant: the reaper is a platform-wide tick.
   */
  async findReapable(now: Date, limit: number = REAP_BATCH_LIMIT): Promise<ConsultationAttachmentEntity[]> {
    return this.findAll({
      filters: {
        status: ConsultationAttachmentStatus.INTENT,
        intentExpiresAt: { lt: now },
        resourceStatus: ResourceStatusType.ENABLED,
      },
      sort: [{ intentExpiresAt: 'asc' }],
      page: 1,
      limit,
    });
  }

  /**
   * Move `id` to `to` only while its status is one of `from` (plus any extra
   * column writes). Bumps `_version` as a state stamp, like soft delete.
   * @returns `true` for the caller that won the move.
   */
  async compareAndSetStatus(
    id: string,
    from: ConsultationAttachmentStatus[],
    to: ConsultationAttachmentStatus,
    data: Record<string, unknown> = {},
    tx?: Prisma.TransactionClient | any,
  ): Promise<boolean> {
    const delegate = tx ? (tx as Record<string, any>).consultationAttachment : (this as any).db;
    const result = await delegate.updateMany({
      where: { id, status: { in: from } },
      data: { ...data, status: to, version: { increment: 1 } },
    });
    return result.count > 0;
  }

  /** INTENT → UPLOADED for the `complete` call; `false` when the reaper (or a replay) got there first. */
  async claimIntentToUploaded(id: string, tx?: Prisma.TransactionClient | any): Promise<boolean> {
    return this.compareAndSetStatus(id, [ConsultationAttachmentStatus.INTENT], ConsultationAttachmentStatus.UPLOADED, {}, tx);
  }

  /** INTENT → EXPIRED for the reaper; never touches an intent a `complete` already claimed. */
  async expireIntent(id: string, tx?: Prisma.TransactionClient | any): Promise<boolean> {
    return this.compareAndSetStatus(id, [ConsultationAttachmentStatus.INTENT], ConsultationAttachmentStatus.EXPIRED, {}, tx);
  }

  /** The intent an `Idempotency-Key` replay maps to, or `null`. */
  async findByIdempotencyKey(tenantId: string, consultationId: string, idempotencyKey: string): Promise<ConsultationAttachmentEntity | null> {
    const model = await (this as any).db.findFirst({ where: { tenantId, consultationId, idempotencyKey } });
    return model ? (this as any)._mapper.toDomainEntity(model) : null;
  }

  /** The attachment behind a batch transcription job, or `null`. */
  async findByTranscriptionJobId(transcriptionJobId: string): Promise<ConsultationAttachmentEntity | null> {
    const model = await (this as any).db.findFirst({ where: { transcriptionJobId, resourceStatus: ResourceStatusType.ENABLED } });
    return model ? (this as any)._mapper.toDomainEntity(model) : null;
  }

  /** The consultation's attachments in creation order, optionally of one purpose. */
  async findByConsultation(consultationId: string, purpose?: ConsultationAttachmentPurpose): Promise<ConsultationAttachmentEntity[]> {
    return this.findAll({
      filters: { consultationId, ...(purpose ? { purpose } : {}), resourceStatus: ResourceStatusType.ENABLED },
      sort: [{ createdAt: 'asc' }],
    });
  }
}
