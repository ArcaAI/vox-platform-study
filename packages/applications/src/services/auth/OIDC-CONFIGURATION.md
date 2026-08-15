# OIDC Configuration Guide

This document provides comprehensive guidance for configuring OpenID Connect (OIDC) authentication using the AppSettingsService for database-stored configuration.

## Overview

The OIDC authentication system uses database-stored configuration via AppSettingsService, allowing runtime configuration updates without application restarts. All OIDC settings are managed through the `global_settings` table.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    OIDC Authentication Flow                     │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌─────────────────┐    ┌─────────────────┐    ┌──────────────┐ │
│  │   OIDC Provider │    │   Application   │    │   Database   │ │
│  │                 │    │                 │    │              │ │
│  │ • Discovery URL │◄──►│ • OidcStrategy  │◄──►│ • OIDC Config │ │
│  │ • Authorization │    │ • AuthModule    │    │ • JWT Config  │ │
│  │ • Token         │    │ • JWT Creation  │    │ • Settings   │ │
│  │ • UserInfo      │    │                 │    │              │ │
│  └─────────────────┘    └─────────────────┘    └──────────────┘ │
│           │                       │                       │     │
│           └───────────────────────┼───────────────────────┘     │
│                                   │                             │
│  ┌────────────────────────────────┼───────────────────────────┐ │
│  │              AppSettingsService                            │ │
│  │                                                            │ │
│  │ • Loads OIDC configuration from database                    │ │
│  │ • Provides runtime configuration updates                    │ │
│  │ • Caches settings for performance                          │ │
│  │ • Validates configuration completeness                      │ │
│  └────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
```

## Required Configuration

### Database Settings

Execute the following SQL to configure OIDC authentication:

```sql
-- OIDC Provider Configuration
INSERT INTO global_settings (key, value, description) VALUES
('OIDC_DISCOVERY_URL', 'https://your-oidc-provider.com/.well-known/openid_configuration', 'OIDC discovery URL'),
('OIDC_CLIENT_ID', 'your-oidc-client-id', 'OIDC client ID'),
('OIDC_CLIENT_SECRET', 'your-oidc-client-secret', 'OIDC client secret'),
('OIDC_CALLBACK_URL', 'http://localhost:8001/auth/callback', 'OIDC callback URL'),
('OIDC_SCOPES', 'openid profile email', 'OIDC scopes to request');

-- JWT Configuration (required for token creation)
INSERT INTO global_settings (key, value, description) VALUES
('JWT_SECRET_KEY', 'your-super-secret-jwt-key-change-in-production', 'JWT signing secret key'),
('JWT_EXPIRES_IN', '24h', 'JWT token expiration time');
```

### Configuration Parameters

| Setting              | Description                             | Example                                                     | Required |
| -------------------- | --------------------------------------- | ----------------------------------------------------------- | -------- |
| `OIDC_DISCOVERY_URL` | OIDC provider discovery endpoint        | `https://auth.example.com/.well-known/openid_configuration` | Yes      |
| `OIDC_CLIENT_ID`     | Client ID registered with OIDC provider | `my-app-client-id`                                          | Yes      |
| `OIDC_CLIENT_SECRET` | Client secret for authentication        | `super-secret-client-secret`                                | Yes      |
| `OIDC_CALLBACK_URL`  | Callback URL after authentication       | `http://localhost:8001/auth/callback`                       | Yes      |
| `OIDC_SCOPES`        | Requested scopes from OIDC provider     | `openid profile email`                                      | Yes      |
| `JWT_SECRET_KEY`     | Secret key for JWT signing              | `your-jwt-secret-key`                                       | Yes      |
| `JWT_EXPIRES_IN`     | JWT token expiration time               | `24h`                                                       | Yes      |

## OIDC Provider Setup

### Generic OIDC Provider

1. **Register your application** with your OIDC provider
2. **Configure redirect URIs** to include your callback URL
3. **Note the discovery URL** (usually ends with `/.well-known/openid_configuration`)
4. **Obtain client credentials** (client ID and secret)

### Popular OIDC Providers

#### Auth0

