# SEC-001: Security Hardening Implementation Plan

| Field | Value |
|-------|-------|
| **Ticket Number** | SEC-001 |
| **Feature Name** | Security Hardening - Critical & High Priority Issues |
| **Created Date** | 2026-01-25 |
| **Last Updated** | 2026-01-25 |
| **Status** | Pending |

---

## 1. Requirement Analysis

### Background

A comprehensive security audit of the HOPE monorepo identified 8 critical and high-priority security issues that require immediate attention before production deployment. These issues span authentication, authorization, data exposure, and infrastructure security.

### Business Context

- **HIPAA Compliance**: Medical data handling requires enterprise-grade security
- **Multi-tenant Architecture**: Security vulnerabilities could lead to cross-tenant data exposure
- **SDK Distribution**: Public SDK requires secure API key management
- **Production Readiness**: These issues must be resolved before go-live

### Acceptance Criteria

- [ ] All critical vulnerabilities (4) are resolved
- [ ] All high-priority issues (4) are resolved
- [ ] No sensitive data exposed in logs
- [ ] Token revocation mechanism implemented
- [ ] Rate limiting applied to all API endpoints
- [ ] Security headers enabled by default
- [ ] All tests pass after changes
- [ ] Security review completed

---

## 2. Current State Evaluation

### Critical Issues Identified

| ID | Issue | Location | Risk Level |
|----|-------|----------|------------|
| C1 | SQL Injection via `$queryRawUnsafe` | `packages/domains/src/common/databaseServices/core/core.database.service.ts` | CRITICAL |
| C2 | Sensitive data in console.log | Multiple files | CRITICAL |
| C3 | Weak refresh token generation | `apps/api/src/controllers/auth/auth.controller.ts` | CRITICAL |
| C4 | Token revocation not implemented | `packages/applications/src/services/auth/auth.service.ts` | CRITICAL |

### High Priority Issues Identified

| ID | Issue | Location | Risk Level |
|----|-------|----------|------------|
| H1 | Unpinned dependency versions | `package.json` | HIGH |
| H2 | Security headers disabled by default | Python services | HIGH |
| H3 | API key expiration not checked | `apps/api/src/services/api-key-validation.service.ts` | HIGH |
| H4 | Rate limiting not applied globally | API Gateway | HIGH |

---

## 3. Implementation Plan

### Phase 1: Critical Security Fixes (Immediate)

#### Task C1: Remove SQL Injection Vulnerability

**Priority**: CRITICAL  
**Estimated Effort**: 2 hours  
**Files to Modify**:
- `packages/domains/src/common/databaseServices/core/core.database.service.ts`

**Implementation Steps**:

1. Remove the unsafe `query()` method that uses `$queryRawUnsafe`
2. Keep only the safe `queryRaw()` method with parameterized queries
3. Search codebase for any usages of the unsafe method
4. Update any callers to use parameterized queries

**Code Changes**:

```typescript
// REMOVE this method entirely:
async query(query: string) {
    return await this.prisma.$queryRawUnsafe(query);
}

// KEEP this safe method:
async queryRaw<T = unknown>(query: TemplateStringsArray, ...values: unknown[]): Promise<T> {
    return await this.prisma.$queryRaw<T>(query, ...values);
}
```

**Verification**:
- Run `grep -r "\.query\(" packages/` to find usages
- Run all database-related tests
- Verify no SQL injection possible via code review

---

#### Task C2: Remove Sensitive Data from Logs

**Priority**: CRITICAL  
**Estimated Effort**: 3 hours  
**Files to Modify**:
- `apps/api/src/guards/apikey.guard.ts`
- `apps/api/src/services/api-key-validation.service.ts`
- `apps/api/src/controllers/auth/auth.controller.ts`
- `apps/api/src/main.ts`

**Implementation Steps**:

1. **apikey.guard.ts (Line 82)**:
   - Remove: `console.log('apiKeyEntity', apiKeyEntity);`

2. **api-key-validation.service.ts (Line 95)**:
   - Remove: `console.log('apiKeyEntity', apiKeyEntity);`

3. **auth.controller.ts (Line 114)**:
   - Replace `console.warn` with proper logger that doesn't expose user ID in production

