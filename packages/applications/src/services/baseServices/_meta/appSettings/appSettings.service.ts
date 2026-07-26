import { randomUUID } from 'node:crypto';
import { Injectable, Logger, OnModuleInit, Optional, Inject } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';

import { GlobalSettingEntity, GlobalSettingRepository, ResourceStatusType, ResourceType, SysEvent, SysEventType } from '@arcaai/domains';
import { IActiveUserContext } from '../../../../interfaces';
import { IAppSettingsService } from './IAppSettingsService';
import { IRedisCacheService } from '../../redis';
import { RedisSubscriberService } from '../../../stt/realtime/redisSubscriber.service';

// Canonical platform tenant id.
// Matches the seed UUID used across the system (see packages/database/seeds).
// Inlined to avoid pulling tenant/constants.ts into this baseService.
const GLOBAL_TENANT_ID = '50000000-0000-0000-0000-000000000000';

// The reserved SYSTEM tenant. Platform CAPABILITY rows are seeded here rather
// than under the default tenant (seed `11-global-setting.ts` `PLATFORM_SETTINGS`,
// e.g. `enable-local-raw-capture`), so it is equally platform-owned.
const SYSTEM_TENANT_ID = '00000000-0000-0000-0000-000000000000';

/**
 * The ONLY tenants whose rows may enter this cache, highest precedence first.
 *
 * TASK-558 §9.3 M4 — `tenantId` must be part of every config cache key. This
 * cache is deliberately keyed by setting KEY ALONE, because every consumer of
 * it is platform-scoped (JWT TTLs, rate limits, password policy, cron
 * schedules, storage endpoints, and the `global-kv` lane of
 * `EffectiveSettingsService`) and none of them passes a tenant. A key-only
 * cache is only sound if its CONTENTS are platform-only — otherwise a customer
 * tenant's row lands in the shared slot and governs the whole platform.
 *
 * That was reachable: `TenantService.provisionTenantConfigs` clones every
 * platform setting into each new tenant, so the loader (`findAll({})`, which
 * runs without a CLS tenant and is therefore unscoped) sees N_tenants rows per
 * key. Platform-row precedence alone did not close it — a key whose platform
 * row was absent or soft-deleted still resolved to a tenant clone, both on read
 * and on the `getFromCache(key)` → `update(row.id)` admin-write path.
 */
const PLATFORM_TENANT_IDS: readonly string[] = [GLOBAL_TENANT_ID, SYSTEM_TENANT_ID];

/** Precedence rank of a platform tenant; non-platform rows are never cached. */
const platformRank = (tenantId: string): number => PLATFORM_TENANT_IDS.indexOf(tenantId);

/**
 * The reserved namespace the settings-registry write lane stamps on every row
 * it creates (`SettingsRegistryWriteService.REGISTRY_SETTING_NAMESPACE`).
 *
 * Inlined rather than imported: this baseService must not depend on a feature
 * service (the same reason `GLOBAL_TENANT_ID` is inlined above). A registry
 * test asserts the two literals agree.
 */
const REGISTRY_NAMESPACE = 'registry';

/** Cache key for the TENANT lane. The tenant id is part of the KEY, never of the value (§9.3 M4). */
const tenantCacheKey = (tenantId: string, key: string): string => `${tenantId}::${key}`;

/**
 * Dedicated Redis pub/sub channel for cross-instance cache invalidation
 * (F-007 follow-up). Every instance publishes here after a same-instance
 * `GlobalSetting` refresh and subscribes here to converge peers without
 * waiting for the cron.
 */
export const APP_SETTINGS_INVALIDATION_CHANNEL = 'app-settings:invalidate';

/**
 * Service for managing application settings stored in the database.
 *
 * This service provides:
 * - Database-stored configuration management
 * - Real-time cache updates via scheduled jobs
 * - Event-driven setting updates
 * - Type-safe setting retrieval with parsing
 * - Automatic cache invalidation and refresh
 *
 * Settings are loaded after application initialization and cached in memory
 * for fast access. The cache is automatically refreshed at regular intervals.
 */
