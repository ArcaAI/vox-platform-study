import { Module } from '@nestjs/common';
import { EntitlementsServiceModule } from '@arcaai/applications';
import { EntitlementsAdminController } from './entitlements-admin.controller';
import { MyEntitlementsController } from './my-entitlements.controller';

/**
 * TASK-392 (Phase 4) — exposes the entitlements HTTP surface. Imports
 * `EntitlementsServiceModule` for `IEntitlementsService` (resolution + matrix /
 * override CRUD + kill-switch) and `IEntitlementsLifecycleService` (trial-expiry
 * sweep + explicit downgrade soft-disable). All new entitlements endpoints live
 * HERE — never in `tenant.controller.ts`.
 */
@Module({
  imports: [EntitlementsServiceModule],
  controllers: [EntitlementsAdminController, MyEntitlementsController],
})
export class EntitlementsApiModule {}
