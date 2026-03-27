import { IAppConfig } from '@arcaai/domains';

/**
 * Interface for configuration service that handles application configuration
 * from multiple sources (environment variables, defaults)
 */
export interface IConfigService {
  /** The loaded configuration object */
  config?: IAppConfig;

  /**
   * Loads configuration from all sources (environment, defaults)
   * @returns Promise that resolves when configuration is loaded
   */
  loadConfig(): Promise<void>;

  /**
   * Gets the complete configuration object
   * @returns The current application configuration
   */
  getConfiguration(): IAppConfig;

  /**
   * Gets a specific configuration value with type safety
   * @param key - The configuration key
   * @returns The configuration value
   */
  getConfigValue<K extends keyof IAppConfig>(key: K): IAppConfig[K];

  /**
   * Reloads configuration from all sources
   * Useful for runtime configuration updates
   * @returns Promise that resolves when configuration is reloaded
   */
  reloadConfiguration(): Promise<void>;

  /**
   * Checks if the application is running in development mode
   * @returns true if NODE_ENV is 'development'
   */
  isDevelopment(): boolean;

  /**
   * Checks if the application is running in production mode
   * @returns true if NODE_ENV is 'production'
   */
  isProduction(): boolean;

  /**
   * Checks if debug mode is enabled
   * @returns true if DEBUG is enabled
   */
  isDebugEnabled(): boolean;

  /**
   * Checks if Redis configuration is available and valid
   * @returns true if Redis is properly configured
   */
  isRedisConfigured(): boolean;

  /**
   * Gets Redis configuration with validation
   * @returns Redis configuration object
   * @throws Error if Redis configuration is invalid
   */
  getRedisConfig(): { host: string; port: number; password?: string };
}

export const IConfigService = Symbol('IConfigService');
