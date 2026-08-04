import { ILoggingService, IOriginRegistry, LogLevel, TenantSettingsService } from '@arcaai/applications';
import { Inject, Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { setOriginRegistryResolver } from '../../cors.config';

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
    @Optional() @Inject(IOriginRegistry) private readonly originRegistry?: IOriginRegistry,
  ) {}

  onModuleInit(): void {
    this.installOriginRegistryResolver();

    if (!this.tenantSettings) {
      this.logger.debug('No settings resolver wired — platform knobs stay on their env bootstrap values');
      return;
    }
    this.applyLogLevel();
  }

  /**
   * TASK-610 — hand the origin REGISTRY to the pre-bootstrap CORS code.
   *
   * This replaces the `corsAllowedOrigins` string resolver TASK-558 lane I
   * installed here. Allowed origins are `TenantAllowedOrigin` rows now, so the
   * lazily-resolved thing is the reverse index rather than a comma-separated
   * setting; `CORS_ALLOWED_ORIGINS` survives only as the bootstrap fallback
   * inside `cors.config.ts` (FR-6).
   *
   * WHY THE EMPTY INDEX IS REPORTED AS `null`. `OriginIndexResolver` returning
   * `null` means "the registry has not loaded" and sends `isOriginAllowed` to
   * that bootstrap fallback. `OriginRegistryService.refresh()` deliberately
   * does NOT throw when the database is unreachable — it keeps its previous
   * index, which at boot is empty. Reporting that empty index as a loaded
   * registry would refuse every browser origin on the platform for as long as
   * the database stayed down. An unseeded table behaves the same way and wants
   * the same answer (plan §3.8). Once even one row exists, the registry is
   * authoritative and a miss is a refusal.
   *
   * Resolution is lazy (per request), so installing the accessor once is
   * enough — a row added later is picked up on the registry's next refresh
   * with no restart and no re-install here.
   */
  private installOriginRegistryResolver(): void {
    if (!this.originRegistry) {
      this.logger.warn('No origin registry wired — CORS stays on the CORS_ALLOWED_ORIGINS bootstrap allow-list');
      return;
    }
    const registry = this.originRegistry;
    setOriginRegistryResolver(() => (registry.size() > 0 ? registry : null));
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