```sql
UPDATE global_settings SET value = 'https://your-domain.auth0.com/.well-known/openid_configuration' WHERE key = 'OIDC_DISCOVERY_URL';
UPDATE global_settings SET value = 'your-auth0-client-id' WHERE key = 'OIDC_CLIENT_ID';
UPDATE global_settings SET value = 'your-auth0-client-secret' WHERE key = 'OIDC_CLIENT_SECRET';
UPDATE global_settings SET value = 'openid profile email' WHERE key = 'OIDC_SCOPES';
```

#### Azure AD

```sql
UPDATE global_settings SET value = 'https://login.microsoftonline.com/your-tenant-id/v2.0/.well-known/openid_configuration' WHERE key = 'OIDC_DISCOVERY_URL';
UPDATE global_settings SET value = 'your-azure-client-id' WHERE key = 'OIDC_CLIENT_ID';
UPDATE global_settings SET value = 'your-azure-client-secret' WHERE key = 'OIDC_CLIENT_SECRET';
UPDATE global_settings SET value = 'openid profile email' WHERE key = 'OIDC_SCOPES';
```

#### Google

```sql
UPDATE global_settings SET value = 'https://accounts.google.com/.well-known/openid_configuration' WHERE key = 'OIDC_DISCOVERY_URL';
UPDATE global_settings SET value = 'your-google-client-id.googleusercontent.com' WHERE key = 'OIDC_CLIENT_ID';
UPDATE global_settings SET value = 'your-google-client-secret' WHERE key = 'OIDC_CLIENT_SECRET';
UPDATE global_settings SET value = 'openid profile email' WHERE key = 'OIDC_SCOPES';
```

#### Keycloak

```sql
UPDATE global_settings SET value = 'https://your-keycloak.com/auth/realms/your-realm/.well-known/openid_configuration' WHERE key = 'OIDC_DISCOVERY_URL';
UPDATE global_settings SET value = 'your-keycloak-client-id' WHERE key = 'OIDC_CLIENT_ID';
UPDATE global_settings SET value = 'your-keycloak-client-secret' WHERE key = 'OIDC_CLIENT_SECRET';
UPDATE global_settings SET value = 'openid profile email' WHERE key = 'OIDC_SCOPES';
```

## Implementation Details

### OidcStrategy Configuration

The `OidcStrategy` automatically loads configuration from AppSettingsService:

```typescript
// OIDC configuration is loaded from database
const oidcScopes = appSettingsService.getValueWithDefault('OIDC_SCOPES', 'openid profile email');
const oidcCallbackUrl = appSettingsService.getValueWithDefault('OIDC_CALLBACK_URL', 'http://localhost:8001/auth/callback');
```

### AuthServiceModule Setup

The `AuthServiceModule` creates the OIDC client using database configuration:

```typescript
{
    provide: 'OPENID_CLIENT',
    useFactory: async (appSettingsService: AppSettingsService) => {
        const oidc_discovery_url = appSettingsService.getValueFromCache('OIDC_DISCOVERY_URL');
        const oidc_client_id = appSettingsService.getValueFromCache('OIDC_CLIENT_ID');
        const oidc_client_secret = appSettingsService.getValueFromCache('OIDC_CLIENT_SECRET');
        const oidc_callback_url = appSettingsService.getValueFromCache('OIDC_CALLBACK_URL');

        const config = await discovery(new URL(oidc_discovery_url), oidc_client_id, {
            client_secret: oidc_client_secret,
            redirect_uris: [oidc_callback_url],
            response_types: ['code'],
        });
        return config;
    },
    inject: [AppSettingsService],
}
```

## Authentication Flow

### 1. User Initiation

User accesses a protected route and is redirected to OIDC provider:

```
GET /auth/login
↓
Redirect to OIDC Provider with:
- client_id
- redirect_uri (callback URL)
- scope (requested scopes)
- response_type=code
```

### 2. OIDC Provider Authentication

User authenticates with OIDC provider and is redirected back:

```
User authenticates at OIDC Provider
↓
Redirect to callback URL with authorization code:
GET /auth/callback?code=authorization_code&state=state_value
```

### 3. Token Exchange

Application exchanges authorization code for tokens:

```
POST to OIDC Provider token endpoint
- code: authorization_code
- client_id: OIDC_CLIENT_ID
- client_secret: OIDC_CLIENT_SECRET
- redirect_uri: OIDC_CALLBACK_URL
↓
Receives: access_token, id_token, refresh_token
```

### 4. User Information Retrieval

