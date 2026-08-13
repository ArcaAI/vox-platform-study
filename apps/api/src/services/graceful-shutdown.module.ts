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
  // `global-kv` cascade for `shutdown.*`.
  imports: [CommonServiceModule],
  providers: [
    TenantSettingsService,
    GracefulShutdownService,
    {
      provide: IGracefulShutdownService,
      // useExisting, not useClass — useClass CONSTRUCTS A SECOND INSTANCE
      // rather than aliasing the one above. This service holds mutable
      // shutdown state (`_isReady`, `_isShuttingDown`, the
      // `cleanupCallbacks` map) and implements four lifecycle hooks
      // (OnModuleInit/OnModuleDestroy/BeforeApplicationShutdown/
      // OnApplicationShutdown) — real state that a second instance would
      // NOT share.
      //
      // With `useClass` there were two live coordinators, injected via two
      // different tokens at two different call sites: `main.ts` resolves
      // the bare `GracefulShutdownService` class token, while
      // `health.controller.ts` injects `IGracefulShutdownService`. Any
      // caller that registers a cleanup callback on one token's instance
      // would have it silently absent from the other instance's
      // `cleanupCallbacks` map — exactly the split-brain state this module
      // exists to prevent.
      //
      // `useExisting` makes the symbol an alias: one instance, one
      // `_isReady`/`_isShuttingDown` pair, one cleanup-callback registry.
      useExisting: GracefulShutdownService,
    },
  ],
  exports: [IGracefulShutdownService, GracefulShutdownService],
})
export class GracefulShutdownModule {}
