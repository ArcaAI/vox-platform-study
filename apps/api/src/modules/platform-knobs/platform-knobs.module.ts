import { CommonServiceModule, OriginRegistryServiceModule, TenantSettingsService } from '@arcaai/applications';
import { Module } from '@nestjs/common';
import { PlatformKnobsBinder } from './platform-knobs.binder';

/**
 * Hosts `PlatformKnobsBinder` — the piece that makes the PRE-BOOTSTRAP platform
 * knobs live values rather than deploy-time constants (TASK-558 lane I).
 *
 * `CommonServiceModule` supplies `IAppSettingsService` (which
 * `TenantSettingsService` reads) and `ILoggingService`.
 *
 * `OriginRegistryServiceModule` (TASK-610) supplies `IOriginRegistry`, which the
 * binder installs into `cors.config.ts` as the per-request origin resolver.
 * This import is LOAD-BEARING and its absence is SILENT: the binder injects the
 * registry `@Optional()`, so without it the gateway boots, serves, and denies
 * EVERY browser origin forever (TASK-610 §4A.1 removed the `CORS_ALLOWED_ORIGINS`
 * env fallback this used to degrade to) — i.e. the entire allow-list feature
 * does nothing while looking installed. The binder logs `No origin registry
 * wired` in that state; that warning is the tripwire.
 */
@Module({
  imports: [CommonServiceModule, OriginRegistryServiceModule],
  providers: [TenantSettingsService, PlatformKnobsBinder],
  exports: [TenantSettingsService],
})
export class PlatformKnobsModule {}