@Injectable()
export class AppSettingsService implements IAppSettingsService, OnModuleInit {
  /** Logger instance for this service */
  private readonly logger = new Logger(AppSettingsService.name);

  /** Cache for storing app settings */
  private _cachedAppSettings!: Map<string, GlobalSettingEntity>;

  /**
   * The TENANT lane (TASK-558 lane I) — per-tenant overrides for the
   * `maxScope: 'tenant'` knobs, keyed `${tenantId}::${key}` so §9.3 M4 holds by
   * construction: there is no slot a lookup for tenant B could collide with
   * tenant A's row in.
   *
   * DELIBERATELY NARROW. Only rows in the reserved `registry` namespace whose
   * tenant is NOT platform-reserved are admitted, for two reasons:
   *   • `TenantService.provisionTenantConfigs` clones the whole platform
   *     setting set into every tenant, so admitting everything would grow this
   *     map by ~18 entries per tenant for values nothing reads here;
   *   • the registry namespace is exactly what `SettingsRegistryWriteService`
   *     writes, so "in this map" and "written through the governed OCC write
   *     lane" are the same statement.
   * Platform rows stay in `_cachedAppSettings` and are reached by the
   * key-only accessors — the two lanes never mix.
   */
  private _cachedTenantSettings: Map<string, GlobalSettingEntity> = new Map();

  /** Flag to track if initial cache load is complete */
  private _cacheInitialized = false;

  /** Default cache refresh interval in seconds */
  private readonly DEFAULT_CACHE_REFRESH_INTERVAL = '45 * * * * *'; // Every 45 seconds

  /** Cache statistics for monitoring */
  private _cacheStats = {
    lastRefresh: new Date(),
    refreshCount: 0,
    errorCount: 0,
    settingsCount: 0,
  };

  /** Per-instance identifier used to skip a self-published invalidation message on receipt. */
  private readonly instanceId = randomUUID();

  /**
   * Creates an instance of AppSettingsService.
   * @param globalSettingRepository - Repository for global settings
   * @param eventEmitter - Event emitter for broadcasting events
   * @param clsService - Continuation Local Storage service for context management
   * @param schedulerRegistry - Scheduler registry for managing cron jobs
   * @param redisCacheService - Optional Redis cache service used to PUBLISH cross-instance
   *   invalidation messages (F-007 follow-up). Absent ⇒ same-instance-only convergence + cron.
   * @param redisSubscriberService - Optional dedicated Redis subscriber used to SUBSCRIBE to
   *   those messages. Absent ⇒ same-instance-only convergence + cron.
   */
  constructor(
    private readonly globalSettingRepository: GlobalSettingRepository,
    protected readonly eventEmitter: EventEmitter2,
    protected readonly clsService: ClsService<IActiveUserContext>,
    protected readonly schedulerRegistry: SchedulerRegistry,
    @Optional() @Inject(IRedisCacheService) private readonly redisCacheService?: IRedisCacheService,
    @Optional() private readonly redisSubscriberService?: RedisSubscriberService,
  ) {
    this.logger.log({
      message: 'Service created',
      service: AppSettingsService.name,
    });

    // Initialize cache immediately but don't wait for it
    this.initializeCache();
  }

