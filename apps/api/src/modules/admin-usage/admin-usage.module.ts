import { Module } from '@nestjs/common';
import { ShadowMeteringServiceModule, UsageAnalyticsServiceModule } from '@arcaai/applications';

import { AdminUsageController } from './admin-usage.controller';
import { MyUsageRedirectShimController } from './my-usage-redirect.shim.controller';
import { MyUsageController } from './my-usage.controller';

/**
 * The usage-analytics HTTP surface: admin/global reads
 * (`/admin/usage/*`) and tenant self-service reads (`/usage/me/*`). All new
 * usage-analytics endpoints live HERE.
 *
 * `ShadowMeteringServiceModule` stays imported even though TASK-862 deleted
 * the only controller that called it (`AdminReconciliationController`, gone
 * with Provider Reconciliation): the module is what registers the
 * self-scheduling shadow-metering sweep, and this is its sole import site.
 */
@Module({
  imports: [UsageAnalyticsServiceModule, ShadowMeteringServiceModule],
  controllers: [AdminUsageController, MyUsageController, MyUsageRedirectShimController],
})
export class AdminUsageApiModule {}
