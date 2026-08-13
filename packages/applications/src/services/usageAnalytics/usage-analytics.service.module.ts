import { Module } from '@nestjs/common';
import { CoreDatabaseModule, UsageAnalyticsAggregateRepository } from '@arcaai/domains';

import { IUsageAnalyticsService } from './IUsageAnalyticsService';
import { UsageAnalyticsService } from './usage-analytics.service';

/**
 * Read-only usage-analytics surface.
 *
 * `CoreDatabaseModule` supplies the generated rollup repositories +
 * `TenantRepository`/`PlanEntitlementRepository`/`TenantEntitlementRepository`
 * + `CoreUnitOfWorkService`. The hand-written `UsageAnalyticsAggregateRepository`
 * is PROVIDED HERE (same rationale as 's `BillingServiceModule`: it only
 * needs `CoreUnitOfWorkService`, which `CoreDatabaseModule` already exports —
 * fold it into the shared module in a follow-up if a second consumer appears).
 */
@Module({
  imports: [CoreDatabaseModule],
  providers: [
    UsageAnalyticsAggregateRepository,
    {
      provide: IUsageAnalyticsService,
      useClass: UsageAnalyticsService,
    },
  ],
  exports: [IUsageAnalyticsService],
})
export class UsageAnalyticsServiceModule {}
