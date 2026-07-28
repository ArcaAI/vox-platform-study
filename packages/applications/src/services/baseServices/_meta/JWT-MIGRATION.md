# Authentication Configuration Migration Guide

This document outlines the migration of JWT and OIDC configuration from the ConfigService (environment variables) to the AppSettingsService (database-stored settings).

## Overview

JWT and OIDC authentication settings have been moved from static environment configuration to dynamic database configuration to allow runtime updates and better security management.

## Changes Made

### 1. Configuration Source Migration

**Before**: JWT settings were loaded from environment variables via ConfigService

```typescript
// Old approach
const jwtSecret = this.configService.getConfiguration().JWT_SECRET_KEY;
const expiresIn = this.configService.getConfiguration().JWT_EXPIRES_IN;
```

**After**: JWT settings are loaded from database via AppSettingsService

```typescript
// New approach
const jwtSecret = this.appSettingsService.getValueWithDefault('JWT_SECRET_KEY', 'default-secret-key');
const expiresIn = this.appSettingsService.getValueWithDefault('JWT_EXPIRES_IN', '1h');
```

### 2. Updated Services

#### OidcStrategy (`packages/applications/src/services/auth/oidc.strategy.ts`)

- Added `IAppSettingsService` dependency injection
- Updated JWT token creation to use AppSettingsService
- Updated OIDC configuration (scopes, callback URL) to use AppSettingsService
- Added fallback values for missing configuration

#### JwtStrategy (`packages/applications/src/services/auth/jwt.strategy.ts`)

- Added `IAppSettingsService` dependency injection
- Updated JWT secret loading with backward compatibility
- Maintains fallback to ConfigService for transition period

### 3. Configuration Interface

The `IAppConfig` interface no longer includes JWT settings as they are now managed dynamically:

```typescript
// Removed from IAppConfig:
// JWT_SECRET_KEY: string;
// JWT_EXPIRES_IN: string;
```

## Database Setup

### Required Database Records

Execute the following SQL to set up JWT configuration in your database:

```sql
-- JWT Authentication settings
INSERT INTO global_settings (key, value, description) VALUES
('JWT_SECRET_KEY', 'your-super-secret-jwt-key-change-in-production', 'JWT signing secret key'),
('JWT_EXPIRES_IN', '24h', 'JWT token expiration time');

-- OIDC Authentication settings
INSERT INTO global_settings (key, value, description) VALUES
('OIDC_DISCOVERY_URL', 'https://your-oidc-provider.com/.well-known/openid_configuration', 'OIDC discovery URL'),
('OIDC_CLIENT_ID', 'your-oidc-client-id', 'OIDC client ID'),
('OIDC_CLIENT_SECRET', 'your-oidc-client-secret', 'OIDC client secret'),
('OIDC_CALLBACK_URL', 'http://localhost:8001/auth/callback', 'OIDC callback URL'),
('OIDC_SCOPES', 'openid profile email', 'OIDC scopes to request');
```

### Production Security

For production environments, ensure you use a strong JWT secret:

```sql
-- Update with a strong, unique secret (minimum 32 characters)
UPDATE global_settings
SET value = 'your-production-jwt-secret-key-min-32-chars-long'
WHERE key = 'JWT_SECRET_KEY';
```

## Migration Steps

### 1. Database Configuration

1. **Add JWT and OIDC settings to database**:

   ```sql
   -- JWT settings
   INSERT INTO global_settings (key, value, description) VALUES
   ('JWT_SECRET_KEY', 'your-jwt-secret-key', 'JWT signing secret key'),
   ('JWT_EXPIRES_IN', '24h', 'JWT token expiration time');

   -- OIDC settings
   INSERT INTO global_settings (key, value, description) VALUES
   ('OIDC_DISCOVERY_URL', 'https://your-oidc-provider.com/.well-known/openid_configuration', 'OIDC discovery URL'),
   ('OIDC_CLIENT_ID', 'your-oidc-client-id', 'OIDC client ID'),
   ('OIDC_CLIENT_SECRET', 'your-oidc-client-secret', 'OIDC client secret'),
   ('OIDC_CALLBACK_URL', 'http://localhost:8001/auth/callback', 'OIDC callback URL'),
   ('OIDC_SCOPES', 'openid profile email', 'OIDC scopes to request');
   ```

2. **Verify settings are loaded**:
   ```typescript
   const jwtSecret = appSettingsService.getValueFromCache('JWT_SECRET_KEY');
   console.log('JWT Secret loaded:', jwtSecret ? 'Yes' : 'No');
   ```

### 2. Environment Variables (Optional)

You can remove JWT settings from your `.env` file as they are no longer used:

```bash
# These can be removed from .env
# JWT_SECRET_KEY=your-secret-key
# JWT_EXPIRES_IN=24h
```

### 3. Module Dependencies

Ensure that any modules using JWT authentication import `AppSettingsModule`:

```typescript
@Module({
  imports: [
    AppSettingsModule.forRoot(), // Required for JWT configuration
    // ... other imports
  ],
  providers: [
    OidcStrategy,
    JwtStrategy,
    // ... other providers
  ],
})
export class AuthModule {}
```

## Benefits of Migration

### 1. Runtime Configuration Updates

JWT settings can now be updated without application restart:

```typescript
// Update JWT expiration time
await globalSettingRepository.update({ key: 'JWT_EXPIRES_IN' }, { value: '12h' });

// Refresh cache to pick up changes
await appSettingsService.refreshCache();
```

### 2. Enhanced Security

- JWT secrets are stored in database, not environment files
- Easier secret rotation without deployment
- Centralized configuration management
- Audit trail for configuration changes

### 3. Environment Consistency

- Same configuration source across all environments
- No need to manage JWT settings in multiple `.env` files
- Simplified deployment process

