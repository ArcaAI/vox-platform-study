import { CommonServiceModule, TenantSettingsService } from '@arcaai/applications';
import { Global, Module } from '@nestjs/common';
import { GracefulShutdownService, IGracefulShutdownService } from './graceful-shutdown.service';

/**
 * GracefulShutdownModule
 *
 * Global module that provides graceful shutdown coordination across the application.
 * Being a global module, it can be injected anywhere without explicit imports.
 */
@Global()
@Module({
  // `CommonServiceModule` supplies `IAppSettingsService`, which backs the
  // `global-kv` cascade for `shutdown.*` (TASK-558 lane I).
  imports: [CommonServiceModule],
  providers: [
    TenantSettingsService,
    {
      provide: IGracefulShutdownService,
      useClass: GracefulShutdownService,
    },
    GracefulShutdownService,
  ],
  exports: [IGracefulShutdownService, GracefulShutdownService],
})
export class GracefulShutdownModule {}