4. **main.ts (Lines 250-259)**:
   - Remove session configuration logging or redact sensitive values

**Code Changes**:

```typescript
// apikey.guard.ts - Line 82
// REMOVE:
console.log('apiKeyEntity', apiKeyEntity);

// REPLACE WITH (if debugging needed):
this.logger.debug('API key validated', {
    keyName: apiKeyEntity.keyName,
    tenantId: apiKeyEntity.tenantId,
    // Never log: keyHash, the actual key, or full entity
});
```

```typescript
// main.ts - Lines 250-259
// REMOVE entire console.log block:
console.log({
    secret: process.env.SESSION_SECRET_KEY || 'a-very-secret-key',
    // ... rest of config
});

// REPLACE WITH:
loggingService.debug('Session middleware configured', 'Bootstrap');
```

**Verification**:
- Run `grep -r "console\.\(log\|warn\|error\)" apps/api/src/` 
- Review each occurrence for sensitive data
- Run in development and check logs don't contain secrets

---

#### Task C3: Implement Secure Refresh Token Generation

**Priority**: CRITICAL  
**Estimated Effort**: 4 hours  
**Files to Modify**:
- `apps/api/src/controllers/auth/auth.controller.ts`
- `packages/applications/src/services/auth/auth.service.ts` (new method)
- `packages/domains/src/entities/` (new RefreshToken entity if needed)

**Implementation Steps**:

1. Create cryptographically secure refresh token generation
2. Store refresh tokens in database with expiration
3. Implement refresh token rotation on use
4. Add refresh token revocation capability

**Code Changes**:

```typescript
// auth.controller.ts - Replace generateRefreshToken method

import * as crypto from 'crypto';

/**
 * Generate cryptographically secure refresh token
 */
private async generateRefreshToken(userId: string): Promise<string> {
    // Generate 32 bytes of random data (256 bits)
    const tokenBuffer = crypto.randomBytes(32);
    const token = tokenBuffer.toString('base64url');
    
    // Create token ID for storage
    const tokenId = crypto.randomUUID();
    
    // Hash the token for storage (never store plain token)
    const tokenHash = crypto
        .createHash('sha256')
        .update(token)
        .digest('hex');
    
    // Store in database with expiration (7 days)
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 7);
    
    await this.authService.storeRefreshToken({
        id: tokenId,
        userId,
        tokenHash,
        expiresAt,
        createdAt: new Date(),
    });
    
    // Return format: tokenId.token (allows lookup + verification)
    return `${tokenId}.${token}`;
}
```

**Database Schema Addition** (if using Prisma):

```prisma
model RefreshToken {
  id        String   @id @default(uuid())
  userId    String
  tokenHash String
  expiresAt DateTime
  createdAt DateTime @default(now())
  revokedAt DateTime?
  
  User      User     @relation(fields: [userId], references: [id])
  
  @@index([userId])
  @@index([tokenHash])
  @@schema("core")
}
```

**Verification**:
- Test token generation produces unique values
- Verify tokens are stored in database
- Test token validation and rotation
- Test token revocation

---

#### Task C4: Implement Token Revocation

**Priority**: CRITICAL  
**Estimated Effort**: 4 hours  
**Files to Modify**:
- `packages/applications/src/services/auth/auth.service.ts`
- `packages/applications/src/services/auth/IAuthService.ts`
- `packages/applications/src/services/auth/jwt.strategy.ts`

**Implementation Steps**:

1. Create Redis-based token blacklist
2. Add token ID (jti) to JWT payload
3. Check blacklist on every authenticated request
4. Add revocation endpoint for logout

**Code Changes**:

