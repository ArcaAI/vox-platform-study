import { Injectable } from '@nestjs/common';
import { Prisma } from '@arcaai/database';

import { Repository } from '../../../common';
import { CoreUnitOfWorkService } from '../../../common/unitsOfWork/core';
import { BillingInvoiceLineEntity } from '../../../entities';
import { BillingInvoiceLineEntityMapper } from '../../../mappers';
import { BillingInvoiceLine } from '../../../models';

/**
 * Invoice-line repository.
 *
 * Lines are written as part of the INVOICE aggregate — the draft-computation
 * service creates the invoice and its lines inside one transaction, which is why
 * every method here accepts a transaction client. They emit no sys-event of
 * their own (the invoice's covers them) but keep the standard soft-delete
 * lifecycle, since a draft is recomputed by superseding its lines.
 */
@Injectable()
export class BillingInvoiceLineRepository extends Repository<BillingInvoiceLineEntity, BillingInvoiceLine> {
  constructor(private readonly unitOfWorkService: CoreUnitOfWorkService) {
    super(unitOfWorkService, 'billingInvoiceLine', BillingInvoiceLineEntityMapper.getInstance());
  }

  /**
   * Every line of one invoice, in insertion order.
   *
   * Ordered by `id` — a UUIDv7, so id order IS creation order. That keeps the
   * rendered invoice stable across reads without adding a sequence column.
   */
  async findByInvoice(tenantId: string, invoiceId: string, tx?: Prisma.TransactionClient | any): Promise<BillingInvoiceLineEntity[]> {
    const delegate = tx ? (tx as Record<string, any>).billingInvoiceLine : this.db;
    const models = await delegate.findMany({
      where: { tenantId, invoiceId },
      orderBy: [{ id: 'asc' }],
    });
    const mapper = BillingInvoiceLineEntityMapper.getInstance();
    return models.map((model: BillingInvoiceLine) => mapper.toDomainEntity(model));
  }
}
