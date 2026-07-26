import { CommonServiceModule, TenantSettingsService } from '@arcaai/applications';
import { Module } from '@nestjs/common';
import { PlatformKnobsBinder } from './platform-knobs.binder';

/**
 * Hosts `PlatformKnobsBinder` — the piece that makes the two PRE-BOOTSTRAP
 * platform knobs (`logLevel`, `corsAllowedOrigins`) live values rather than
 * deploy-time constants (TASK-558 lane I).
 *
 * `CommonServiceModule` supplies both dependencies: `IAppSettingsService` (which
 * `TenantSettingsService` reads) and `ILoggingService`.
 */
@Module({
  imports: [CommonServiceModule],
  providers: [TenantSettingsService, PlatformKnobsBinder],
  exports: [TenantSettingsService],
})
export class PlatformKnobsModule {}