```typescript
// auth.service.ts - Implement token revocation

import { Redis } from 'ioredis';

@Injectable()
export class AuthService implements IAuthService {
    private redis: Redis;
    private readonly TOKEN_BLACKLIST_PREFIX = 'token:revoked:';
    
    constructor(
        @Inject(IUserService) private readonly userService: IUserService,
        @Inject('REDIS_CLIENT') private readonly redisClient: Redis,
        private eventEmitter: EventEmitter2
    ) {
        this.redis = redisClient;
    }

    /**
     * Check if a JWT token has been revoked
     * @param tokenId - The JWT token ID (jti claim)
     * @returns Promise<boolean> - true if token is revoked
     */
    public async isTokenRevoked(tokenId: string): Promise<boolean> {
        if (!tokenId) return false;
        
        const key = `${this.TOKEN_BLACKLIST_PREFIX}${tokenId}`;
        const exists = await this.redis.exists(key);
        return exists === 1;
    }

    /**
     * Revoke a JWT token
     * @param tokenId - The JWT token ID (jti claim)
     * @param expiresIn - Token TTL in seconds (should match JWT expiration)
     */
    public async revokeToken(tokenId: string, expiresIn: number = 3600): Promise<void> {
        const key = `${this.TOKEN_BLACKLIST_PREFIX}${tokenId}`;
        // Set with expiration matching JWT lifetime
        await this.redis.setex(key, expiresIn, '1');
        
        this.eventEmitter.emit(EventTypes.TokenRevoked, { tokenId });
    }

    /**
     * Revoke all tokens for a user (force logout everywhere)
     * @param userId - The user ID
     */
    public async revokeAllUserTokens(userId: string): Promise<void> {
        // Store user's last revocation timestamp
        const key = `user:tokens:revoked:${userId}`;
        await this.redis.set(key, Date.now().toString());
        
        this.eventEmitter.emit(EventTypes.AllUserTokensRevoked, { userId });
    }
}
```

```typescript
// jwt.strategy.ts - Add token revocation check

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
    constructor(
        @Inject(IAppSettingsService) private readonly appSettingsService: IAppSettingsService,
        @Inject(IAuthService) private readonly authService: IAuthService,
        private readonly clsService: ClsService<IActiveUserContext>,
    ) {
        const jwtSecret = appSettingsService.getValueWithDefault(
            'JWT_SECRET_KEY',
            process.env.JWT_SECRET_KEY // Require env var, no weak default
        );
        
        if (!jwtSecret || jwtSecret === 'default-jwt-secret-key-change-in-production') {
            throw new Error('JWT_SECRET_KEY must be configured with a secure value');
        }

        super({
            jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
            secretOrKey: jwtSecret,
            passReqToCallback: true, // Enable request access for revocation check
        });
    }

    async validate(request: Request, payload: any): Promise<UserSession> {
        // Check if token is revoked
        if (payload.jti) {
            const isRevoked = await this.authService.isTokenRevoked(payload.jti);
            if (isRevoked) {
                throw new UnauthorizedException('Token has been revoked');
            }
        }
        
        // Check if all user tokens were revoked after this token was issued
        const userRevokedAt = await this.authService.getUserTokensRevokedAt(payload.id);
        if (userRevokedAt && payload.iat && payload.iat < userRevokedAt) {
            throw new UnauthorizedException('Session expired - please login again');
        }

        const userSession = new UserSession({
            id: payload.id,
            // ... rest of session data
        });

        this.clsService.set('user', userSession);
        return userSession;
    }
}
```

**Verification**:
- Test token revocation on logout
- Test revoked token rejection
- Test "revoke all" functionality
- Verify Redis TTL matches JWT expiration

---

### Phase 2: High Priority Fixes

#### Task H1: Pin Dependency Versions

**Priority**: HIGH  
**Estimated Effort**: 1 hour  
**Files to Modify**:
- `package.json`

**Implementation Steps**:

1. Replace `latest` with specific versions
2. Run `pnpm update` to get current versions
3. Update package.json with pinned versions

**Code Changes**:

```json
{
    "devDependencies": {
        "@types/node": "^22.10.0",
        "eslint": "^9.18.0",
        "prettier": "^3.5.3",
        "prisma": "^7.1.0",
        "rollup": "^4.40.0",
        "ts-node": "^10.9.2",
        "turbo": "^2.4.0",
        "typescript": "^5.7.3",
        "vitest": "^3.0.0"
    }
}
```

**Verification**:
- Run `pnpm install`
- Run `pnpm build`
- Run `pnpm test`

---

#### Task H2: Enable Security Headers by Default

