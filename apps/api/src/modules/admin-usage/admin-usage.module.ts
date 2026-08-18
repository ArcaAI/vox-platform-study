import { Module } from '@nestjs/common';
import { ShadowMeteringServiceModule, UsageAnalyticsServiceModule } from '@arcaai/applications';

import { AdminReconciliationController } from './admin-reconciliation.controller';
import { AdminUsageController } from './admin-usage.controller';
import { MyUsageRedirectShimController } from './my-usage-redirect.shim.controller';
import { MyUsageController } from './my-usage.controller';

/**
 * The usage-analytics HTTP surface: admin/global reads
 * (`/admin/usage/*`) and tenant self-service reads (`/usage/me/*`). All new
 * usage-analytics endpoints live HERE.
 */
@Module({
  imports: [UsageAnalyticsServiceModule, ShadowMeteringServiceModule],
  controllers: [AdminUsageController, AdminReconciliationController, MyUsageController, MyUsageRedirectShimController],
})
export class AdminUsageApiModule {}