## Backward Compatibility

The migration maintains backward compatibility:

1. **JwtStrategy** falls back to ConfigService if AppSettingsService doesn't have the setting
2. **Default values** are provided for missing configuration
3. **Graceful degradation** if database is unavailable during startup

## Testing

### Unit Tests

Update your unit tests to mock AppSettingsService:

```typescript
describe('OidcStrategy', () => {
  let strategy: OidcStrategy;
  let mockAppSettingsService: jest.Mocked<IAppSettingsService>;

  beforeEach(async () => {
    mockAppSettingsService = {
      getValueWithDefault: jest.fn(),
      // ... other methods
    };

    // Mock JWT configuration
    mockAppSettingsService.getValueWithDefault
      .mockReturnValueOnce('test-jwt-secret') // JWT_SECRET_KEY
      .mockReturnValueOnce('1h'); // JWT_EXPIRES_IN

    const module = await Test.createTestingModule({
      providers: [
        OidcStrategy,
        {
          provide: IAppSettingsService,
          useValue: mockAppSettingsService,
        },
        // ... other providers
      ],
    }).compile();

    strategy = module.get<OidcStrategy>(OidcStrategy);
  });

  it('should create JWT token with database configuration', async () => {
    // Test JWT token creation
    expect(mockAppSettingsService.getValueWithDefault).toHaveBeenCalledWith('JWT_SECRET_KEY', expect.any(String));
    expect(mockAppSettingsService.getValueWithDefault).toHaveBeenCalledWith('JWT_EXPIRES_IN', expect.any(String));
  });
});
```

### Integration Tests

Test the complete flow with database configuration:

```typescript
describe('JWT Authentication Integration', () => {
  it('should authenticate with database-configured JWT settings', async () => {
    // Setup database configuration
    await globalSettingRepository.save([
      { key: 'JWT_SECRET_KEY', value: 'test-secret-key' },
      { key: 'JWT_EXPIRES_IN', value: '1h' },
    ]);

    // Refresh app settings cache
    await appSettingsService.refreshCache();

    // Test authentication flow
    const token = await authService.login(userCredentials);
    expect(token).toBeDefined();

    // Verify token can be validated
    const decoded = await authService.validateToken(token);
    expect(decoded).toBeDefined();
  });
});
```

## Monitoring

### Configuration Health Check

Monitor JWT configuration status:

```typescript
@Injectable()
export class JwtHealthIndicator {
  constructor(@Inject(IAppSettingsService) private appSettingsService: IAppSettingsService) {}

  async checkJwtConfiguration(): Promise<{
    status: 'healthy' | 'unhealthy';
    details: any;
  }> {
    try {
      const jwtSecret = this.appSettingsService.getValueFromCache('JWT_SECRET_KEY');
      const jwtExpiresIn = this.appSettingsService.getValueFromCache('JWT_EXPIRES_IN');

      const isHealthy = !!(jwtSecret && jwtExpiresIn);

      return {
        status: isHealthy ? 'healthy' : 'unhealthy',
        details: {
          secretConfigured: !!jwtSecret,
          expirationConfigured: !!jwtExpiresIn,
          secretLength: jwtSecret ? jwtSecret.length : 0,
          expiration: jwtExpiresIn,
        },
      };
    } catch (error) {
      return {
        status: 'unhealthy',
        details: {
          error: error instanceof Error ? error.message : String(error),
        },
      };
    }
  }
}
```

## Troubleshooting

### Common Issues

1. **JWT Secret Not Found**

   ```
   Error: JWT secret not configured
   ```

   **Solution**: Ensure `JWT_SECRET_KEY` is set in global_settings table

2. **Invalid JWT Expiration**

   ```
   Error: Invalid expiration time format
   ```

   **Solution**: Use valid time format (e.g., '1h', '24h', '7d')

3. **AppSettingsService Not Available**
   ```
   Error: Cannot read property 'getValueWithDefault' of undefined
   ```
   **Solution**: Ensure AppSettingsModule is imported before auth modules

### Debug Steps

1. **Check database configuration**:

   ```sql
   SELECT * FROM global_settings WHERE key IN ('JWT_SECRET_KEY', 'JWT_EXPIRES_IN');
   ```

2. **Verify cache loading**:

   ```typescript
   const stats = appSettingsService.getCacheStats();
   console.log('Cache initialized:', stats.isInitialized);
   console.log('Settings count:', stats.settingsCount);
   ```

3. **Test JWT configuration**:
   ```typescript
   const jwtSecret = appSettingsService.getValueFromCache('JWT_SECRET_KEY');
   const jwtExpiresIn = appSettingsService.getValueFromCache('JWT_EXPIRES_IN');
   console.log('JWT Secret:', jwtSecret ? 'Configured' : 'Missing');
   console.log('JWT Expiration:', jwtExpiresIn);
   ```

## Security Considerations

### JWT Secret Management

1. **Minimum Length**: Use at least 32 characters for JWT secrets
2. **Randomness**: Generate cryptographically secure random secrets
3. **Rotation**: Implement regular secret rotation procedures
4. **Storage**: Never log or expose JWT secrets in application logs

### Production Checklist

- [ ] Strong JWT secret (minimum 32 characters)
- [ ] Appropriate token expiration time
- [ ] Database access controls for global_settings table
- [ ] Monitoring for configuration changes
- [ ] Backup and recovery procedures for configuration
- [ ] Secret rotation procedures documented

## Rollback Plan

If issues arise, you can temporarily rollback by:

1. **Add JWT settings back to environment variables**
2. **Update services to use ConfigService temporarily**
3. **Investigate and fix AppSettingsService issues**
4. **Re-migrate when ready**

The backward compatibility in JwtStrategy provides a safety net during this process.
