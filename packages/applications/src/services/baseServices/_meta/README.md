# Configuration Services Documentation

This document provides comprehensive documentation for the dual configuration system used in the HOPE platform.

## Overview

The HOPE platform uses a sophisticated dual configuration system that separates concerns between different types of configuration:

1. **ConfigService** - Handles environment variables and static application configuration
2. **AppSettingsService** - Handles database-stored settings that can be modified at runtime

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    Configuration Architecture                    │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌─────────────────┐    ┌─────────────────┐    ┌──────────────┐ │
│  │  Environment    │    │     Vault       │    │  Database    │ │
│  │   Variables     │    │    Secrets      │    │  Settings    │ │
│  │                 │    │    (future)     │    │              │ │
│  │ • .env files     │    │ • S3 config      │    │ • Runtime    │ │
│  │ • Process env   │    │ • JWT secrets   │    │   settings   │ │
│  │ • Defaults      │    │ • OIDC config    │    │ • Feature    │ │
│  │                 │    │ • DB secrets    │    │   flags       │ │
│  └─────────────────┘    └─────────────────┘    └──────────────┘ │
│           │                       │                       │     │
│           └───────────────────────┼───────────────────────┘     │
│                                   │                             │
│  ┌────────────────────────────────┼───────────────────────────┐ │
│  │            ConfigService                                    │ │
│  │                                                            │ │
│  │ • Loads env vars + vault secrets (future)                  │ │
│  │ • Provides static configuration                             │ │
│  │ • Validates critical settings                              │ │
│  │ • Available at app startup                                 │ │
│  └────────────────────────────────┼───────────────────────────┘ │
│                                   │                             │
│  ┌────────────────────────────────┼───────────────────────────┐ │
│  │         AppSettingsService                                 │ │
│  │                                                            │ │
│  │ • Loads database settings                                  │ │
│  │ • Provides runtime configuration                            │ │
│  │ • Auto-refreshes cache                                     │ │
│  │ • Available after app init                                 │ │
│  └────────────────────────────────┼───────────────────────────┘ │
│                                   │                             │
│           ┌───────────────────────┼───────────────────────────┐ │
│           │        Application Services                       │ │
│           │                                                   │ │
│           │ • Use ConfigService for static config               │ │
│           │ • Use AppSettingsService for runtime config        │ │
│           └───────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
```

## ConfigService

The `ConfigService` handles static application configuration that is loaded at startup and doesn't change during runtime.

### Features

- **Environment Variable Loading**: Automatically loads from `.env` files
- **Vault Integration**: Securely retrieves secrets from HashiCorp Vault (future)
- **Configuration Validation**: Validates critical configuration values
- **Type Safety**: Provides strongly typed configuration access
- **Progressive Loading**: Environment → Vault → Defaults

### Configuration Sources (Priority Order)

1. **Environment Variables** - Highest priority
2. **Vault Secrets** - Medium priority (only if env var not set) (future)
3. **Default Values** - Lowest priority

### Usage Examples

```typescript
import { Inject, Injectable } from '@nestjs/common';
import { IConfigService } from './path/to/IConfigService';

@Injectable()
export class MyService {
    constructor(@Inject(IConfigService) private configService: IConfigService) {}

    async someMethod() {
        // Get complete configuration
        const config = this.configService.getConfiguration();

        // Get specific configuration value with type safety
        const jwtSecret = this.configService.getConfigValue('JWT_SECRET_KEY');

        // Check environment
        if (this.configService.isDevelopment()) {
            console.log('Running in development mode');
        }

        // Check if debug is enabled
        if (this.configService.isDebugEnabled()) {
            console.log('Debug mode enabled');
        }

        // Reload configuration (useful for testing)
        await this.configService.reloadConfiguration();
    }
}
```

### Configuration Categories

#### Application Settings

- `NODE_ENV`: Application environment ('development', 'production')
- `DEBUG`: Enable debug logging
- `NEST_DEBUG`: Enable NestJS debug logging

#### Service URLs

- `API_APP_PORT`: API service port
- `API_APP_URL`: API service URL
- `SPEECH_APP_PORT`: Speech service port
- `SPEECH_APP_URL`: Speech service URL
- `LLM_APP_PORT`: LLM service port
- `LLM_APP_URL`: LLM service URL

### Environment File Structure

```bash
# .env file example
NODE_ENV=development
DEBUG=true

