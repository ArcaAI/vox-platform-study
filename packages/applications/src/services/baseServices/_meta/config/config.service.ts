import { Inject, Injectable, OnModuleInit, Logger, Optional } from '@nestjs/common';
import { IConfigService } from './IConfigService';
import { IAppConfig } from '@arcaai/domains';
import { ConfigModuleOptions } from './config.module';
import { SecretsService } from '../secrets';
import { loadEnv, getNodeEnv, type LoadEnvResult } from '../../../../common/env';

/**
 * Service responsible for managing application configuration.
 * Implements IConfigService and OnModuleInit interfaces.
 *
 * This service handles:
 * - Environment variable loading from .env files based on NODE_ENV
 * - Configuration validation and defaults
 *
 * ## Environment File Convention:
 * - `.env.dev` → Local development (NODE_ENV=development)
 * - `.env.test` → Local testing (NODE_ENV=test)
 * - `.env.production` → Production reference (NODE_ENV=production uses host env)
 *
 * ## Loading Priority:
 * 1. Host environment variables (always have highest priority)
 * 2. Environment-specific .env file (if exists and not in CI/production)
 */
@Injectable()
export class ConfigService implements IConfigService, OnModuleInit {
  /** Logger instance for this service */
  private readonly logger = new Logger(ConfigService.name);

  /** Holds the application configuration */
  config!: IAppConfig;

  /** Result of environment loading */
  private envLoadResult?: LoadEnvResult;

  /**
   * Creates an instance of ConfigService.
   * @param options - Configuration module options
   */
  constructor(
    @Inject('CONFIG_OPTIONS') private options: ConfigModuleOptions,
    // TASK-302 Phase 3 Tasks 3.10-3.11 — MQTT_PASS and REDIS_PASS are
    // overlaid from SecretsService in loadVaultSecrets(). Optional so
    // existing unit-test fixtures that construct the service directly
    // continue to work (they fall through to the env-only path).
    @Optional() @Inject(SecretsService) private readonly secretsService?: SecretsService,
  ) {
    this.logger.log({
      message: 'Service created',
      service: ConfigService.name,
    });

    // Load environment variables using centralized utility
    // Priority: options.envFilePath > ENV_FILE_PATH env var > auto-detect based on NODE_ENV
    // eslint-disable-next-line turbo/no-undeclared-env-vars
    const envFilePath = options.envFilePath || process.env['ENV_FILE_PATH'];

    // In test environment, don't override existing env vars (they come from dotenv-cli)
    // In CI or production, skip loading env files entirely (use host environment)
    const nodeEnv = getNodeEnv();
    const shouldOverride = nodeEnv !== 'test';

    this.envLoadResult = loadEnv({
      envFilePath,
      override: shouldOverride,
      // eslint-disable-next-line turbo/no-undeclared-env-vars
      debug: process.env['DEBUG'] === 'true',
    });

    if (this.envLoadResult.loaded) {
      this.logger.log({
        message: 'Loaded environment from file',
        envFilePath: this.envLoadResult.envFilePath,
        nodeEnv: this.envLoadResult.nodeEnv,
        override: shouldOverride,
      });
    } else if (this.envLoadResult.isCI || nodeEnv === 'production') {
      this.logger.log({
        message: 'Using host environment variables',
        nodeEnv,
        isCI: this.envLoadResult.isCI,
      });
    } else if (this.envLoadResult.error) {
      this.logger.warn({
        message: 'Failed to load env file',
        error: this.envLoadResult.error,
      });
    } else {
      this.logger.log({
        message: 'No env file found, using host environment',
        nodeEnv,
      });
    }

    // Initialize with environment variables and provided options
    this.loadBaseConfig();
  }

  /**
   * Initializes the module by loading the configurations.
   */
  async onModuleInit(): Promise<void> {
    await this.loadConfig();
  }

