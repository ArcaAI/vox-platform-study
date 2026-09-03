/**
 * AppSettingsService Unit Tests
 *
 * Tests for the application settings service that manages database-stored configuration.
 *
 * Testing Strategy:
 * - Focus on testing BEHAVIOR, not mock interactions
 * - Verify actual state changes and return values
 * - Use mocks only for external boundaries (database, scheduler)
 * - Ensure mocks match real interface contracts
 */

import { describe, it, expect, beforeEach, afterEach, vi, Mock } from 'vitest';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ClsService } from 'nestjs-cls';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import { AppSettingsService } from '../appSettings/appSettings.service';
import { GlobalSettingEntity, GlobalSettingRepository } from '@arcaai/domains';

// Mock external dependencies only - database and scheduler are external boundaries
vi.mock('@arcaai/domains', () => ({
  // Complete mock matching real GlobalSettingEntity interface
  GlobalSettingEntity: class MockGlobalSettingEntity {
    id: string;
    key: string;
    value: string;
    parsedValue: any;
    dataType: string;
    description: string | null;
    isEncrypted: boolean;
    createdAt: Date;
    updatedAt: Date;
    constructor(data: any) {
      this.id = data.id ?? `setting-${Date.now()}`;
      this.key = data.key;
      this.value = data.value;
      this.parsedValue = data.parsedValue ?? data.value;
      this.dataType = data.dataType ?? 'string';
      this.description = data.description ?? null;
      this.isEncrypted = data.isEncrypted ?? false;
      this.createdAt = data.createdAt ?? new Date();
      this.updatedAt = data.updatedAt ?? new Date();
    }
  },
  GlobalSettingRepository: vi.fn(),
  // The service filters soft-DELETED rows via this enum; the
  // module-level mock must supply it (rows without resourceStatus pass).
  ResourceStatusType: {
    ENABLED: 'ENABLED',
    DISABLED: 'DISABLED',
    ARCHIVED: 'ARCHIVED',
    DELETED: 'DELETED',
  },
  // The `@OnEvent(SysEventType.ResourceUpdated)` sys-event cache-invalidation
  // subscriber evaluates these at class-definition (import) time, so the
  // module-level mock must supply them even though this legacy suite never
  // exercises the subscriber directly.
  SysEventType: {
    ResourceCreated: 'SysEvent.ResourceCreated',
    ResourceUpdated: 'SysEvent.ResourceUpdated',
    ResourceDeleted: 'SysEvent.ResourceDeleted',
    ResourceViewed: 'SysEvent.ResourceViewed',
    ResourceArchived: 'SysEvent.ResourceArchived',
  },
  ResourceType: {
    GlobalSetting: 'GlobalSetting',
  },
}));

// Mock cron - external scheduling boundary
vi.mock('cron', () => {
  class MockCronJob {
    cronTime: string;
    callback: () => void;
    isRunning: boolean = false;
    start = vi.fn().mockImplementation(function (this: MockCronJob) {
      this.isRunning = true;
    });
    stop = vi.fn().mockImplementation(function (this: MockCronJob) {
      this.isRunning = false;
    });
    constructor(cronTime: string, callback: () => void) {
      this.cronTime = cronTime;
      this.callback = callback;
    }
  }
  return {
    CronJob: MockCronJob,
  };
});

