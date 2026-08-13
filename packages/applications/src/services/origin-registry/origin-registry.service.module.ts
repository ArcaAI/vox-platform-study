// OriginRegistryService module.
//
// `EventEmitterModule.forRoot()` is registered once, globally, in
// `apps/api/src/app.module.ts` (`@nestjs/event-emitter`'s `forRoot()` marks
// itself `@Global()`) — this module does not import it again. Only
// `CoreDatabaseModule` is needed, for `TenantAllowedOriginRepository`.

import { Module } from '@nestjs/common';
import { CoreDatabaseModule } from '@arcaai/domains';
import { IOriginRegistry } from './IOriginRegistry';
import { OriginRegistryService } from './origin-registry.service';

@Module({
  imports: [CoreDatabaseModule],
  providers: [
    OriginRegistryService,
    {
      provide: IOriginRegistry,
      // `useExisting`, NOT `useClass`. `useClass` CONSTRUCTS A SECOND INSTANCE
      // rather than aliasing the one above — and this service is stateful
      // (`index`, `patterns`, `lastSuccessfulRefreshAt`) and self-scheduling.
      //
      // With `useClass` there were two live registries. Both ran
      // `onModuleInit`, both answered `@OnEvent('app-settings.cache-refreshed')`,
      // so every settings refresh did TWO full table scans (visible as paired
      // refresh log lines one millisecond apart). Only the SYMBOL instance is
      // ever injected — `cors.config`, the binding guard and the WS gateway all
      // resolve `IOriginRegistry` — so the second index was read by nobody.
      //
      // The dangerous part was the `@Cron` backstop: it registers under the
      // fixed name `origin-registry-backstop-refresh`, and two instances cannot
      // both hold it. Whichever registered first won. If that was the phantom,
      // the watchdog whose entire purpose is to bound how long a REVOKED origin
      // stays live was refreshing an index no request path reads — a staleness
      // guarantee that silently did nothing.
      //
      // `useExisting` makes the symbol an alias: one instance, one timer, one
      // index.
      useExisting: OriginRegistryService,
    },
  ],
  exports: [IOriginRegistry, OriginRegistryService],
})
export class OriginRegistryServiceModule {}