**Priority**: HIGH  
**Estimated Effort**: 2 hours  
**Files to Modify**:
- `apps/stt/src/stt/infrastructure/middleware.py`
- `apps/tts/src/tts/infrastructure/middleware.py` (if exists)
- `apps/smr/src/smr/infrastructure/middleware.py` (if exists)
- Environment configuration documentation

**Implementation Steps**:

1. Change default value for `ENABLE_SECURITY_HEADERS` from `false` to `true`
2. Update all Python services consistently
3. Document the security headers in deployment guide

**Code Changes**:

```python
# middleware.py - Line 170
# CHANGE FROM:
self.enabled = os.getenv("ENABLE_SECURITY_HEADERS", "false").lower() == "true"

# CHANGE TO:
self.enabled = os.getenv("ENABLE_SECURITY_HEADERS", "true").lower() == "true"
```

**Verification**:
- Start each Python service
- Check response headers include security headers
- Verify no breaking changes to API consumers

---

#### Task H3: Implement API Key Expiration Check

**Priority**: HIGH  
**Estimated Effort**: 2 hours  
**Files to Modify**:
- `apps/api/src/services/api-key-validation.service.ts`
- `apps/api/src/guards/apikey.guard.ts`

**Implementation Steps**:

1. Uncomment and fix the expiration check
2. Add proper error message for expired keys
3. Add logging for expired key attempts

**Code Changes**:

```typescript
// api-key-validation.service.ts - validateApiKeyEntity method

private async validateApiKeyEntity(apiKeyEntity: ApiKeyEntity): Promise<void> {
    // Check if API key is active
    if (apiKeyEntity.keyStatus !== ApiKeyStatus.ACTIVE) {
        this.logger.warn('Inactive API key used', {
            keyName: apiKeyEntity.keyName,
            status: apiKeyEntity.keyStatus,
        });
        throw new UnauthorizedException(`API key is ${apiKeyEntity.keyStatus.toLowerCase()}`);
    }

    // Check if API key has expired
    if (apiKeyEntity.expiresAt && apiKeyEntity.expiresAt < new Date()) {
        this.logger.warn('Expired API key used', {
            keyName: apiKeyEntity.keyName,
            expiredAt: apiKeyEntity.expiresAt,
        });
        throw new UnauthorizedException('API key has expired');
    }

    // Check rate limits if configured
    if (apiKeyEntity.rateLimit) {
        // TODO: Implement rate limit check using RateLimitingService
    }

    // Check IP whitelist if configured
    // TODO: Implement IP whitelist validation
}
```

**Verification**:
- Create test API key with past expiration
- Verify request is rejected with proper message
- Verify active keys still work

---

#### Task H4: Apply Rate Limiting Globally

**Priority**: HIGH  
**Estimated Effort**: 4 hours  
**Files to Modify**:
- `apps/api/src/app.module.ts`
- `apps/api/src/interceptors/` (new rate-limit.interceptor.ts)
- `packages/applications/src/services/baseServices/rateLimiting/rate-limiting.module.ts`

**Implementation Steps**:

1. Create global rate limiting interceptor
2. Configure default rate limits
3. Allow per-endpoint override via decorators
4. Add rate limit headers to responses

**Code Changes**:

