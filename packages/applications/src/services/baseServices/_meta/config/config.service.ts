import { Inject, Injectable, OnModuleInit, Logger, Optional } from '@nestjs/common';
import { AppConfig, IConfigService } from './IConfigService';
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
  config!: AppConfig;

  /** Result of environment loading */
  private envLoadResult?: LoadEnvResult;

  /**
   * Creates an instance of ConfigService.
   * @param options - Configuration module options
   */
  constructor(
    @Inject('CONFIG_OPTIONS') private options: ConfigModuleOptions,
    // MQTT_PASS and REDIS_PASS are
    // overlaid from SecretsService in loadVaultSecrets(). Optional so
    // existing unit-test fixtures that construct the service directly
    // continue to work (they fall through to the env-only path).
    @Optional() @Inject(SecretsService) private readonly secretsService?: SecretsService,
  ) {
    this.logger.log({
      message: 'Service created',
      service: ConfigService.name,
    });

    // Load environment variables using the centralized loader.
    // Priority: options.envFilePath > ENV_FILE_PATH env var > auto-detect based on NODE_ENV.
    // The host-env-wins precedence and the CI/production skip are declared once
    // in `common/env/env-file-resolution` — never re-stated here.
    // `apps/api/src/main.ts` already called `loadEnv()` before NestFactory;
    // this call is the idempotent path for other hosts (workers, tests).
    const envFilePath = options.envFilePath || process.env['ENV_FILE_PATH'];
    const nodeEnv = getNodeEnv();

    this.envLoadResult = loadEnv({
      ...(envFilePath ? { envFilePath } : {}),
      debug: process.env['DEBUG'] === 'true',
    });

    if (this.envLoadResult.loaded) {
      this.logger.log({
        message: 'Loaded environment from file',
        envFilePath: this.envLoadResult.envFilePath,
        nodeEnv: this.envLoadResult.nodeEnv,
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
      DEBUG: process.env['DEBUG'] === 'true',
      NEST_DEBUG: process.env['NEST_DEBUG'] === 'true',
      SERVICE_NAME: process.env.SERVICE_NAME || 'hope-api',

      // LOG configuration
      LOG_LEVEL: (process.env.LOG_LEVEL as 'debug' | 'info' | 'warn' | 'error') || 'info',
      LOG_FILE_ENABLED: process.env.LOG_FILE_ENABLED === 'true',
      LOG_FILE_PATH: process.env.LOG_FILE_PATH || './logs',
      LOG_FILE_MAX_SIZE: process.env.LOG_FILE_MAX_SIZE || '10m',
      LOG_FILE_MAX_FILES: parseInt(process.env.LOG_FILE_MAX_FILES || '1000'),
      LOG_FILE_DATE_PATTERN: process.env.LOG_FILE_DATE_PATTERN || 'yyyy-MM-dd',
      LOG_FILE_SEPARATE_ERROR: process.env.LOG_FILE_SEPARATE_ERROR === 'true',

      // Auth / Registration
      REGISTRATION_SELF_SIGNUP_ENABLED: process.env.REGISTRATION_SELF_SIGNUP_ENABLED === 'true',

      // Internal Services
      PORT: process.env.PORT || '8868',
      URL: process.env.URL || 'http://localhost',
      STT_URL: process.env.STT_URL || process.env.STT_V2_URL || 'http://localhost:8861',
      TEXT_PORT: process.env.TEXT_PORT || '8862',
      TEXT_URL: process.env.TEXT_URL || 'http://localhost:8862',
      NLP_PORT: process.env.NLP_PORT || '8864',
      NLP_URL: process.env.NLP_URL || 'http://localhost:8864',
      GUARDRAIL_URL: process.env.GUARDRAIL_URL || 'http://localhost:8863',
      HARNESS_URL: process.env.HARNESS_URL || 'http://localhost:8866',
      TTS_PORT: process.env.TTS_PORT || '8865',
      TTS_URL: process.env.TTS_URL || 'http://localhost:8865',

      // MQTT
      MQTT_HOST: process.env.MQTT_HOST || 'localhost',
      MQTT_PORT: parseInt(process.env.MQTT_PORT || '1883'),
      MQTT_USER: process.env.MQTT_USER || '',
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

      // Overlay secret values from the SecretsService.
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
  public getConfiguration(): AppConfig {
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
  public getConfigValue<K extends keyof AppConfig>(key: K): AppConfig[K] {
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
