import { ILoggingService, IOriginRegistry, LogLevel, TenantSettingsService } from '@arcaai/applications';
import { Inject, Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { setOriginRegistryResolver } from '../../cors.config';

/**
 * Applies the two PRE-BOOTSTRAP platform knobs whose readers exist before the
 * Nest module graph does: the `logLevel` GlobalSetting (TASK-558 lane I), and
 * the CORS origin registry resolver (TASK-610). They are no longer the same
 * KIND of knob — `logLevel` is still a `GlobalSetting`-backed value with an
 * env bootstrap default; CORS has no knob and no env fallback at all since
 * §4A.1, only the `TenantAllowedOrigin`-backed registry described below.
 *
 * WHY A BINDER AND NOT A PLAIN READ. Both are consumed before the Nest module
 * graph exists: `LOG_LEVEL` seeds the Nest logger inside `NestFactory.create()`,
 * and `getCorsOrigins()` is chosen in `main.ts`. Neither reader can inject a
 * provider, so this binder takes over the moment the graph is up:
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
 * Both dependencies are `@Optional()` so a graph that wires neither still
 * boots — `logLevel` on its env-seeded default, CORS denying every browser
 * origin until a registry is wired (see `installOriginRegistryResolver`).
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
   * setting. There is no env-var fallback of any kind any more — TASK-610
   * §4A.1 retired `CORS_ALLOWED_ORIGINS` outright (owner directive: no env var
   * ever controls the CORS allow-list). `cors.config.ts` now DENIES whenever
   * this resolver reports `null`.
   *
   * WHY THE EMPTY INDEX IS STILL REPORTED AS `null` RATHER THAN THE (EMPTY)
   * REGISTRY ITSELF. Functionally the two are equivalent post-§4A.1 — an
   * empty registry's `has()` would answer `false` for every origin anyway, so
   * either encoding DENIES. The collapse is kept purely for DIAGNOSTICS: it
   * gives `cors.config.ts` a way to log a DISTINCT, greppable reason
   * (`origin_registry_unavailable`) when NOTHING is loaded platform-wide —
   * the systemic "check the database" signal — instead of the same
   * `origin_registry_miss` an ordinary single-origin refusal produces. That
   * distinction matters because `OriginRegistryService.refresh()` deliberately
   * does NOT throw when the database is unreachable — it keeps its previous
   * index, which at boot is empty — so a real outage and a merely-unseeded
   * table both present as `size() === 0` and both want the loud, systemic log
   * line rather than being logged as though each origin were individually and
   * legitimately refused. Once even one row exists, the registry is handed
   * over directly and a miss is an ordinary `origin_registry_miss`.
   *
   * Resolution is lazy (per request), so installing the accessor once is
   * enough — a row added later is picked up on the registry's next refresh
   * with no restart and no re-install here.
   */
  private installOriginRegistryResolver(): void {
    if (!this.originRegistry) {
      this.logger.warn('No origin registry wired — CORS denies every browser origin (TASK-610 §4A.1: no env-var fallback)');
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
