import { Injectable } from '@nestjs/common';
import { Prisma } from '@arcaai/database';

import { Repository } from '../../../common';
import { ConsultationEncounterEntityMapper } from '../../../mappers';
import { ConsultationEncounterEntity } from '../../../entities';
import { ConsultationEncounter } from '../../../models';
import { CoreUnitOfWorkService } from '../../../common/unitsOfWork/core';

/**
 * Encounters (visits) of a consultation. Tenant-scoped, no soft delete
 * (MODELS_WITHOUT_SOFT_DELETE): an encounter lives and dies with its
 * consultation. `(consultationId, seq)` is unique; `(consultationId,
 * externalRef)` is unique where a ref is set (partial index).
 */
@Injectable()
export class ConsultationEncounterRepository extends Repository<ConsultationEncounterEntity, ConsultationEncounter> {
  constructor(private readonly unitOfWorkService: CoreUnitOfWorkService) {
    super(unitOfWorkService, 'consultationEncounter', ConsultationEncounterEntityMapper.getInstance());
  }

  /** Every encounter of the consultation in `seq` order. */
  async findByConsultation(consultationId: string): Promise<ConsultationEncounterEntity[]> {
    const models = await (this as any).db.findMany({ where: { consultationId }, orderBy: [{ seq: 'asc' }] });
    return models.map((model: ConsultationEncounter) => (this as any)._mapper.toDomainEntity(model));
  }

  /** One encounter by its seq, or `null`. */
  async findBySeq(consultationId: string, seq: number): Promise<ConsultationEncounterEntity | null> {
    const model = await (this as any).db.findFirst({ where: { consultationId, seq } });
    return model ? (this as any)._mapper.toDomainEntity(model) : null;
  }

  /**
   * Every encounter of the tenant carrying the caller's visit id, newest
   * first, WITH its consultation — the open key matches its own (patient,
   * doctor) out of this set and must also see a same-ref encounter of another
   * patient to refuse it.
   */
  async findByExternalRef(tenantId: string, externalRef: string): Promise<ConsultationEncounterEntity[]> {
    const models = await (this as any).db.findMany({
      where: { tenantId, externalRef },
      include: { Consultation: true },
      orderBy: [{ createdAt: 'desc' }],
    });
    return models.map((model: ConsultationEncounter) => (this as any)._mapper.toDomainEntity(model));
  }

  /**
   * End an encounter that is still open (`endedAt` null), optionally closing
   * its recording span.
   * @returns `true` when this call ended it.
   */
  async endEncounter(
    consultationId: string,
    seq: number,
    end: { endedAt?: Date; recordingEndMs?: number | null } = {},
    tx?: Prisma.TransactionClient | any,
  ): Promise<boolean> {
    const delegate = tx ? (tx as Record<string, any>).consultationEncounter : (this as any).db;
    const data: Record<string, unknown> = { endedAt: end.endedAt ?? new Date() };
    if (end.recordingEndMs !== undefined) data.recordingEndMs = end.recordingEndMs;
    const result = await delegate.updateMany({ where: { consultationId, seq, endedAt: null }, data });
    return result.count > 0;
  }
}
