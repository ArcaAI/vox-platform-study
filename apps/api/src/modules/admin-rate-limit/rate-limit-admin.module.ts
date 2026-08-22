import { Module } from '@nestjs/common';
import { EntitlementsServiceModule, RateLimitServiceModule } from '@arcaai/applications';
import { RateLimitAdminController } from './rate-limit-admin.controller';
import { RouteCatalogService } from '../throttle/route-catalog.service';

/**
 * Exposes the system-admin rate-limit endpoints. Imports
 * `RateLimitServiceModule` for `IRateLimitAdminService` (write path +
 * `getPolicy`).
 */
@Module({
  // `EntitlementsServiceModule` supplies `IEntitlementsService` for the plan
  // projection (rank 3) — `RateLimitServiceModule` imports it but does not
  // re-export its token.
  imports: [RateLimitServiceModule, EntitlementsServiceModule],
  controllers: [RateLimitAdminController],
  // The route catalog is built from the module container at boot and is only
  // consumed by this controller, so it is provided here rather than globally.
  providers: [RouteCatalogService],
})
export class RateLimitAdminModule {}
