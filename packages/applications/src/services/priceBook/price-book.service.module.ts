import { Module } from '@nestjs/common';
import { CoreDatabaseModule } from '@arcaai/domains';

import { IPriceBookService } from './IPriceBookService';
import { PriceBookService } from './price-book.service';

/**
 * Rate-card resolution.
 *
 * `CoreDatabaseModule` alone: the service resolves prices through
 * `AiPriceBookRepository` and needs nothing from `CommonServiceModule` — no
 * settings, no secrets, no Redis. Rating deliberately holds no cache (see
 * `price-book.service.ts`), so there is no cache-invalidation channel to wire
 * either.
 *
 * Exported token is consumed by the usage-ledger outbox drainer (COST plane)
 * and, later, by WS-I's invoice engine (SELL plane).
 */
@Module({
  imports: [CoreDatabaseModule],
  providers: [
    {
      provide: IPriceBookService,
      useClass: PriceBookService,
    },
  ],
  exports: [IPriceBookService],
})
export class PriceBookServiceModule {}
