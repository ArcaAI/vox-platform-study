import { Module } from '@nestjs/common';
import { CoreDatabaseModule } from '@arcaai/domains';

import { ISellRateCardService } from './ISellRateCardService';
import { SellRateCardService } from './sell-rate-card.service';

/**
 * SELL rate-card administration (TASK-615 WS-I).
 *
 * `CoreDatabaseModule` supplies `AiPriceBookRepository` + `CoreUnitOfWorkService`
 * (the atomic close+insert supersede). Deliberately separate from
 * `PriceBookServiceModule`: resolution (WS-B's frozen read surface, consumed by
 * the outbox drainer AND the invoice engine) and administration (GLOBAL_ADMIN
 * mutation with sys-events) change for different reasons.
 */
@Module({
  imports: [CoreDatabaseModule],
  providers: [
    {
      provide: ISellRateCardService,
      useClass: SellRateCardService,
    },
  ],
  exports: [ISellRateCardService],
})
export class SellRateCardServiceModule {}
