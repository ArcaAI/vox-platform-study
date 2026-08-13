import { Module } from '@nestjs/common';
import { BillingServiceModule, SellRateCardServiceModule } from '@arcaai/applications';

import { BillingAdminController } from './billing-admin.controller';
import { MyBillingController } from './my-billing.controller';
import { RateCardAdminController } from './rate-card-admin.controller';

/**
 * The billing HTTP surface: SELL rate-card administration,
 * invoice lifecycle (draft → finalize → credit memos), and tenant self-service
 * reads. All new billing endpoints live HERE.
 */
@Module({
  imports: [BillingServiceModule, SellRateCardServiceModule],
  controllers: [RateCardAdminController, BillingAdminController, MyBillingController],
})
export class BillingApiModule {}