Application retrieves user information:

```
GET to OIDC Provider userinfo endpoint
Authorization: Bearer access_token
↓
Receives user profile information
```

### 5. JWT Token Creation

Application creates internal JWT token:

```typescript
const jwtToken = createJwt({
  id: user.id,
  firstName: user.firstName,
  lastName: user.lastName,
  email: user.email,
  phone: user.phone,
  jwtSecretKey: JWT_SECRET_KEY,
  expiresIn: JWT_EXPIRES_IN,
});
```

## Configuration Validation

### Health Check

Create a health check to validate OIDC configuration:

```typescript
@Injectable()
export class OidcHealthIndicator {
  constructor(@Inject(IAppSettingsService) private appSettingsService: IAppSettingsService) {}

  async checkOidcConfiguration(): Promise<{
    status: 'healthy' | 'unhealthy';
    details: any;
  }> {
    try {
      const discoveryUrl = this.appSettingsService.getValueFromCache('OIDC_DISCOVERY_URL');
      const clientId = this.appSettingsService.getValueFromCache('OIDC_CLIENT_ID');
      const clientSecret = this.appSettingsService.getValueFromCache('OIDC_CLIENT_SECRET');
      const callbackUrl = this.appSettingsService.getValueFromCache('OIDC_CALLBACK_URL');
      const scopes = this.appSettingsService.getValueFromCache('OIDC_SCOPES');

      const isHealthy = !!(discoveryUrl && clientId && clientSecret && callbackUrl && scopes);

      return {
        status: isHealthy ? 'healthy' : 'unhealthy',
        details: {
          discoveryUrlConfigured: !!discoveryUrl,
          clientIdConfigured: !!clientId,
          clientSecretConfigured: !!clientSecret,
          callbackUrlConfigured: !!callbackUrl,
          scopesConfigured: !!scopes,
          discoveryUrl: discoveryUrl ? 'Configured' : 'Missing',
          callbackUrl,
          scopes,
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

### Configuration Testing

Test OIDC configuration programmatically:

```typescript
@Injectable()
export class OidcConfigurationService {
  constructor(@Inject(IAppSettingsService) private appSettingsService: IAppSettingsService) {}

  async testOidcConfiguration(): Promise<{
    valid: boolean;
    details: any;
  }> {
    try {
      const discoveryUrl = this.appSettingsService.getValueFromCache('OIDC_DISCOVERY_URL');

      // Test discovery endpoint
      const response = await fetch(discoveryUrl);
      const discoveryDoc = await response.json();

      return {
        valid: true,
        details: {
          issuer: discoveryDoc.issuer,
          authorizationEndpoint: discoveryDoc.authorization_endpoint,
          tokenEndpoint: discoveryDoc.token_endpoint,
          userinfoEndpoint: discoveryDoc.userinfo_endpoint,
          supportedScopes: discoveryDoc.scopes_supported,
        },
      };
    } catch (error) {
      return {
        valid: false,
        details: {
          error: error instanceof Error ? error.message : String(error),
        },
      };
    }
  }
}
```

## Runtime Configuration Updates

### Updating OIDC Settings

Update OIDC configuration without application restart:

```typescript
// Update OIDC provider
await globalSettingRepository.update({ key: 'OIDC_DISCOVERY_URL' }, { value: 'https://new-provider.com/.well-known/openid_configuration' });

// Update client credentials
await globalSettingRepository.update({ key: 'OIDC_CLIENT_ID' }, { value: 'new-client-id' });

// Refresh cache to pick up changes
await appSettingsService.refreshCache();
```

### Configuration Rollback

Rollback to previous configuration if needed:

```typescript
// Rollback to previous OIDC provider
await globalSettingRepository.update({ key: 'OIDC_DISCOVERY_URL' }, { value: 'https://previous-provider.com/.well-known/openid_configuration' });

