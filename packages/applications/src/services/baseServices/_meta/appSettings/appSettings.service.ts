import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';

import { GlobalSettingEntity, GlobalSettingRepository, ResourceStatusType } from '@arcaai/domains';
import { IActiveUserContext } from '../../../../interfaces';
import { IAppSettingsService } from './IAppSettingsService';

// Phase 0 Item 5 (TASK-302 Stream A) — canonical platform tenant id.
// Matches the seed UUID used across the system (see packages/database/seeds).
// Inlined to avoid pulling tenant/constants.ts into this baseService.
const GLOBAL_TENANT_ID = '50000000-0000-0000-0000-000000000000';

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

  /**
   * Creates an instance of AppSettingsService.
   * @param globalSettingRepository - Repository for global settings
   * @param eventEmitter - Event emitter for broadcasting events
   * @param clsService - Continuation Local Storage service for context management
   * @param schedulerRegistry - Scheduler registry for managing cron jobs
   */
  constructor(
    private readonly globalSettingRepository: GlobalSettingRepository,
    protected readonly eventEmitter: EventEmitter2,
    protected readonly clsService: ClsService<IActiveUserContext>,
    protected readonly schedulerRegistry: SchedulerRegistry,
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

      // TASK-402 (Defect 2) — drop soft-DELETED rows at the SERVICE layer.
      // The repository's DELETED filtering is an invisible property of which
      // Prisma client variant served the query (the CLS transaction client
      // inside `runInTransaction` windows bypasses the soft-delete extension),
      // so a soft-delete + recreate cycle could feed a DELETED+ENABLED pair
      // for one key into the P0-5 invariant below — failing every refresh and
      // crashing the next boot. Filtering here makes the invariant AND the
      // Map<key> cache robust regardless of the serving client: a recreated
      // key is tolerated by construction and a DELETED row can never shadow
      // the live one. Genuine duplicates (2× live rows) still refuse to start.
      const globalSettings = fetchedSettings.filter((s) => s.resourceStatus !== ResourceStatusType.DELETED);

      // Phase 0 Item 5 (TASK-302 Stream A) — boot-time duplicate-key invariant.
      // TASK-301 §P0-1: if >1 row exists for the same platform key
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
      // TASK-403 — deterministic winner for cross-tenant duplicates: tenant
      // provisioning clones every `__GLOBAL__` row (including platform-only
      // namespaces like `rate-limit.*`) into new tenants, and the P0-5
      // invariant above only guards duplicates WITHIN the platform tenant.
      // With plain last-row-wins a tenant clone could shadow the platform row
      // (surfaced by TASK-403: the rate-limit admin surface resolved a tenant
      // clone's id and its updates 404'd). The platform row always wins; rows
      // for keys that exist only on customer tenants still cache as before.
      globalSettings.forEach((setting) => {
        const existing = newCache.get(setting.key);
        if (existing && existing.tenantId === GLOBAL_TENANT_ID && setting.tenantId !== GLOBAL_TENANT_ID) {
          return;
        }
        newCache.set(setting.key, setting);
      });

      // Atomically replace the cache
      this._cachedAppSettings = newCache;
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