# Service URLs
API_APP_URL=http://localhost:8001
SPEECH_APP_URL=http://localhost:8002
LLM_APP_URL=http://localhost:8003
```

## AppSettingsService

The `AppSettingsService` handles dynamic configuration stored in the database that can be modified at runtime.

### Features

- **Database-Stored Settings**: Configuration stored in `GlobalSettingEntity`
- **Real-time Cache**: In-memory cache with automatic refresh
- **Event-Driven Updates**: Emits events on cache updates
- **Type-Safe Retrieval**: Supports typed value retrieval with defaults
- **Monitoring**: Provides cache statistics and health monitoring

### Usage Examples

```typescript
import { Inject, Injectable } from '@nestjs/common';
import { IAppSettingsService } from './path/to/IAppSettingsService';

@Injectable()
export class MyService {
    constructor(@Inject(IAppSettingsService) private appSettings: IAppSettingsService) {}

    async someMethod() {
        // Get a setting value with default
        const maxFileSize = this.appSettings.getValueWithDefault('MAX_FILE_SIZE', 10485760);

        // Get raw setting entity
        const setting = this.appSettings.getFromCache('FEATURE_FLAG_NEW_UI');

        // Check if setting exists
        if (this.appSettings.hasSetting('MAINTENANCE_MODE')) {
            const isMaintenanceMode = this.appSettings.getValueFromCache('MAINTENANCE_MODE');
        }

        // Get all setting keys
        const allKeys = this.appSettings.getAllKeys();

        // Force cache refresh
        await this.appSettings.refreshCache();

        // Get cache statistics
        const stats = this.appSettings.getCacheStats();
        console.log(`Cache has ${stats.settingsCount} settings, last refresh: ${stats.lastRefresh}`);

        // Validate setting value
        const isValid = this.appSettings.validateSettingValue('TIMEOUT_MS', 5000, 'number');
    }
}
```

### Cache Management

The service automatically manages an in-memory cache that:

- **Initializes on startup**: Loads all settings from database
- **Auto-refreshes**: Updates cache every 45 seconds by default
- **Emits events**: Broadcasts cache refresh and error events
- **Provides statistics**: Tracks refresh count, errors, and timing

### Event System

The service emits the following events:

```typescript
// Cache successfully refreshed
this.eventEmitter.emit('app-settings.cache-refreshed', {
    settingsCount: number,
    timestamp: Date,
});

// Cache refresh failed
this.eventEmitter.emit('app-settings.cache-error', {
    error: string,
    timestamp: Date,
});
```

### Setting Value Types

The service supports automatic parsing of different value types:

- **String**: Plain text values
- **Number**: Numeric values (integers and floats)
- **Boolean**: true/false values
- **JSON**: Complex objects stored as JSON strings

## Integration Patterns

### Service Initialization Order

1. **ConfigService** loads first during module initialization
2. **VaultService** is available for ConfigService
3. **AppSettingsService** loads after database connection is established
4. Application services can use both configuration sources

### Best Practices

#### When to Use ConfigService

- Static configuration that doesn't change during runtime
- Security-sensitive values (secrets, keys)
- Infrastructure configuration (URLs, ports)
- Environment-specific settings

#### When to Use AppSettingsService

- Feature flags that can be toggled
- Business logic configuration
- User-configurable settings
- Runtime behavior modifications

#### Configuration Hierarchy

```typescript
@Injectable()
export class ExampleService {
    constructor(
        @Inject(IConfigService) private config: IConfigService,
        @Inject(IAppSettingsService) private appSettings: IAppSettingsService,
    ) {}