await appSettingsService.refreshCache();
```

## Security Considerations

### Client Secret Management

1. **Strong Secrets**: Use cryptographically secure client secrets
2. **Regular Rotation**: Implement regular secret rotation procedures
3. **Secure Storage**: Store secrets securely in database with proper access controls
4. **No Logging**: Never log client secrets in application logs

### Callback URL Security

1. **HTTPS Only**: Use HTTPS for callback URLs in production
2. **Exact Matching**: Configure exact callback URL matching in OIDC provider
3. **Domain Validation**: Validate callback URL domain matches application domain

### Scope Management

1. **Minimal Scopes**: Request only necessary scopes
2. **Scope Validation**: Validate received scopes match requested scopes
3. **User Consent**: Ensure proper user consent for requested scopes

## Troubleshooting

### Common Issues

#### 1. Discovery URL Not Found

```
Error: Discovery URL returned 404
```

**Solutions**:

- Verify OIDC provider URL is correct
- Check if provider supports OIDC discovery
- Ensure network connectivity to provider

#### 2. Invalid Client Credentials

```
Error: invalid_client
```

**Solutions**:

- Verify client ID and secret are correct
- Check if client is enabled in OIDC provider
- Ensure client is configured for authorization code flow

#### 3. Callback URL Mismatch

```
Error: redirect_uri_mismatch
```

**Solutions**:

- Verify callback URL matches registered URL in OIDC provider
- Check for trailing slashes or protocol mismatches
- Ensure callback URL is accessible from OIDC provider

#### 4. Invalid Scopes

```
Error: invalid_scope
```

**Solutions**:

- Verify requested scopes are supported by provider
- Check if client has permission for requested scopes
- Use standard OIDC scopes (openid, profile, email)

### Debug Mode

Enable debug logging to troubleshoot OIDC issues:

```sql
UPDATE global_settings SET value = 'true' WHERE key = 'DEBUG';
```

### Testing OIDC Flow

Test the complete OIDC flow:

```bash
# 1. Test discovery endpoint
curl https://your-oidc-provider.com/.well-known/openid_configuration

# 2. Test authorization endpoint (manual browser test)
# Navigate to: https://your-oidc-provider.com/auth?client_id=your-client&redirect_uri=your-callback&scope=openid&response_type=code

# 3. Test token endpoint (after getting authorization code)
curl -X POST https://your-oidc-provider.com/token \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=authorization_code&code=AUTH_CODE&client_id=CLIENT_ID&client_secret=CLIENT_SECRET&redirect_uri=CALLBACK_URL"
```

## Production Checklist

- [ ] Strong client secret (minimum 32 characters)
- [ ] HTTPS callback URLs
- [ ] Proper OIDC provider configuration
- [ ] Database access controls for global_settings table
- [ ] Monitoring for authentication failures
- [ ] Backup and recovery procedures for configuration
- [ ] Secret rotation procedures documented
- [ ] OIDC provider availability monitoring
- [ ] User session management configured
- [ ] Proper error handling and logging

## Migration from Environment Variables

If migrating from environment-based OIDC configuration:

1. **Export current configuration**:

   ```bash
   echo "OIDC_DISCOVERY_URL=$OIDC_DISCOVERY_URL"
   echo "OIDC_CLIENT_ID=$OIDC_CLIENT_ID"
   echo "OIDC_CLIENT_SECRET=$OIDC_CLIENT_SECRET"
   echo "OIDC_CALLBACK_URL=$OIDC_CALLBACK_URL"
   echo "OIDC_SCOPES=$OIDC_SCOPES"
   ```

2. **Insert into database**:

   ```sql
   INSERT INTO global_settings (key, value, description) VALUES
   ('OIDC_DISCOVERY_URL', 'your-current-discovery-url', 'OIDC discovery URL'),
   ('OIDC_CLIENT_ID', 'your-current-client-id', 'OIDC client ID'),
   ('OIDC_CLIENT_SECRET', 'your-current-client-secret', 'OIDC client secret'),
   ('OIDC_CALLBACK_URL', 'your-current-callback-url', 'OIDC callback URL'),
   ('OIDC_SCOPES', 'your-current-scopes', 'OIDC scopes to request');
   ```

3. **Remove from environment files**:

   ```bash
   # Remove these from .env files
   # OIDC_DISCOVERY_URL=...
   # OIDC_CLIENT_ID=...
   # OIDC_CLIENT_SECRET=...
   # OIDC_CALLBACK_URL=...
   # OIDC_SCOPES=...
   ```

4. **Test the migration**:
   - Verify OIDC authentication still works
   - Check configuration health endpoint
   - Test runtime configuration updates

This completes the OIDC configuration migration to AppSettingsService, providing better security, flexibility, and runtime configurability.