  /**
   * Loads base configuration from environment variables
   */
  private loadBaseConfig(): void {
    this.config = {
      // Application settings
      NODE_ENV: process.env['NODE_ENV'] || 'development',
      // eslint-disable-next-line turbo/no-undeclared-env-vars
      DEBUG: process.env['DEBUG'] === 'true',
      // eslint-disable-next-line turbo/no-undeclared-env-vars
      NEST_DEBUG: process.env['NEST_DEBUG'] === 'true',
      // eslint-disable-next-line turbo/no-undeclared-env-vars
      SERVICE_NAME: process.env.SERVICE_NAME || 'hope-api',

      // LOG configuration
      // eslint-disable-next-line turbo/no-undeclared-env-vars
      LOG_LEVEL: (process.env.LOG_LEVEL as 'debug' | 'info' | 'warn' | 'error') || 'info',
      // eslint-disable-next-line turbo/no-undeclared-env-vars
      LOG_FILE_ENABLED: process.env.LOG_FILE_ENABLED === 'true',
      // eslint-disable-next-line turbo/no-undeclared-env-vars
      LOG_FILE_PATH: process.env.LOG_FILE_PATH || './logs',
      // eslint-disable-next-line turbo/no-undeclared-env-vars
      LOG_FILE_MAX_SIZE: process.env.LOG_FILE_MAX_SIZE || '10m',
      // eslint-disable-next-line turbo/no-undeclared-env-vars
      LOG_FILE_MAX_FILES: parseInt(process.env.LOG_FILE_MAX_FILES || '1000'),
      // eslint-disable-next-line turbo/no-undeclared-env-vars
      LOG_FILE_DATE_PATTERN: process.env.LOG_FILE_DATE_PATTERN || 'yyyy-MM-dd',
      // eslint-disable-next-line turbo/no-undeclared-env-vars
      LOG_FILE_SEPARATE_ERROR: process.env.LOG_FILE_SEPARATE_ERROR === 'true',

      // Internal Services
      PORT: process.env.PORT || '8868',
      // eslint-disable-next-line turbo/no-undeclared-env-vars
      URL: process.env.URL || 'http://localhost',
      STT_V2_URL: process.env.STT_V2_URL || 'http://localhost:8861',
      // eslint-disable-next-line turbo/no-undeclared-env-vars
      TTS_PORT: process.env.TTS_PORT || '8863',
      // eslint-disable-next-line turbo/no-undeclared-env-vars
      TTS_URL: process.env.TTS_URL || 'http://localhost:8863',
      // eslint-disable-next-line turbo/no-undeclared-env-vars
      SMR_PORT: process.env.SMR_PORT || '8862',
      SMR_URL: process.env.SMR_URL || 'http://localhost:8862',
      // eslint-disable-next-line turbo/no-undeclared-env-vars
      NLP_PORT: process.env.NLP_PORT || '8864',
      NLP_URL: process.env.NLP_URL || 'http://localhost:8864',
      // eslint-disable-next-line turbo/no-undeclared-env-vars
      FEDL_PORT: process.env.FEDL_PORT || '8865',
      // eslint-disable-next-line turbo/no-undeclared-env-vars
      FEDL_URL: process.env.FEDL_URL || 'http://localhost:8865',

      // MQTT
      // eslint-disable-next-line turbo/no-undeclared-env-vars
      MQTT_HOST: process.env.MQTT_HOST || 'localhost',
      // eslint-disable-next-line turbo/no-undeclared-env-vars
      MQTT_PORT: parseInt(process.env.MQTT_PORT || '1883'),
      // eslint-disable-next-line turbo/no-undeclared-env-vars
      MQTT_USER: process.env.MQTT_USER || '',
      // eslint-disable-next-line turbo/no-undeclared-env-vars
      MQTT_PASS: process.env.MQTT_PASS || '',

      // Redis
      REDIS_HOST: process.env.REDIS_HOST || 'localhost',
      REDIS_PORT: parseInt(process.env.REDIS_PORT || '6379'),
      REDIS_PASS: process.env.REDIS_PASS || '',

      // Apply any initial values from options
      ...this.options.initialValues,
    };
  }