    getUploadLimit(): number {
        // 1. Check database setting first (runtime configurable)
        const dbLimit = this.appSettings.getValueFromCache('UPLOAD_LIMIT_MB');
        if (dbLimit !== null) {
            return dbLimit * 1024 * 1024; // Convert MB to bytes
        }

        // 2. Fall back to environment configuration
        const envLimit = process.env.UPLOAD_LIMIT_MB;
        if (envLimit) {
            return parseInt(envLimit) * 1024 * 1024;
        }

        // 3. Use default value
        return 10 * 1024 * 1024; // 10MB default
    }
}
```

## Database Configuration Setup

### Required Settings for AppSettingsService

To configure the application properly, you need to insert the following settings into your `global_settings` table:

```sql
-- JWT Authentication settings (required for auth services)
INSERT INTO global_settings (key, value, description) VALUES
('JWT_SECRET_KEY', 'your-super-secret-jwt-key-change-in-production', 'JWT signing secret key'),
('JWT_EXPIRES_IN', '24h', 'JWT token expiration time');

-- OIDC Authentication settings (required for OIDC auth)
INSERT INTO global_settings (key, value, description) VALUES
('OIDC_DISCOVERY_URL', 'https://your-oidc-provider.com/.well-known/openid_configuration', 'OIDC discovery URL'),
('OIDC_CLIENT_ID', 'your-oidc-client-id', 'OIDC client ID'),
('OIDC_CLIENT_SECRET', 'your-oidc-client-secret', 'OIDC client secret'),
('OIDC_CALLBACK_URL', 'http://localhost:8001/auth/callback', 'OIDC callback URL'),
('OIDC_SCOPES', 'openid profile email', 'OIDC scopes to request');

-- S3/MinIO Storage settings (if using S3 service)
INSERT INTO global_settings (key, value, description) VALUES
('S3_ENDPOINT', 'http://localhost:9000', 'S3/MinIO server endpoint'),
('S3_ACCESS_KEY', 'minioadmin', 'S3/MinIO access key'),
('S3_SECRET_KEY', 'minioadmin', 'S3/MinIO secret key'),
('S3_REGION', 'us-east-1', 'S3 region'),
('S3_PUBLIC_BUCKET', 'public-files', 'Default public bucket'),
('S3_PRIVATE_BUCKET', 'private-files', 'Default private bucket'),
('S3_FORCE_PATH_STYLE', 'true', 'Force path-style URLs (required for MinIO)'),
('S3_REJECT_UNAUTHORIZED', 'false', 'Reject unauthorized SSL certificates'),
('S3_PRESIGNED_URL_EXPIRY', '3600', 'Presigned URL expiry in seconds');

-- Application settings (optional)
INSERT INTO global_settings (key, value, description) VALUES
('DEBUG', 'false', 'Enable debug logging'),
('UPLOAD_LIMIT_MB', '10', 'File upload limit in megabytes'),
('CACHE_TTL_SECONDS', '300', 'Cache time-to-live in seconds');
```

### Production Security Settings

For production environments, ensure you update these critical settings:

```sql
-- Update JWT secret with a strong, unique key
UPDATE global_settings SET value = 'your-production-jwt-secret-key-min-32-chars' WHERE key = 'JWT_SECRET_KEY';

-- Update S3 credentials for production
UPDATE global_settings SET value = 'https://your-s3-endpoint.com' WHERE key = 'S3_ENDPOINT';
UPDATE global_settings SET value = 'your-production-access-key' WHERE key = 'S3_ACCESS_KEY';
UPDATE global_settings SET value = 'your-production-secret-key' WHERE key = 'S3_SECRET_KEY';
UPDATE global_settings SET value = 'true' WHERE key = 'S3_REJECT_UNAUTHORIZED';
```

## Module Setup

### ConfigModule Setup

```typescript
import { ConfigModule } from './path/to/config.module';

