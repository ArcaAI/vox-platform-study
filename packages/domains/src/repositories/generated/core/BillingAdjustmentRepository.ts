import { Injectable } from '@nestjs/common';
import { Prisma } from '@arcaai/database';

import { Repository } from '../../../common';
import { CoreUnitOfWorkService } from '../../../common/unitsOfWork/core';
import { BillingAdjustmentEntity } from '../../../entities';
import { BillingAdjustmentEntityMapper } from '../../../mappers';
import { BillingAdjustment } from '../../../models';

/**
 * Credit/debit-memo repository — the ONLY correction path for a FINALIZED
 * period (D13).
 *
 * APPEND-ONLY: the model is in MODELS_WITHOUT_SOFT_DELETE and has no
 * `resourceStatus` column, so `softDelete()`/`restore()` throw. Retracting an
 * adjustment by deleting it would rewrite a closed period; the correction path
 * is another adjustment. Unlike the append-only models of the metering plane
 * this one DOES emit sys-events — issuing a credit is a financial control point.
 */
@Injectable()
export class BillingAdjustmentRepository extends Repository<BillingAdjustmentEntity, BillingAdjustment> {
  constructor(private readonly unitOfWorkService: CoreUnitOfWorkService) {
    super(unitOfWorkService, 'billingAdjustment', BillingAdjustmentEntityMapper.getInstance());
  }

  /**
   * Every adjustment against one invoice, oldest first.
   *
   * Ordered by `id` (UUIDv7 = creation order) so the running correction history
   * reads chronologically.
   */
  async findByInvoice(tenantId: string, invoiceId: string, tx?: Prisma.TransactionClient | any): Promise<BillingAdjustmentEntity[]> {
    const delegate = tx ? (tx as Record<string, any>).billingAdjustment : this.db;
    const models = await delegate.findMany({
      where: { tenantId, invoiceId },
      orderBy: [{ id: 'asc' }],
    });
    const mapper = BillingAdjustmentEntityMapper.getInstance();
    return models.map((model: BillingAdjustment) => mapper.toDomainEntity(model));
  }
}
