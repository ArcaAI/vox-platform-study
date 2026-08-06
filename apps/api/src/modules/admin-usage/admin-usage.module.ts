import { Module } from '@nestjs/common';
import { UsageAnalyticsServiceModule } from '@arcaai/applications';

import { AdminUsageController } from './admin-usage.controller';
import { MyUsageController } from './my-usage.controller';

/**
 * The usage-analytics HTTP surface (TASK-615 WS-J): admin/global reads
 * (`/admin/usage/*`) and tenant self-service reads (`/usage/me/*`). All new
 * usage-analytics endpoints live HERE.
 */
@Module({
  imports: [UsageAnalyticsServiceModule],
  controllers: [AdminUsageController, MyUsageController],
})
export class AdminUsageApiModule {}
