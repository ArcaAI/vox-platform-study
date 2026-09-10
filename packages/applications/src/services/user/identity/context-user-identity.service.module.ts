import { Module } from '@nestjs/common';
import { CoreDatabaseModule } from '@arcaai/domains';
import { CommonServiceModule } from '../../baseServices';
import { EntitlementsServiceModule } from '../../entitlements/entitlements.service.module';
import { EffectiveSettingsModule } from '../../settings-registry/effective-settings.module';
import { ContextUserIdentityService } from './context-user-identity.service';
import { IContextUserIdentityService } from './IContextUserIdentityService';

/**
 * TASK-950 — DI for the context-schema identity resolver.
 *
 * Imported by every plane that can carry a user-identity field (consultation open, agent
 * invocation, workflow run); each injects `IContextUserIdentityService` and nothing else.
 *
 * · `CoreDatabaseModule`     — the four repositories plus `CORE_DATABASE_SERVICE` (the base
 *                              client, needed for `$transaction` AND for the `$executeRaw`
 *                              advisory lock).
 * · `EffectiveSettingsModule`— `EffectiveSettingsService`, the tenant → SYSTEM cascade for the
 *                              three `identity.autoProvision.*` keys.
 * · `EntitlementsServiceModule` — the `maxUsers` seat quota. Injected `@Optional()` in the
 *                              service (append-only DI), but imported here so the wired
 *                              gateway graph ENFORCES it: a machine plane that could mint
 *                              unbilled users would be a hole in the entitlement.
 * · `CommonServiceModule`    — the usual config/redis/observability floor every service module
 *                              carries.
 */
@Module({
  imports: [CommonServiceModule, CoreDatabaseModule, EffectiveSettingsModule, EntitlementsServiceModule],
  providers: [
    {
      provide: IContextUserIdentityService,
      useClass: ContextUserIdentityService,
    },
  ],
  exports: [IContextUserIdentityService],
})
export class ContextUserIdentityServiceModule {}