describe('AppSettingsService', () => {
  let service: AppSettingsService;
  let mockGlobalSettingRepository: {
    findAll: Mock;
  };
  let mockEventEmitter: {
    emit: Mock;
    emittedEvents: Array<{ event: string; payload: any }>;
  };
  let mockClsService: {
    get: Mock;
    set: Mock;
  };
  let mockSchedulerRegistry: {
    addCronJob: Mock;
    getCronJob: Mock;
    deleteCronJob: Mock;
    registeredJobs: Map<string, any>;
  };

  /**
   * Creates a complete mock setting matching the real GlobalSettingEntity interface
   * This ensures tests don't pass with incomplete data structures
   */
  const createMockSetting = (
    key: string,
    value: string,
    parsedValue?: any,
    options?: {
      dataType?: string;
      description?: string;
      isEncrypted?: boolean;
    },
  ) => ({
    id: `setting-${key}`,
    // `GlobalSetting.tenantId` is NOT NULL, and the platform cache admits the
    // reserved SYSTEM tenant EXCLUSIVELY (owner ruling 2026-08-20,
    // OD-1) — so a fixture on any other tenant is not a row the platform cache
    // can ever hold. GLOBAL (`50000000-…`) is a CUSTOMER tenant, not a tier;
    // `filters customer-tenant rows out of the platform cache` below pins that.
    tenantId: '00000000-0000-0000-0000-000000000000',
    key,
    value,
    parsedValue: parsedValue ?? value,
    dataType: options?.dataType ?? 'string',
    description: options?.description ?? null,
    isEncrypted: options?.isEncrypted ?? false,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  beforeEach(() => {
    vi.clearAllMocks();

    // Mock repository - external database boundary
    mockGlobalSettingRepository = {
      findAll: vi.fn().mockResolvedValue([]),
    };

    // Mock event emitter with tracking for behavior verification
    const emittedEvents: Array<{ event: string; payload: any }> = [];
    mockEventEmitter = {
      emit: vi.fn().mockImplementation((event: string, payload: any) => {
        emittedEvents.push({ event, payload });
      }),
      emittedEvents,
    };

    mockClsService = {
      get: vi.fn(),
      set: vi.fn(),
      // `cacheAppSettings` reads outside the request CLS context; pass through.
      exit: vi.fn((fn: () => unknown) => fn()),
    };

    // Mock scheduler registry with job tracking for behavior verification
    const registeredJobs = new Map<string, any>();
    mockSchedulerRegistry = {
      addCronJob: vi.fn().mockImplementation((name: string, job: any) => {
        registeredJobs.set(name, job);
      }),
      getCronJob: vi.fn().mockImplementation((name: string) => {
        const job = registeredJobs.get(name);
        if (!job) throw new Error('Job not found');
        return job;
      }),
      deleteCronJob: vi.fn().mockImplementation((name: string) => {
        registeredJobs.delete(name);
      }),
      registeredJobs,
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const construct = () =>
    new AppSettingsService(
      mockGlobalSettingRepository as any,
      mockEventEmitter as any,
      mockClsService as any,
      mockSchedulerRegistry as any,
    );

  /**
   * Construct the service and load its cache through the ONE load path.
   *
   * The constructor deliberately performs no I/O (see the service's
   * `ensureCacheInitialized` doc comment), so the load has to be requested
   * explicitly — this used to be `await sleep(10)` waiting on a floating
   * promise the constructor fired.
   */
  const createService = async (settings: any[] = []) => {
    mockGlobalSettingRepository.findAll.mockResolvedValue(settings);

    service = construct();
    await service.cacheAppSettings();
    return service;
  };

  describe('construction', () => {
    it('performs NO database I/O — the load belongs to onModuleInit, not the constructor', () => {
      construct();

      expect(mockGlobalSettingRepository.findAll).not.toHaveBeenCalled();
    });

    it('reports an unloaded cache rather than throwing, before anything loads it', () => {
      const fresh = construct();

      expect(fresh.getCacheStats().isInitialized).toBe(false);
      expect(fresh.hasSetting('key1')).toBe(false);
      expect(fresh.getAllKeys()).toEqual([]);
    });

    it('makes settings accessible from the cache once loaded', async () => {
      const settings = [createMockSetting('key1', 'value1'), createMockSetting('key2', 'value2')];

      service = await createService(settings);

      // Verify BEHAVIOR: settings are actually accessible from cache
      expect(service.getValueFromCache('key1')).toBe('value1');
      expect(service.getValueFromCache('key2')).toBe('value2');
      expect(service.getAllKeys()).toHaveLength(2);
    });

    it('propagates a load failure to its caller and counts it', async () => {
      mockGlobalSettingRepository.findAll.mockRejectedValue(new Error('DB Error'));

      service = construct();

      // The failure is the CALLER's to handle — `onModuleInit` turns it into a
      // refused boot (asserted below). It is never swallowed.
      await expect(service.cacheAppSettings()).rejects.toThrow('DB Error');

      const stats = service.getCacheStats();
      expect(stats.isInitialized).toBe(false);
      expect(stats.errorCount).toBeGreaterThan(0);
    });
  });

  describe('onModuleInit', () => {
    it('should initialize service with cache loaded and refresh job scheduled', async () => {
      const settings = [createMockSetting('key1', 'value1')];
      service = await createService(settings);

      await service.onModuleInit();

      // Verify BEHAVIOR: cache is initialized and accessible
      expect(service.getCacheStats().isInitialized).toBe(true);
      expect(service.getValueFromCache('key1')).toBe('value1');

      // Verify BEHAVIOR: refresh job is registered and can be retrieved
      expect(mockSchedulerRegistry.registeredJobs.has('updateCacheAppSettings')).toBe(true);
    });

    it('should throw error if cache initialization fails during module init', async () => {
      service = await createService([]);
      mockGlobalSettingRepository.findAll.mockRejectedValue(new Error('Init Error'));

      // Reset cache state to force re-initialization
      (service as any)._cacheInitialized = false;

      await expect(service.onModuleInit()).rejects.toThrow('Init Error');

      // Verify BEHAVIOR: error count is incremented
      expect(service.getCacheStats().errorCount).toBeGreaterThan(0);
    });
  });

  describe('getFromCache', () => {
    it('should return setting entity from cache', async () => {
      const settings = [createMockSetting('test.key', 'test-value')];
      service = await createService(settings);

      const result = service.getFromCache('test.key');

      expect(result).toBeDefined();
      expect(result?.key).toBe('test.key');
    });

    it('should return undefined for non-existent key', async () => {
      service = await createService([]);

      const result = service.getFromCache('non.existent');

      expect(result).toBeUndefined();
    });

    it('should return undefined when cache is not initialized', async () => {
      service = new AppSettingsService(
        mockGlobalSettingRepository as any,
        mockEventEmitter as any,
        mockClsService as any,
        mockSchedulerRegistry as any,
      );

      // Immediately check before cache initializes
      (service as any)._cacheInitialized = false;
      const result = service.getFromCache('any.key');

      expect(result).toBeUndefined();
    });
  });

  describe('getValueFromCache', () => {
    it('should return parsed value from cache', async () => {
      const settings = [createMockSetting('number.setting', '42', 42)];
      service = await createService(settings);

      const result = service.getValueFromCache('number.setting');

      expect(result).toBe(42);
    });

    it('should return null for non-existent key', async () => {
      service = await createService([]);

      const result = service.getValueFromCache('non.existent');

      expect(result).toBeNull();
    });

    it('should fallback to raw value if parsing fails', async () => {
      const mockSetting = {
        tenantId: '00000000-0000-0000-0000-000000000000',
        key: 'broken.setting',
        value: 'raw-value',
        get parsedValue() {
          throw new Error('Parse error');
        },
      };
      service = await createService([mockSetting]);

      const result = service.getValueFromCache('broken.setting');

      expect(result).toBe('raw-value');
    });
  });

  describe('getValueWithDefault', () => {
    it('should return setting value when exists', async () => {
      const settings = [createMockSetting('existing.key', 'existing-value')];
      service = await createService(settings);

      const result = service.getValueWithDefault('existing.key', 'default');

      expect(result).toBe('existing-value');
    });

    it('should return default value when setting not found', async () => {
      service = await createService([]);

      const result = service.getValueWithDefault('non.existent', 'default-value');

      expect(result).toBe('default-value');
    });

    it('should return setting value even when empty string', async () => {
      const settings = [createMockSetting('empty.setting', '', '')];
      service = await createService(settings);

      // Empty string is a valid value, not null
      const result = service.getValueWithDefault('empty.setting', 'default');

      // The service returns the actual value (empty string) since it's not null
      expect(result).toBe('');
    });
  });

  describe('hasSetting', () => {
    it('should return true for existing setting', async () => {
      const settings = [createMockSetting('exists', 'value')];
      service = await createService(settings);

      expect(service.hasSetting('exists')).toBe(true);
    });

    it('should return false for non-existent setting', async () => {
      service = await createService([]);

      expect(service.hasSetting('not.exists')).toBe(false);
    });
  });

  describe('getAllKeys', () => {
    it('should return all setting keys', async () => {
      const settings = [createMockSetting('key1', 'value1'), createMockSetting('key2', 'value2'), createMockSetting('key3', 'value3')];
      service = await createService(settings);

      const keys = service.getAllKeys();

      expect(keys).toHaveLength(3);
      expect(keys).toContain('key1');
      expect(keys).toContain('key2');
      expect(keys).toContain('key3');
    });

    it('should return empty array when no settings', async () => {
      service = await createService([]);

      const keys = service.getAllKeys();

      expect(keys).toHaveLength(0);
    });
  });

  describe('getCacheStats', () => {
    it('should return cache statistics', async () => {
      const settings = [createMockSetting('key1', 'value1'), createMockSetting('key2', 'value2')];
      service = await createService(settings);

      const stats = service.getCacheStats();

      expect(stats).toHaveProperty('lastRefresh');
      expect(stats).toHaveProperty('refreshCount');
      expect(stats).toHaveProperty('errorCount');
      expect(stats).toHaveProperty('settingsCount');
      expect(stats).toHaveProperty('isInitialized');
      expect(stats.isInitialized).toBe(true);
      expect(stats.settingsCount).toBe(2);
    });

    it('filters customer-tenant rows out of the platform cache', async () => {
      // the platform (key-only) cache is sound ONLY because it
      // admits the reserved SYSTEM tenant EXCLUSIVELY. GLOBAL (`50000000-…`) is
      // the platform-admin PLAYGROUND — a customer tenant — so its rows must
      // never widen into the platform tier, or one customer's configuration is
      // served to every other tenant.
      // The tenant lane only carries settings-registry overrides, so the
      // fixture must declare that namespace to be reachable under its tenant.
      const globalRow = {
        ...createMockSetting('leaky.key', 'playground-value'),
        tenantId: '50000000-0000-0000-0000-000000000000',
        namespace: 'registry',
      };

      service = await createService([createMockSetting('platform.key', 'system-value'), globalRow]);

      expect(service.getValueFromCache('platform.key')).toBe('system-value');
      expect(service.hasSetting('leaky.key')).toBe(false);
      expect(service.getValueFromCache('leaky.key')).toBeNull();
      expect(service.getAllKeys()).toEqual(['platform.key']);

      // It is not discarded — it is reachable only under its own tenant.
      expect(service.getTenantValueFromCache('50000000-0000-0000-0000-000000000000', 'leaky.key')).toBe('playground-value');
    });
  });

  describe('cacheAppSettings', () => {
    it('should load settings from database and make them accessible via cache', async () => {
      service = await createService([]);
      const newSettings = [createMockSetting('new.key1', 'new-value1'), createMockSetting('new.key2', 'new-value2')];
      mockGlobalSettingRepository.findAll.mockResolvedValue(newSettings);

      await service.cacheAppSettings();

      // Verify BEHAVIOR: settings are actually accessible
      expect(service.getValueFromCache('new.key1')).toBe('new-value1');
      expect(service.getValueFromCache('new.key2')).toBe('new-value2');
      expect(service.getAllKeys()).toContain('new.key1');
      expect(service.getAllKeys()).toContain('new.key2');
    });

    it('should replace old cache with new settings on refresh', async () => {
      const oldSettings = [createMockSetting('old.key', 'old-value')];
      service = await createService(oldSettings);

      // Verify old setting exists
      expect(service.hasSetting('old.key')).toBe(true);

      // Refresh with new settings (not including old.key)
      const newSettings = [createMockSetting('new.key', 'new-value')];
      mockGlobalSettingRepository.findAll.mockResolvedValue(newSettings);

      await service.cacheAppSettings();

      // Verify BEHAVIOR: old setting is gone, new setting is present
      expect(service.hasSetting('old.key')).toBe(false);
      expect(service.hasSetting('new.key')).toBe(true);
    });

    it('should emit cache-refreshed event with correct payload on success', async () => {
      const settings = [createMockSetting('key1', 'value1'), createMockSetting('key2', 'value2')];
      service = await createService([]);
      // Clear events from initial service creation
      mockEventEmitter.emittedEvents.length = 0;
      mockGlobalSettingRepository.findAll.mockResolvedValue(settings);

      await service.cacheAppSettings();

      // Verify BEHAVIOR: event was emitted with correct data
      const refreshEvent = mockEventEmitter.emittedEvents.find((e) => e.event === 'app-settings.cache-refreshed');
      expect(refreshEvent).toBeDefined();
      expect(refreshEvent!.payload.settingsCount).toBe(2);
      expect(refreshEvent!.payload.timestamp).toBeInstanceOf(Date);
    });

    it('should emit cache-error event with error details on failure', async () => {
      service = await createService([]);
      mockGlobalSettingRepository.findAll.mockRejectedValue(new Error('DB Error'));

      await expect(service.cacheAppSettings()).rejects.toThrow('DB Error');

      // Verify BEHAVIOR: error event contains useful debugging info
      const errorEvent = mockEventEmitter.emittedEvents.find((e) => e.event === 'app-settings.cache-error');
      expect(errorEvent).toBeDefined();
      expect(errorEvent!.payload.error).toBe('DB Error');
      expect(errorEvent!.payload.timestamp).toBeInstanceOf(Date);
    });

    it('should track refresh statistics for monitoring', async () => {
      service = await createService([]);
      const initialStats = service.getCacheStats();
      const initialRefreshCount = initialStats.refreshCount;

      await service.cacheAppSettings();
      await service.cacheAppSettings();

      const newStats = service.getCacheStats();
      // Verify BEHAVIOR: refresh count accurately tracks number of refreshes
      expect(newStats.refreshCount).toBe(initialRefreshCount + 2);
      expect(newStats.lastRefresh).toBeInstanceOf(Date);
    });

    it('should track error statistics for monitoring', async () => {
      service = await createService([]);
      const initialStats = service.getCacheStats();
      const initialErrorCount = initialStats.errorCount;

      mockGlobalSettingRepository.findAll.mockRejectedValue(new Error('DB Error'));

      try {
        await service.cacheAppSettings();
      } catch {
        /* expected */
      }
      try {
        await service.cacheAppSettings();
      } catch {
        /* expected */
      }

      const newStats = service.getCacheStats();
      // Verify BEHAVIOR: error count accurately tracks failures
      expect(newStats.errorCount).toBe(initialErrorCount + 2);
    });
  });

  describe('updateCacheAppSettings', () => {
    it('should schedule periodic cache refresh with default cron expression', async () => {
      service = await createService([]);

      service.updateCacheAppSettings();

      // Verify BEHAVIOR: job is registered and accessible
      expect(mockSchedulerRegistry.registeredJobs.has('updateCacheAppSettings')).toBe(true);
      const job = mockSchedulerRegistry.registeredJobs.get('updateCacheAppSettings');
      expect(job).toBeDefined();
      expect(job.cronTime).toBeDefined();
    });

    it('should schedule periodic cache refresh with custom cron expression', async () => {
      service = await createService([]);
      const customCron = '0 */5 * * * *';

      service.updateCacheAppSettings(customCron);

      // Verify BEHAVIOR: job uses the custom cron expression
      const job = mockSchedulerRegistry.registeredJobs.get('updateCacheAppSettings');
      expect(job).toBeDefined();
      expect(job.cronTime).toBe(customCron);
    });

    it('should replace existing job when updating schedule', async () => {
      service = await createService([]);

      // Create initial job
      service.updateCacheAppSettings('0 */1 * * * *');
      const firstJob = mockSchedulerRegistry.registeredJobs.get('updateCacheAppSettings');

      // Update with new schedule
      service.updateCacheAppSettings('0 */5 * * * *');
      const secondJob = mockSchedulerRegistry.registeredJobs.get('updateCacheAppSettings');

      // Verify BEHAVIOR: old job was stopped and new job is registered
      expect(firstJob.stop).toHaveBeenCalled();
      expect(secondJob.cronTime).toBe('0 */5 * * * *');
    });
  });

  describe('refreshCache', () => {
    it('should force immediate cache refresh', async () => {
      service = await createService([]);
      const newSettings = [createMockSetting('refreshed.key', 'refreshed-value')];
      mockGlobalSettingRepository.findAll.mockResolvedValue(newSettings);

      await service.refreshCache();

      expect(service.hasSetting('refreshed.key')).toBe(true);
    });
  });

  describe('stopCacheRefresh', () => {
    it('should stop the cron job', async () => {
      const mockJob = {
        stop: vi.fn(),
      };
      mockSchedulerRegistry.getCronJob.mockReturnValue(mockJob);

      service = await createService([]);
      service.stopCacheRefresh();

      expect(mockJob.stop).toHaveBeenCalled();
      expect(mockSchedulerRegistry.deleteCronJob).toHaveBeenCalledWith('updateCacheAppSettings');
    });

    it('should handle case when job does not exist', async () => {
      mockSchedulerRegistry.getCronJob.mockImplementation(() => {
        throw new Error('Job not found');
      });

      service = await createService([]);

      // Should not throw
      expect(() => service.stopCacheRefresh()).not.toThrow();
    });
  });

  describe('validateSettingValue', () => {
    beforeEach(async () => {
      service = await createService([]);
    });

    it('should validate string type', () => {
      expect(service.validateSettingValue('key', 'string-value', 'string')).toBe(true);
      expect(service.validateSettingValue('key', 123, 'string')).toBe(false);
    });

    it('should validate number type', () => {
      expect(service.validateSettingValue('key', 42, 'number')).toBe(true);
      expect(service.validateSettingValue('key', 3.14, 'number')).toBe(true);
      expect(service.validateSettingValue('key', 'not-a-number', 'number')).toBe(false);
      expect(service.validateSettingValue('key', NaN, 'number')).toBe(false);
    });

    it('should validate boolean type', () => {
      expect(service.validateSettingValue('key', true, 'boolean')).toBe(true);
      expect(service.validateSettingValue('key', false, 'boolean')).toBe(true);
      expect(service.validateSettingValue('key', 'true', 'boolean')).toBe(false);
    });

    it('should validate json type', () => {
      expect(service.validateSettingValue('key', '{"valid": "json"}', 'json')).toBe(true);
      expect(service.validateSettingValue('key', { valid: 'object' }, 'json')).toBe(true);
      expect(service.validateSettingValue('key', 'invalid json', 'json')).toBe(false);
    });

    it('should return true for unknown types', () => {
      expect(service.validateSettingValue('key', 'any-value', 'unknown')).toBe(true);
    });

    it('should handle case-insensitive type names', () => {
      expect(service.validateSettingValue('key', 'value', 'STRING')).toBe(true);
      expect(service.validateSettingValue('key', 42, 'NUMBER')).toBe(true);
      expect(service.validateSettingValue('key', true, 'BOOLEAN')).toBe(true);
    });
  });
});
