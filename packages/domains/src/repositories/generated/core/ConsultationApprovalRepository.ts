import { Injectable } from '@nestjs/common';

import { Repository } from '../../../common';
import { ConsultationApprovalEntityMapper } from '../../../mappers';
import { ConsultationApprovalEntity } from '../../../entities';
import { ConsultationApproval } from '../../../models';
import { CoreUnitOfWorkService } from '../../../common/unitsOfWork/core';

/**
 * Immutable approval snapshots. Create-only: a trigger in the migration
 * refuses UPDATE and DELETE, so the inherited update / delete paths must never
 * be used on this repository. Tenant-scoped, no soft delete.
 */
@Injectable()
export class ConsultationApprovalRepository extends Repository<ConsultationApprovalEntity, ConsultationApproval> {
  constructor(private readonly unitOfWorkService: CoreUnitOfWorkService) {
    super(unitOfWorkService, 'consultationApproval', ConsultationApprovalEntityMapper.getInstance());
  }

  /** Every approval of the consultation, newest first. */
  async findByConsultation(consultationId: string): Promise<ConsultationApprovalEntity[]> {
    const models = await (this as any).db.findMany({ where: { consultationId }, orderBy: [{ approvedAt: 'desc' }] });
    return models.map((model: ConsultationApproval) => (this as any)._mapper.toDomainEntity(model));
  }

  /** The newest approval of the consultation, or `null`. */
  async findLatestByConsultation(consultationId: string): Promise<ConsultationApprovalEntity | null> {
    const model = await (this as any).db.findFirst({ where: { consultationId }, orderBy: [{ approvedAt: 'desc' }] });
    return model ? (this as any)._mapper.toDomainEntity(model) : null;
  }

  /** The newest approval of each consultation in the set (a list page), from ONE query. */
  async findLatestByConsultations(consultationIds: string[]): Promise<Map<string, ConsultationApprovalEntity>> {
    const latest = new Map<string, ConsultationApprovalEntity>();
    const ids = [...new Set(consultationIds)];
    if (ids.length === 0) return latest;
    const models = await (this as any).db.findMany({ where: { consultationId: { in: ids } }, orderBy: [{ approvedAt: 'desc' }] });
    for (const model of models as ConsultationApproval[]) {
      if (!latest.has(model.consultationId)) latest.set(model.consultationId, (this as any)._mapper.toDomainEntity(model));
    }
    return latest;
  }
}
