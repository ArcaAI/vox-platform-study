import { Module } from '@nestjs/common';
import { EntitlementsServiceModule } from '@arcaai/applications';
import { EntitlementsAdminController } from './entitlements-admin.controller';
import { MyEntitlementsController } from './my-entitlements.controller';

/**
 * Exposes the entitlements HTTP surface. Imports
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