@Module({
    imports: [
        ConfigModule.forRoot({
            envFilePath: '.env',
            initialValues: {
                DEBUG: true, // Override for testing
            },
        }),
    ],
})
export class AppModule {}
```

### AppSettingsModule Setup

```typescript
import { AppSettingsModule } from './path/to/appSettings.module';

@Module({
    imports: [AppSettingsModule.forRoot()],
})
export class AppModule {}
```

## Monitoring and Debugging

### Configuration Validation

The ConfigService validates critical configuration on startup:

```typescript
// Example validation errors
Configuration validation failed: JWT_SECRET_KEY is required for authentication, S3_ENDPOINT is required when S3 is configured
```

### Cache Monitoring

Monitor AppSettingsService cache health:

```typescript
const stats = appSettingsService.getCacheStats();
console.log({
    isInitialized: stats.isInitialized,
    settingsCount: stats.settingsCount,
    refreshCount: stats.refreshCount,
    errorCount: stats.errorCount,
    lastRefresh: stats.lastRefresh,
});
```

### Debug Logging

Enable debug logging to see configuration loading details:

```bash
DEBUG=true
NEST_DEBUG=true
```

## Security Considerations

### Sensitive Configuration

- Store secrets in Vault, not environment variables
- Use environment variables only for non-sensitive configuration
- Never log sensitive configuration values
- Validate configuration to prevent injection attacks

### Access Control

- Limit access to configuration services
- Use dependency injection to control configuration access
- Implement proper error handling to avoid information leakage

## Testing

### Unit Testing Configuration Services

```typescript
describe('ConfigService', () => {
    let configService: ConfigService;
    let mockVaultService: jest.Mocked<IVaultService>;

    beforeEach(async () => {
        const module = await Test.createTestingModule({
            providers: [
                ConfigService,
                {
                    provide: IVaultService,
                    useValue: mockVaultService,
                },
                {
                    provide: 'CONFIG_OPTIONS',
                    useValue: { initialValues: { DEBUG: true } },
                },
            ],
        }).compile();

        configService = module.get<ConfigService>(ConfigService);
    });

    it('should load configuration with defaults', () => {
        const config = configService.getConfiguration();
        expect(config.DEBUG).toBe(true);
        expect(config.NODE_ENV).toBe('development');
    });
});
```

### Integration Testing

```typescript
describe('Configuration Integration', () => {
    it('should load both static and dynamic configuration', async () => {
        // Test that both services work together
        const staticConfig = configService.getConfiguration();
        const dynamicSetting = appSettingsService.getValueFromCache('TEST_SETTING');

        expect(staticConfig).toBeDefined();
        expect(dynamicSetting).toBeDefined();
    });
});
```

## Troubleshooting

### Common Issues

1. **Configuration not loading**: Check .env file path and permissions
2. **Vault connection failed**: Verify VAULT_URL and VAULT_TOKEN (future)
3. **Database settings not cached**: Check database connection and GlobalSettingEntity
4. **Type errors**: Ensure IAppConfig interface includes all required properties

### Debug Steps

1. Enable debug logging: `DEBUG=true`
2. Check configuration validation errors in logs
3. Verify vault connectivity (future)
4. Check database connection for AppSettingsService
5. Monitor cache refresh events

## Migration Guide

### Adding New Configuration

1. **For static configuration**:

    - Add property to `IAppConfig` interface
    - Update `ConfigService.loadBaseConfig()` method
    - Add environment variable documentation

2. **For dynamic configuration**:
    - Create `GlobalSettingEntity` record in database
    - Use `AppSettingsService` to access the value
    - Document the setting purpose and format

### Deprecating Configuration

1. Mark as deprecated in interface with `@deprecated` comment
2. Add migration logic to handle old configuration
3. Log warnings when deprecated configuration is used
4. Remove after appropriate deprecation period