  /**
   * Loads the complete configuration from environment variables.
   */
  public async loadConfig(): Promise<void> {
    try {
      // Load base configuration first
      this.loadBaseConfig();

      // Overlay secret values from the SecretsService (Phase 3 Tasks 3.10/3.11).
      // Runs in onModuleInit (async), so we can await Vault/env provider.
      await this.loadVaultSecrets();

      // Validate critical configuration
      this.validateConfiguration();

      this.logger.log('Configuration loaded successfully');

      if (this.config.DEBUG) {
        this.logger.debug('Configuration summary:', {
          NODE_ENV: this.config.NODE_ENV,
        });
      }
    } catch (error) {
      this.logger.error('Failed to load configuration:', error);
      throw error;
    }
  }

  /**
   * Loads secrets from SecretsService and overlays them onto the
   * environment-derived base config. Specifically:
   *   - MQTT_PASS (Task 3.10)
   *   - REDIS_PASS (Task 3.11)
   *
   * The bulk getSecrets() call resolves both in a single round-trip
   * (already supported by SecretsService); missing keys leave the env
   * fallback in place (and aren't overwritten with empty values).
   *
   * When no SecretsService is injected (legacy test paths), the env
   * fallback established by loadBaseConfig() is the final value.
   */
  private async loadVaultSecrets(): Promise<void> {
    if (!this.secretsService) {
      this.logger.warn('SecretsService not available; skipping vault secret merge (env-only mode)');
      return;
    }
    const overrides = await this.secretsService.getSecrets(['MQTT_PASS', 'REDIS_PASS']);
    if (overrides.MQTT_PASS) this.config.MQTT_PASS = overrides.MQTT_PASS;
    if (overrides.REDIS_PASS) this.config.REDIS_PASS = overrides.REDIS_PASS;
  }

  /**
   * Validates critical configuration values
   */
  private validateConfiguration(): void {
    const errors: string[] = [];

    // Validate Redis configuration if Redis is expected to be used
    if (this.config.REDIS_HOST && this.config.REDIS_PORT) {
      if (this.config.REDIS_PORT < 1 || this.config.REDIS_PORT > 65535) {
        errors.push(`Invalid Redis port: ${this.config.REDIS_PORT}. Port must be between 1 and 65535`);
      }
    }

    if (errors.length > 0) {
      const errorMessage = `Configuration validation failed: ${errors.join(', ')}`;
      this.logger.error(errorMessage);
      throw new Error(errorMessage);
    }
  }

  /**
   * Retrieves the current application configuration.
   * @returns The current application configuration
   */
  public getConfiguration(): IAppConfig {
    return this.config;
  }

  /**
   * Reloads configuration from all sources
   * Useful for runtime configuration updates
   */
  public async reloadConfiguration(): Promise<void> {
    this.logger.log('Reloading configuration...');
    await this.loadConfig();
  }

  /**
   * Gets a specific configuration value with type safety
   * @param key - The configuration key
   * @returns The configuration value
   */
  public getConfigValue<K extends keyof IAppConfig>(key: K): IAppConfig[K] {
    return this.config[key];
  }

  /**
   * Checks if the application is running in development mode
   */
  public isDevelopment(): boolean {
    return this.config.NODE_ENV === 'development';
  }

  /**
   * Checks if the application is running in production mode
   */
  public isProduction(): boolean {
    return this.config.NODE_ENV === 'production';
  }

  /**
   * Checks if debug mode is enabled
   */
  public isDebugEnabled(): boolean {
    return this.config.DEBUG;
  }

  /**
   * Checks if Redis configuration is available and valid
   */
  public isRedisConfigured(): boolean {
    return !!(this.config.REDIS_HOST && this.config.REDIS_PORT && this.config.REDIS_PORT > 0 && this.config.REDIS_PORT <= 65535);
  }

  /**
   * Gets Redis configuration with validation
   * @throws Error if Redis configuration is invalid
   */
  public getRedisConfig(): { host: string; port: number; password?: string } {
    if (!this.isRedisConfigured()) {
      throw new Error('Redis configuration is not available or invalid. Please check REDIS_HOST and REDIS_PORT environment variables.');
    }

    return {
      host: this.config.REDIS_HOST,
      port: this.config.REDIS_PORT,
      password: this.config.REDIS_PASS || undefined,
    };
  }
}