  /**
   * Initializes the app settings service.
   * Sets up automatic cache refresh and ensures cache is loaded.
   */
  async onModuleInit() {
    this.logger.log({
      message: 'Initializing service',
      service: AppSettingsService.name,
    });

    try {
      // Ensure cache is loaded before setting up refresh
      await this.ensureCacheInitialized();

      // Setup automatic cache refresh
      this.updateCacheAppSettings();

      // Subscribe to cross-instance invalidation messages (F-007 follow-up).
      // Best-effort: a missing/unavailable Redis subscriber falls back to the
      // pre-existing behaviour (in-process convergence + cron) without throwing.
      await this.subscribeToCrossInstanceInvalidation();

      this.logger.log({
        message: 'Service initialized',
        service: AppSettingsService.name,
        settingsCount: this._cacheStats.settingsCount,
      });
    } catch (error) {
      this.logger.error({
        message: 'Failed to initialize service',
        service: AppSettingsService.name,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Retrieves a global setting from the cache.
   * @param key - The key of the setting to retrieve
   * @returns The global setting entity or undefined if not found
   */
  public getFromCache(key: string): GlobalSettingEntity | undefined {
    if (!this._cacheInitialized) {
      this.logger.warn({
        message: 'Cache not initialized',
        settingKey: key,
      });
      return undefined;
    }

    return this._cachedAppSettings.get(key);
  }

  /**
   * Retrieves the parsed value of a global setting from the cache.
   * @param key - The key of the setting to retrieve
   * @returns The parsed value of the setting or null if not found
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  public getValueFromCache(key: string): any {
    const globalSetting = this.getFromCache(key);

    if (globalSetting) {
      try {
        return globalSetting.parsedValue;
      } catch (error) {
        this.logger.error({
          message: 'Failed to parse value for setting',
          settingKey: key,
          error: error instanceof Error ? error.message : String(error),
        });
        return globalSetting.value; // Fallback to raw value
      }
    }

    return null;
  }

  /**
   * The parsed value of ONE tenant's registry override for `key`, or `null`
   * when that tenant has not overridden it.
   *
   * Deliberately does NOT fall back to the platform value: the cascade
   * (tenant → SYSTEM → descriptor default) belongs to `TenantSettingsService`,
   * which needs to know WHICH tier answered in order to report the source
   * (§9.2 L8) and to apply the tenant clamp (§9.3 M2) against the platform
   * value. A silent fallback here would make those two impossible.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mirrors the untyped `any` return of the sibling key-only accessors; the cache stores heterogeneous parsed setting values
  public getTenantValueFromCache(tenantId: string, key: string): any {
    if (!tenantId) return null;
    const setting = this._cachedTenantSettings.get(tenantCacheKey(tenantId, key));
    if (!setting) return null;

    try {
      return setting.parsedValue;
    } catch (error) {
      this.logger.error({
        message: 'Failed to parse value for tenant setting',
        settingKey: key,
        tenantId,
        error: error instanceof Error ? error.message : String(error),
      });
      return setting.value;
    }
  }

  /**
   * Retrieves a setting value with a default fallback
   * @param key - The key of the setting to retrieve
   * @param defaultValue - Default value to return if setting is not found
   * @returns The setting value or default value
   */
  public getValueWithDefault<T>(key: string, defaultValue: T): T {
    const value = this.getValueFromCache(key);
    return value !== null ? value : defaultValue;
  }

  /**
   * Checks if a setting exists in the cache
   * @param key - The key to check
   * @returns true if the setting exists
   */
  public hasSetting(key: string): boolean {
    return this._cachedAppSettings.has(key);
  }

  /**
   * Gets all setting keys currently in cache
   * @returns Array of setting keys
   */
  public getAllKeys(): string[] {
    return Array.from(this._cachedAppSettings.keys());
  }

  /**
   * Gets cache statistics for monitoring
   * @returns Cache statistics object
   */
  public getCacheStats() {
    return {
      ...this._cacheStats,
      isInitialized: this._cacheInitialized,
    };
  }

  /**
   * Caches all app settings from the database.
   * This method is called during initialization and periodically for refresh.
   */
  public async cacheAppSettings(): Promise<void> {
    try {
      this.logger.debug({
        message: 'Refreshing app settings cache',
      });

      // Create new cache map
      const newCache = new Map<string, GlobalSettingEntity>();

      // Fetch all global settings from database
      const fetchedSettings = await this.globalSettingRepository.findAll({});

      // (Defect 2) — drop soft-DELETED rows at the SERVICE layer.
      // The repository's DELETED filtering is an invisible property of which
      // Prisma client variant served the query (the CLS transaction client
      // inside `runInTransaction` windows bypasses the soft-delete extension),
      // so a soft-delete + recreate cycle could feed a DELETED+ENABLED pair
      // for one key into the P0-5 invariant below — failing every refresh and
      // crashing the next boot. Filtering here makes the invariant AND the
      // Map<key> cache robust regardless of the serving client: a recreated
      // key is tolerated by construction and a DELETED row can never shadow
      // the live one. Genuine duplicates (2× live rows) still refuse to start.
      const liveSettings = fetchedSettings.filter((s) => s.resourceStatus !== ResourceStatusType.DELETED);

      // §9.3 M4 — admit ONLY platform-reserved tenants. See
      // PLATFORM_TENANT_IDS above for why a key-only cache requires this.
      const globalSettings = liveSettings.filter((s) => platformRank(s.tenantId) !== -1);

      // The TENANT lane (lane I): registry-namespace overrides owned by a
      // CUSTOMER tenant, keyed by `${tenantId}::${key}`. Built here rather than
      // in a separate loader so both maps are produced by the same read and
      // swapped together — which makes the existing `app-settings:invalidate`
      // fan-out and the 45s cron converge the tenant lane with no extra wiring.
      const newTenantCache = new Map<string, GlobalSettingEntity>();
      for (const setting of liveSettings) {
        if (platformRank(setting.tenantId) !== -1) continue;
        if (setting.namespace !== REGISTRY_NAMESPACE) continue;
        newTenantCache.set(tenantCacheKey(setting.tenantId, setting.key), setting);
      }

      // Boot-time duplicate-key invariant.
      // If >1 row exists for the same platform key
      // (tenantId === GLOBAL_TENANT_ID), the Map<key>-keyed cache silently
      // resolves to a non-deterministic winner. Refuse to start.
      const allowSkip = process.env.NODE_ENV === 'development' && process.env.APP_SETTINGS_BOOT_INVARIANT === 'skip';

      if (!allowSkip) {
        const platformOnly = globalSettings.filter((s) => s.tenantId === GLOBAL_TENANT_ID);
        const seen = new Map<string, number>();
        for (const s of platformOnly) {
          seen.set(s.key, (seen.get(s.key) ?? 0) + 1);
        }
        const duplicates = Array.from(seen.entries()).filter(([, n]) => n > 1);
        if (duplicates.length > 0) {
          const list = duplicates.map(([k, n]) => `${k} (${n} rows)`).join(', ');
          throw new Error(
            `Phase 0 Item 5 (TASK-302): duplicate platform key(s) detected — ${list}. ` +
              `Refuse to start. See TASK-301 §P0-1 for context. Set ` +
              `APP_SETTINGS_BOOT_INVARIANT=skip in NODE_ENV=development only.`,
          );
        }
      }

      // Populate the new cache.
      // Only platform rows reach this point, so the sole remaining ambiguity is
      // a key present on BOTH platform tenants. Resolve it by declared
      // precedence (default tenant over SYSTEM) rather than row order, and keep
      // the first row on a tie, so the winner never depends on how the
      // repository happened to sort. In the seeded layout the two platform
      // tenants carry disjoint keys, so this only guards future overlap.
      globalSettings.forEach((setting) => {
        const existing = newCache.get(setting.key);
        if (existing && platformRank(existing.tenantId) <= platformRank(setting.tenantId)) {
          return;
        }
        newCache.set(setting.key, setting);
      });

      // Atomically replace both lanes together.
      this._cachedAppSettings = newCache;
      this._cachedTenantSettings = newTenantCache;
      this._cacheInitialized = true;

      // Update statistics
      this._cacheStats.lastRefresh = new Date();
      this._cacheStats.refreshCount++;
      this._cacheStats.settingsCount = globalSettings.length;

      this.logger.debug({
        message: 'App settings cache updated',
        settingsCount: globalSettings.length,
        refreshCount: this._cacheStats.refreshCount,
      });

      // Emit cache refresh event
      this.eventEmitter.emit('app-settings.cache-refreshed', {
        settingsCount: globalSettings.length,
        timestamp: this._cacheStats.lastRefresh,
      });
    } catch (error) {
      this._cacheStats.errorCount++;
      this.logger.error({
        message: 'Failed to cache app settings',
        errorCount: this._cacheStats.errorCount,
        error: error instanceof Error ? error.message : String(error),
      });

      // Emit error event
      this.eventEmitter.emit('app-settings.cache-error', {
        error: error instanceof Error ? error.message : String(error),
        timestamp: new Date(),
      });

      throw error;
    }
  }

  /**
   * Updates the app settings cache at a specified interval.
   * @param cronTime - The cron time expression for the job (default: every 45 seconds)
   */
  public updateCacheAppSettings(cronTime: string = this.DEFAULT_CACHE_REFRESH_INTERVAL) {
    try {
      this.logger.log({
        message: 'Setting up app settings cache refresh',
        cronTime,
      });

      const job = new CronJob(cronTime, async () => {
        try {
          await this.cacheAppSettings();
        } catch (error) {
          this.logger.error({
            message: 'Scheduled cache refresh failed',
            error: error instanceof Error ? error.message : String(error),
          });
        }
      });

      // Stop and delete existing job if it exists
      try {
        const existingJob = this.schedulerRegistry.getCronJob('updateCacheAppSettings');
        if (existingJob) {
          existingJob.stop();
          this.schedulerRegistry.deleteCronJob('updateCacheAppSettings');
          this.logger.debug({
            message: 'Stopped existing cache refresh job',
          });
        }
      } catch (_error) {
        // Job doesn't exist, which is fine
      }

      // Add the new job
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      this.schedulerRegistry.addCronJob('updateCacheAppSettings', job as any);
      job.start();

      this.logger.log({
        message: 'Cache refresh job scheduled',
        cronTime,
      });
    } catch (error) {
      this.logger.error({
        message: 'Failed to setup cache refresh job',
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Forces an immediate cache refresh
   * @returns Promise that resolves when cache is refreshed
   */
  public async refreshCache(): Promise<void> {
    this.logger.log({
      message: 'Forcing immediate cache refresh',
    });
    await this.cacheAppSettings();
  }

  /**
   * Sys-event subscriber: invalidate the cache the moment a `GlobalSetting`
   * row changes, instead of waiting up to 60s for the next cron tick
   * (`DEFAULT_CACHE_REFRESH_INTERVAL` fires at second :45 of every minute —
   * worst case ~60s, not "every 45 seconds"). `broadcastSysEvent` already fires
   * `SysEventType.ResourceUpdated` on every GlobalSetting write (both the
   * settings-registry write lane and the legacy `GlobalSettingService` CRUD);
   * this closes the gap for any writer that does not already call
   * `refreshCache()` itself. Filtered to `ResourceType.GlobalSetting` so
   * unrelated resource updates never trigger a needless DB re-read.
   *
   * NOTE: `@nestjs/event-emitter` is in-process only — on a multi-instance
   * deployment this converges the writing instance's OWN cache immediately.
   * To push the update to OTHER instances, this handler also publishes an
   * invalidation message on `APP_SETTINGS_INVALIDATION_CHANNEL` (F-007
   * follow-up) — see `publishCrossInstanceInvalidation` /
   * `subscribeToCrossInstanceInvalidation`. Publishing is best-effort: a
   * missing/unavailable Redis cache service degrades to cron-only
   * convergence for peers, never throws.
   */
  @OnEvent(SysEventType.ResourceUpdated)
  async handleGlobalSettingUpdated(event: SysEvent): Promise<void> {
    if (event.resourceType !== ResourceType.GlobalSetting) {
      return;
    }

    try {
      await this.refreshCache();
      await this.publishCrossInstanceInvalidation();
    } catch (error) {
      this.logger.error({
        message: 'Failed to refresh cache after GlobalSetting ResourceUpdated event',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * PUBLISH side of the F-007 cross-instance convergence follow-up.
   * Fire-and-forget from the caller's perspective (already awaited by
   * `handleGlobalSettingUpdated`, but never throws): a missing Redis cache
   * service, or Redis being unreachable, both fail open — the writing
   * instance already converged locally via `refreshCache()`, and peers still
   * converge (more slowly) via the cron.
   */
  private async publishCrossInstanceInvalidation(): Promise<void> {
    if (!this.redisCacheService) {
      return;
    }

    try {
      await this.redisCacheService.publish(APP_SETTINGS_INVALIDATION_CHANNEL, JSON.stringify({ instanceId: this.instanceId }));
    } catch (error) {
      this.logger.warn({
        message: 'Failed to publish cross-instance settings invalidation (fail-open — cron still converges peers)',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * SUBSCRIBE side of the F-007 cross-instance convergence follow-up.
   * Called once from `onModuleInit`. A missing Redis subscriber (not wired
   * for this service graph) or a Redis connection failure both fail open:
   * the service still boots and falls back to cron-only convergence.
   */
  private async subscribeToCrossInstanceInvalidation(): Promise<void> {
    if (!this.redisSubscriberService) {
      this.logger.debug({
        message: 'Redis subscriber not available — cross-instance settings convergence stays cron-bound',
        channel: APP_SETTINGS_INVALIDATION_CHANNEL,
      });
      return;
    }

    try {
      const messages$ = await this.redisSubscriberService.subscribeToChannel(APP_SETTINGS_INVALIDATION_CHANNEL);
      messages$.subscribe({
        next: (message) => this.handleCrossInstanceInvalidationMessage(message),
        error: (error) => {
          this.logger.warn({
            message: 'Cross-instance settings invalidation subscription errored — falling back to cron-only convergence',
            error: error instanceof Error ? error.message : String(error),
          });
        },
      });
    } catch (error) {
      this.logger.warn({
        message: 'Failed to subscribe to cross-instance settings invalidation channel — falling back to cron-only convergence',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Handles one message received on `APP_SETTINGS_INVALIDATION_CHANNEL`.
   * Skips a self-published message (this instance already refreshed via
   * `handleGlobalSettingUpdated` before publishing it) to avoid a redundant
   * DB re-read; a malformed payload is treated defensively as a foreign
   * invalidation and still triggers a refresh.
   */
  private handleCrossInstanceInvalidationMessage(rawMessage: string): void {
    try {
      const payload = JSON.parse(rawMessage) as { instanceId?: string };
      if (payload.instanceId === this.instanceId) {
        return;
      }
    } catch {
      // Malformed payload — refresh anyway rather than silently drop a
      // potential invalidation signal.
    }

    this.refreshCache().catch((error) => {
      this.logger.error({
        message: 'Failed to refresh cache after cross-instance settings invalidation message',
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  /**
   * Stops the automatic cache refresh
   */
  public stopCacheRefresh(): void {
    try {
      const existingJob = this.schedulerRegistry.getCronJob('updateCacheAppSettings');
      if (existingJob) {
        existingJob.stop();
        this.schedulerRegistry.deleteCronJob('updateCacheAppSettings');
        this.logger.log({
          message: 'Cache refresh job stopped',
        });
      }
    } catch (error) {
      this.logger.warn({
        message: 'Failed to stop cache refresh job',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Initializes the cache asynchronously
   */
  private async initializeCache(): Promise<void> {
    try {
      await this.cacheAppSettings();
    } catch (error) {
      this.logger.error({
        message: 'Failed to initialize cache',
        error: error instanceof Error ? error.message : String(error),
      });
      // Don't throw here to allow service to start even if cache fails initially
    }
  }

  /**
   * Ensures cache is initialized before proceeding
   */
  private async ensureCacheInitialized(): Promise<void> {
    if (!this._cacheInitialized) {
      this.logger.log({
        message: 'Cache not initialized, loading now',
      });
      await this.cacheAppSettings();
    }
  }

  /**
   * Validates a setting value against expected type/format
   * @param key - Setting key
   * @param value - Value to validate
   * @param expectedType - Expected type ('string', 'number', 'boolean', 'json')
   * @returns true if valid
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  public validateSettingValue(key: string, value: any, expectedType: string): boolean {
    try {
      switch (expectedType.toLowerCase()) {
        case 'string':
          return typeof value === 'string';
        case 'number':
          return typeof value === 'number' && !isNaN(value);
        case 'boolean':
          return typeof value === 'boolean';
        case 'json':
          if (typeof value === 'string') {
            JSON.parse(value);
            return true;
          }
          return typeof value === 'object';
        default:
          return true; // Unknown type, assume valid
      }
    } catch (error) {
      this.logger.warn({
        message: 'Validation failed for setting',
        settingKey: key,
        expectedType,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }
}
