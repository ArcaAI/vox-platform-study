// TASK-610 §4.1 — OriginRegistryService module (lane W2-A).
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
    {
      provide: IOriginRegistry,
      useClass: OriginRegistryService,
    },
    OriginRegistryService,
  ],
  exports: [IOriginRegistry, OriginRegistryService],
})
export class OriginRegistryServiceModule {}
