import { Module } from '@nestjs/common';
import { BillingInvoiceLineWriteRepository, BillingUsageAggregateRepository, CoreDatabaseModule } from '@arcaai/domains';

import { PriceBookServiceModule } from '../priceBook/price-book.service.module';
import { BillingService } from './billing.service';
import { IBillingService } from './IBillingService';

/**
 * The invoice engine (TASK-615 WS-I).
 *
 * IMPORTS
 *   - `CoreDatabaseModule` — the generated repositories + `CoreUnitOfWorkService`.
 *   - `PriceBookServiceModule` — SELL-plane resolution (the same frozen WS-B
 *     surface the COST rater uses; two planes, one mechanism, D10).
 *
 * The two hand-written billing repository extensions live in
 * `packages/domains/src/repositories/billing/` (WS-I's lane) and are PROVIDED
 * HERE rather than in `CoreDatabaseModule` — that module is another lane's
 * file mid-wave, and these classes only need `CoreUnitOfWorkService`, which
 * `CoreDatabaseModule` exports. Fold them into the shared module in a
 * follow-up if a second consumer appears.
 */
@Module({
  imports: [CoreDatabaseModule, PriceBookServiceModule],
  providers: [
    BillingUsageAggregateRepository,
    BillingInvoiceLineWriteRepository,
    {
      provide: IBillingService,
      useClass: BillingService,
    },
  ],
  exports: [IBillingService],
})
export class BillingServiceModule {}
