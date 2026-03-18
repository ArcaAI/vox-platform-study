import { GlobalSettingEntity } from '@arcaai/domains';

/**
 * Interface for application settings service that manages database-stored configuration
 */
export interface IAppSettingsService {
    /**
     * Retrieves a global setting from the cache
     * @param key - The key of the setting to retrieve
     * @returns The global setting entity or undefined if not found
     */
    getFromCache(key: string): GlobalSettingEntity | undefined;

    /**
     * Retrieves the parsed value of a global setting from the cache
     * @param key - The key of the setting to retrieve
     * @returns The parsed value of the setting or null if not found
     */
    getValueFromCache(key: string): any;

    /**
     * Retrieves a setting value with a default fallback
     * @param key - The key of the setting to retrieve
     * @param defaultValue - Default value to return if setting is not found
     * @returns The setting value or default value
     */
    getValueWithDefault<T>(key: string, defaultValue: T): T;

    /**
     * Checks if a setting exists in the cache
     * @param key - The key to check
     * @returns true if the setting exists
     */
    hasSetting(key: string): boolean;

    /**
     * Gets all setting keys currently in cache
     * @returns Array of setting keys
     */
    getAllKeys(): string[];

    /**
     * Gets cache statistics for monitoring
     * @returns Cache statistics object
     */
    getCacheStats(): {
        lastRefresh: Date;
        refreshCount: number;
        errorCount: number;
        settingsCount: number;
        isInitialized: boolean;
    };

    /**
     * Caches all app settings from the database
     * @returns Promise that resolves when caching is complete
     */
    cacheAppSettings(): Promise<void>;

    /**
     * Updates the app settings cache at a specified interval
     * @param cronTime - The cron time expression for the job
     */
    updateCacheAppSettings(cronTime?: string): void;

    /**
     * Forces an immediate cache refresh
     * @returns Promise that resolves when cache is refreshed
     */
    refreshCache(): Promise<void>;

    /**
     * Stops the automatic cache refresh
     */
    stopCacheRefresh(): void;

    /**
     * Validates a setting value against expected type/format
     * @param key - Setting key
     * @param value - Value to validate
     * @param expectedType - Expected type ('string', 'number', 'boolean', 'json')
     * @returns true if valid
     */
    validateSettingValue(key: string, value: any, expectedType: string): boolean;
}

export const IAppSettingsService = Symbol('IAppSettingsService');