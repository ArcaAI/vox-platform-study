import { ILoggingService, LogLevel, TenantSettingsService } from '@arcaai/applications';
import { Inject, Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { setPlatformCorsOriginsResolver } from '../../cors.config';

/**
 * Applies the two PRE-BOOTSTRAP platform knobs TASK-558 lane I moved into the
 * database — `logLevel` and `corsAllowedOrigins`.
 *
 * WHY A BINDER AND NOT A PLAIN READ. Both values are consumed before the Nest
 * module graph exists: `LOG_LEVEL` seeds the Nest logger inside
 * `NestFactory.create()`, and `getCorsOrigins()` is chosen in `main.ts`. Neither
 * reader can inject a provider, so the env value stays the BOOTSTRAP value and
 * this binder takes over the moment the graph is up:
 *
 *   • log level  — pushed into `ILoggingService.setLevel`, so raising verbosity
 *     during an incident is a settings write, not a redeploy;
 *   • CORS       — the allow-list is consulted inside the per-request origin
 *     callback, so installing a resolver is enough to make the DB value live.
 *
 * It re-applies on `app-settings.cache-refreshed`, which `AppSettingsService`
 * emits after every refresh — including the one driven by the
 * `app-settings:invalidate` fan-out lane G proved end to end. Propagation is
 * therefore push, not poll (§9.2 L4).
 *
 * Both dependencies are `@Optional()` so a graph that wires neither still boots
 * with the exact env-driven behaviour.
 */
@Injectable()
export class PlatformKnobsBinder implements OnModuleInit {
  private readonly logger = new Logger(PlatformKnobsBinder.name);

  /** The level last pushed, so a no-op refresh does not log. */
  private appliedLogLevel: string | null = null;

  constructor(
    @Optional() private readonly tenantSettings?: TenantSettingsService,
    @Optional() @Inject(ILoggingService) private readonly loggingService?: ILoggingService,
  ) {}

  onModuleInit(): void {
    if (!this.tenantSettings) {
      this.logger.debug('No settings resolver wired — platform knobs stay on their env bootstrap values');
      return;
    }
    // The CORS lane resolves lazily per request, so installing the accessor
    // once is enough: a later settings write is picked up automatically.
    setPlatformCorsOriginsResolver(() => {
      const resolved = this.tenantSettings!.resolvePlatform<unknown>('corsAllowedOrigins').value;
      if (typeof resolved === 'string') return resolved;
      if (Array.isArray(resolved)) return resolved.join(',');
      return undefined;
    });
    this.applyLogLevel();
  }

  /** Re-apply after every settings-cache refresh (local write or peer invalidation). */
  @OnEvent('app-settings.cache-refreshed')
  onSettingsRefreshed(): void {
    this.applyLogLevel();
  }

  private applyLogLevel(): void {
    if (!this.tenantSettings || !this.loggingService) return;
    try {
      const resolved = this.tenantSettings.resolvePlatform<unknown>('logLevel').value;
      if (typeof resolved !== 'string' || resolved === this.appliedLogLevel) return;
      this.loggingService.setLevel(resolved as LogLevel);
      this.appliedLogLevel = resolved;
      this.logger.log({ message: 'Applied platform log level from settings', logLevel: resolved });
    } catch (error) {
      // A knob binder must never be able to stop the gateway from serving.
      this.logger.warn({
        message: 'Failed to apply platform log level — keeping the bootstrap value',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