```typescript
// rate-limit.interceptor.ts (new file)

import {
    Injectable,
    NestInterceptor,
    ExecutionContext,
    CallHandler,
    HttpException,
    HttpStatus,
    Inject,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { Reflector } from '@nestjs/core';
import { RateLimitingService, RateLimitResult } from '@arcaai/applications';

export const RATE_LIMIT_KEY = 'rateLimit';
export const SKIP_RATE_LIMIT_KEY = 'skipRateLimit';

export interface RateLimitConfig {
    requests: number;
    windowMs: number;
}

@Injectable()
export class RateLimitInterceptor implements NestInterceptor {
    private readonly defaultConfig: RateLimitConfig = {
        requests: 100,
        windowMs: 60000, // 1 minute
    };

    constructor(
        private readonly reflector: Reflector,
        @Inject(RateLimitingService) private readonly rateLimitService: RateLimitingService,
    ) {}

    async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<any>> {
        // Check if rate limiting should be skipped
        const skipRateLimit = this.reflector.getAllAndOverride<boolean>(
            SKIP_RATE_LIMIT_KEY,
            [context.getHandler(), context.getClass()]
        );

        if (skipRateLimit) {
            return next.handle();
        }

        const request = context.switchToHttp().getRequest();
        const response = context.switchToHttp().getResponse();

        // Get rate limit config (endpoint-specific or default)
        const config = this.reflector.getAllAndOverride<RateLimitConfig>(
            RATE_LIMIT_KEY,
            [context.getHandler(), context.getClass()]
        ) || this.defaultConfig;

        // Determine rate limit key (prefer user ID, fallback to IP)
        const user = request.user;
        const apiKey = request.apiKey;
        const ip = request.ip || request.connection?.remoteAddress || 'unknown';
        
        const key = user?.id 
            ? `user:${user.id}` 
            : apiKey?.id 
                ? `apikey:${apiKey.id}` 
                : `ip:${ip}`;

        // Check rate limit
        const result: RateLimitResult = await this.rateLimitService.checkRateLimit(key, config);

        // Add rate limit headers
        response.setHeader('X-RateLimit-Limit', config.requests);
        response.setHeader('X-RateLimit-Remaining', result.remaining);
        response.setHeader('X-RateLimit-Reset', result.resetTime.toISOString());

        if (!result.allowed) {
            response.setHeader('Retry-After', Math.ceil((result.resetTime.getTime() - Date.now()) / 1000));
            throw new HttpException(
                {
                    statusCode: HttpStatus.TOO_MANY_REQUESTS,
                    message: 'Too many requests',
                    retryAfter: result.resetTime.toISOString(),
                },
                HttpStatus.TOO_MANY_REQUESTS
            );
        }

        return next.handle();
    }
}
```

```typescript
// app.module.ts - Add to interceptors array

import { RateLimitInterceptor } from './interceptors/rate-limit.interceptor';

const interceptors = [
    {
        provide: APP_INTERCEPTOR,
        useClass: ContextInterceptor,
    },
    {
        provide: APP_INTERCEPTOR,
        useClass: RateLimitInterceptor, // Add rate limiting
    },
    {
        provide: APP_INTERCEPTOR,
        useClass: ExceptionInterceptor,
    },
    {
        provide: APP_INTERCEPTOR,
        useClass: MaintenanceInterceptor,
    },
];
```

**Verification**:
- Test rate limiting with rapid requests
- Verify rate limit headers in responses
- Test per-endpoint override
- Verify authenticated users get separate limits

---

## 4. Implementation Summary

*To be completed after implementation*

### Files Created
- [ ] `apps/api/src/interceptors/rate-limit.interceptor.ts`
- [ ] Database migration for RefreshToken table

### Files Modified
- [ ] `packages/domains/src/common/databaseServices/core/core.database.service.ts`
- [ ] `apps/api/src/guards/apikey.guard.ts`
- [ ] `apps/api/src/services/api-key-validation.service.ts`
- [ ] `apps/api/src/controllers/auth/auth.controller.ts`
- [ ] `apps/api/src/main.ts`
- [ ] `packages/applications/src/services/auth/auth.service.ts`
- [ ] `packages/applications/src/services/auth/jwt.strategy.ts`
- [ ] `package.json`
- [ ] `apps/stt/src/stt/infrastructure/middleware.py`

### Testing Performed
- [ ] Unit tests for token generation
- [ ] Unit tests for token revocation
- [ ] Integration tests for rate limiting
- [ ] Security scan with no new vulnerabilities
- [ ] Manual testing of all auth flows

### Deployment Considerations
- Redis required for token revocation
- Database migration required for refresh tokens
- Environment variables must be updated

---

## 5. Change History

| Date | Update | Author |
|------|--------|--------|
| 2026-01-25 | Initial implementation plan created | Security Audit |

---

## 6. References

- [OWASP Authentication Cheatsheet](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html)
- [JWT Best Practices](https://auth0.com/blog/a-look-at-the-latest-draft-for-jwt-bcp/)
- [Node.js Security Best Practices](https://nodejs.org/en/docs/guides/security/)
- [Prisma Security Best Practices](https://www.prisma.io/docs/concepts/components/prisma-client/raw-database-access)
