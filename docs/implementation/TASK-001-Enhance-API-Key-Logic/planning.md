# Plan: Enhance API Key Logic

**Required Skill**: executing-plans

## Goal

Harden the API key system for production use by third-party developers: enforce scope validation, tenant isolation, user linking, rate limiting, key rotation, and comprehensive audit/monitoring.

## Architecture Overview

The enhancements follow the existing DDD architecture (Entity → Factory → Repository → Service → Controller). New capabilities are added at each layer: scope registry at the application layer, HMAC-pepper at the service layer, rate limiting via Redis, rotation fields at the schema layer, and tenant enforcement at the controller/guard layer.

## Tech Stack

- TypeScript, NestJS (API Gateway)
- Prisma 7 (PostgreSQL)
- Redis (rate limiting, caching)
- CASL (authorization integration)
- class-validator (DTO validation)

---

## Workstream 1: Security Hardening (P0)

### Task 1.1: Change `hasScope()` Default to Deny-All

**Files**:
- Modify: `packages/applications/src/services/apiKey/apikey.service.ts`
- Modify: `packages/applications/src/services/apiKey/dto/apikey-create.request.ts`

**Steps**:

1. In `apikey.service.ts`, change `hasScope()` to deny when scopes are empty:

   ```typescript
   hasScope(apiKey: ApiKeyEntity, requiredScope: string): boolean {
       const scopes = apiKey.scopes as string[] | null;

       if (!scopes || !Array.isArray(scopes) || scopes.length === 0) {
           return false; // Changed from true → false (deny by default)
       }

       if (scopes.includes('*')) {
           return true;
       }

       return scopes.some((scope) => {
           if (requiredScope === scope) return true;
           if (requiredScope.startsWith(`${scope}:`)) return true;
           return false;
       });
   }
   ```

2. In `apikey-create.request.ts`, make `scopes` required:

   ```typescript
   @ApiProperty({ description: 'Array of permissions/scopes (required)', type: [String] })
   @IsArray()
   @IsString({ each: true })
   @ArrayMinSize(1, { message: 'At least one scope is required' })
   scopes: string[];
   ```

3. Verify all seed data keys have non-empty scopes (they already do).

**Verification**: Any API key with empty/null scopes will now receive 403 on scope-protected routes.

---

### Task 1.2: Add HMAC-Pepper to Key Hashing

**Files**:
- Modify: `packages/applications/src/services/apiKey/apikey.service.ts`
- Modify: `packages/database/src/prisma/db_main/seed/02-apikey.ts`

**Steps**:

1. In `apikey.service.ts`, update `hashKey()`:

   ```typescript
   import { createHash, createHmac, randomBytes } from 'crypto';

   static hashKey(rawKey: string): string {
       const pepper = process.env.API_KEY_PEPPER;
       if (pepper) {
           return createHmac('sha256', pepper).update(rawKey).digest('hex');
       }
       return createHash('sha256').update(rawKey).digest('hex');
   }
   ```

2. In `seed/02-apikey.ts`, update `hashApiKey()` to match:

   ```typescript
   function hashApiKey(rawKey: string): string {
       const pepper = process.env.API_KEY_PEPPER;
       if (pepper) {
           return createHmac('sha256', pepper).update(rawKey).digest('hex');
       }
       return createHash('sha256').update(rawKey).digest('hex');
   }
   ```

**Verification**: With `API_KEY_PEPPER` unset, existing keys continue to work. With pepper set, new keys use HMAC. Seed must be re-run after setting pepper.

---

### Task 1.3: Disable Query Parameter API Key in Production

**Files**:
- Modify: `apps/api/src/guards/apikey.guard.ts`
- Modify: `apps/api/src/services/api-key-validation.service.ts`

**Steps**:

1. In both files, update the key extraction method:

   ```typescript
   private extractApiKeyFromRequest(request: Request): string | null {
       const apiKey =
           (request.headers['apikey'] as string) ||
           (request.headers['api-key'] as string) ||
           (request.headers['x-api-key'] as string);

       if (!apiKey && request.query.apiKey) {
           const allowQueryParam = process.env.API_KEY_ALLOW_QUERY_PARAM === 'true';
           if (!allowQueryParam) {
               this.logger.warn({
                   message: 'API key in query parameter rejected',
                   reason: 'query_param_disabled',
                   path: request.url,
               });
               return null;
           }
           return request.query.apiKey as string;
       }

       return apiKey || null;
   }
   ```

**Verification**: Without `API_KEY_ALLOW_QUERY_PARAM=true`, query parameter keys are rejected with a warning log.

---

## Workstream 2: Scope Registry & Validation

### Task 2.1: Create Scope Registry

**Files**:
- Create: `packages/applications/src/services/apiKey/apikey-scopes.registry.ts`

**Steps**:

1. Create the scope registry file:

   ```typescript
   export interface ScopeDefinition {
       description: string;
       category: string;
   }

   export const API_KEY_SCOPE_REGISTRY: Record<string, ScopeDefinition> = {
       // ── STT Service ──────────────────────────────────────────────
       'stt:transcription:read':  { description: 'Read transcription results', category: 'STT' },
       'stt:transcription:write': { description: 'Create and stream transcriptions', category: 'STT' },
       'stt:stream:write':        { description: 'Stream audio for real-time transcription', category: 'STT' },
       'stt:model:read':          { description: 'View available STT models', category: 'STT' },

       // ── Consultation ─────────────────────────────────────────────
       'consultation:session:read':  { description: 'Read consultation sessions', category: 'Consultation' },
       'consultation:session:write': { description: 'Create and manage consultation sessions', category: 'Consultation' },
       'consultation:report:read':   { description: 'Read consultation reports/summaries', category: 'Consultation' },
       'consultation:report:write':  { description: 'Generate consultation reports', category: 'Consultation' },

       // ── User (Self) ──────────────────────────────────────────────
       'user:profile:read':       { description: 'Read own user profile', category: 'User' },
       'user:preferences:read':   { description: 'Read own preferences', category: 'User' },
       'user:preferences:write':  { description: 'Update own preferences', category: 'User' },

       // ── Media ─────────────────────────────────────────────────────
       'media:file:read':   { description: 'Read/download media files', category: 'Media' },
       'media:file:write':  { description: 'Upload media files', category: 'Media' },

       // ── Admin ─────────────────────────────────────────────────────
       'admin:user:read':    { description: 'Read user information', category: 'Admin' },
       'admin:user:write':   { description: 'Manage users', category: 'Admin' },
       'admin:apikey:read':  { description: 'Read API keys', category: 'Admin' },
       'admin:apikey:write': { description: 'Manage API keys', category: 'Admin' },
       'admin:tenant:read':  { description: 'Read tenant configuration', category: 'Admin' },
       'admin:tenant:write': { description: 'Manage tenant settings', category: 'Admin' },
       'admin:audit:read':   { description: 'Read audit logs', category: 'Admin' },
       'admin:role:read':    { description: 'Read roles and policies', category: 'Admin' },
       'admin:role:write':   { description: 'Manage roles and policies', category: 'Admin' },

       // ── Webhooks ──────────────────────────────────────────────────
       'webhook:event:read':  { description: 'Read webhook events', category: 'Webhook' },
       'webhook:event:write': { description: 'Manage webhook subscriptions', category: 'Webhook' },

       // ── Wildcards ─────────────────────────────────────────────────
       'stt:*':            { description: 'Full STT service access', category: 'Wildcard' },
       'consultation:*':   { description: 'Full consultation access', category: 'Wildcard' },
       'user:*':           { description: 'Full user self-service access', category: 'Wildcard' },
       'media:*':          { description: 'Full media access', category: 'Wildcard' },
       'admin:*':          { description: 'Full admin access', category: 'Wildcard' },
       'webhook:*':        { description: 'Full webhook access', category: 'Wildcard' },
       '*':                { description: 'Unrestricted access (superadmin only)', category: 'Wildcard' },
   };

   export function isValidScope(scope: string): boolean {
       return scope in API_KEY_SCOPE_REGISTRY;
   }

   export function getAvailableScopes(): Array<{ scope: string } & ScopeDefinition> {
       return Object.entries(API_KEY_SCOPE_REGISTRY).map(([scope, def]) => ({
           scope,
           ...def,
       }));
   }

   export function getScopesByCategory(): Record<string, Array<{ scope: string; description: string }>> {
       const result: Record<string, Array<{ scope: string; description: string }>> = {};
       for (const [scope, def] of Object.entries(API_KEY_SCOPE_REGISTRY)) {
           if (!result[def.category]) result[def.category] = [];
           result[def.category].push({ scope, description: def.description });
       }
       return result;
   }
   ```

2. Export from the service barrel:

   ```typescript
   // In packages/applications/src/services/apiKey/index.ts
   export * from './apikey-scopes.registry';
   ```

---

### Task 2.2: Add Scope Validation to DTOs

**Files**:
- Create: `packages/applications/src/services/apiKey/validators/valid-scopes.validator.ts`
- Modify: `packages/applications/src/services/apiKey/dto/apikey-create.request.ts`
- Modify: `packages/applications/src/services/apiKey/dto/apikey-update.request.ts`

**Steps**:

1. Create the custom validator:

   ```typescript
   import { ValidatorConstraint, ValidatorConstraintInterface, ValidationArguments } from 'class-validator';
   import { isValidScope, API_KEY_SCOPE_REGISTRY } from '../apikey-scopes.registry';

   @ValidatorConstraint({ name: 'validScopes', async: false })
   export class ValidScopesConstraint implements ValidatorConstraintInterface {
       validate(scopes: string[], args: ValidationArguments): boolean {
           if (!Array.isArray(scopes)) return false;
           return scopes.every((scope) => isValidScope(scope));
       }

       defaultMessage(args: ValidationArguments): string {
           const scopes = args.value as string[];
           if (!Array.isArray(scopes)) return 'Scopes must be an array of strings';
           const invalid = scopes.filter((s) => !isValidScope(s));
           const available = Object.keys(API_KEY_SCOPE_REGISTRY).join(', ');
           return `Invalid scope(s): ${invalid.join(', ')}. Available scopes: ${available}`;
       }
   }
   ```

2. Apply to `CreateApiKeyRequest`:

   ```typescript
   import { ArrayMinSize, Validate } from 'class-validator';
   import { ValidScopesConstraint } from '../validators/valid-scopes.validator';

   @IsArray()
   @IsString({ each: true })
   @ArrayMinSize(1, { message: 'At least one scope is required' })
   @Validate(ValidScopesConstraint)
   scopes: string[];
   ```

3. Apply to `UpdateApiKeyRequest` (optional field, but validated when present):

   ```typescript
   @IsArray()
   @IsString({ each: true })
   @ArrayMinSize(1, { message: 'At least one scope is required when updating scopes' })
   @Validate(ValidScopesConstraint)
   @IsOptional()
   scopes?: string[];
   ```

---

### Task 2.3: Add Scope Listing Endpoint

**Files**:
- Modify: `apps/api/src/modules/api-key/api-key.controller.ts`

**Steps**:

1. Add endpoint before other routes (to avoid `:id` param conflict):

   ```typescript
   @Get('scopes')
   @ApiResponse({ status: 200, description: 'Available API key scopes' })
   @CanRead('ApiKey')
   async getAvailableScopes(): Promise<Record<string, Array<{ scope: string; description: string }>>> {
       return getScopesByCategory();
   }
   ```

---

### Task 2.4: Update Seed Data with Structured Scopes

**Files**:
- Modify: `packages/database/src/prisma/db_main/seed/02-apikey.ts`

**Steps**:

1. Update each key's scopes to use the registry format. Example for SDK_DOCTOR:

   ```typescript
   {
       id: SEED_API_KEY_IDS.SDK_DOCTOR,
       rawKey: SEED_API_KEY_RAW.SDK_DOCTOR,
       keyName: 'SDK Test API Key',
       keyType: ApiKeyType.SDK,
       keyStatus: ApiKeyStatus.ACTIVE,
       description: 'SDK API key for development and testing - linked to doctor user',
       environment: 'development',
       tenantId: SEED_TENANT_ID,
       userId: SEED_USER_IDS.DOCTOR,
       scopes: [
           'stt:transcription:read',
           'stt:transcription:write',
           'stt:stream:write',
           'consultation:session:read',
           'consultation:session:write',
           'consultation:report:read',
           'user:preferences:read',
           'user:preferences:write',
           'media:file:read',
           'media:file:write',
       ],
       rateLimit: 1000,
   },
   ```

---

## Workstream 3: Tenant Isolation Enforcement

### Task 3.1: Add Tenant Filtering to Controller

**Files**:
- Modify: `apps/api/src/modules/api-key/api-key.controller.ts`

**Steps**:

1. Inject `ClsService` into the controller:

   ```typescript
   import { ClsService } from 'nestjs-cls';
   import { IActiveUserContext } from '@arcaai/applications';

   constructor(
       @Inject(IApiKeyService)
       private readonly apiKeyService: IApiKeyService,
       private readonly clsService: ClsService<IActiveUserContext>,
   ) {}
   ```

2. Update `fetchAll` to use tenant-scoped query:

   ```typescript
   @CanList('ApiKey')
   async fetchAll(@Query() queryParams: PaginatedQuery): Promise<PaginatedApiKeyResponse> {
       const tenantId = this.clsService.get('tenantId');
       const result = tenantId
           ? await this.apiKeyService.fetchAllByTenantId({
                 ...queryParams,
                 tenantId,
                 sort: queryParams.sort || 'updatedAt:desc',
             })
           : await this.apiKeyService.fetchAll({
                 ...queryParams,
                 sort: queryParams.sort || 'updatedAt:desc',
             });
       return ApiKeyDtoMapper.ToPaginatedResponse(result);
   }
   ```

   Note: The fallback to unscoped `fetchAll` is for SUPER_ADMIN users who may not have a tenant context. The CASL policy already restricts non-admin users.

---

### Task 3.2: Add Tenant Validation on Create

**Files**:
- Modify: `packages/applications/src/services/apiKey/apikey.service.ts`

**Steps**:

1. Add validation at the start of `create()`:

   ```typescript
   async create(request: CreateApiKeyRequest): Promise<CreateApiKeyResult> {
       const keyType = request.keyType ?? ApiKeyType.SDK;
       const tenantId = this.tenantId;

       if (!tenantId && keyType !== ApiKeyType.SERVICE_ACCOUNT) {
           throw new ArgumentInvalidException(
               'API keys must be created within a tenant context. ' +
               'Only SERVICE_ACCOUNT keys can be created without a tenant.'
           );
       }

       // ... rest of create logic
   }
   ```

---

## Workstream 4: User Linking & Lifecycle

### Task 4.1: Add Prisma FK Relation

**Files**:
- Modify: `packages/database/src/prisma/db_main/apikey.prisma`
- Modify: `packages/database/src/prisma/db_main/user.prisma`

**Steps**:

1. In `apikey.prisma`, add relation and new field:

   ```prisma
   // Relations
   userId          String?
   User            User?    @relation("_User_ApiKeys", fields: [userId], references: [id], onDelete: SetNull)

   originalCreatorId String?
   ```

2. In `user.prisma`, add the inverse relation to the User model:

   ```prisma
   // In the User model, add to relations section:
   ApiKeys  ApiKey[]  @relation("_User_ApiKeys")
   ```

3. Generate and review migration:

   ```bash
   cd packages/database
   npx prisma migrate dev --name add_apikey_user_relation
   ```

---

### Task 4.2: Enforce userId on Creation

**Files**:
- Modify: `packages/applications/src/services/apiKey/apikey.service.ts`

**Steps**:

1. Add validation in `create()` after tenant validation:

   ```typescript
   const userId = this.requestUser?.id ?? null;

   if (!userId && keyType !== ApiKeyType.SERVICE_ACCOUNT) {
       throw new ArgumentInvalidException(
           'API keys must be linked to the creating user. ' +
           'Only SERVICE_ACCOUNT keys can be created without a user context.'
       );
   }
   ```

---

### Task 4.3: Handle User Deletion

**Files**:
- Create: `packages/applications/src/services/apiKey/apikey.event-handlers.ts`
- Modify: `packages/applications/src/services/apiKey/apikey.service.module.ts`

**Steps**:

1. Create event handler:

   ```typescript
   import { Injectable, Logger, Inject } from '@nestjs/common';
   import { OnEvent } from '@nestjs/event-emitter';
   import { ApiKeyRepository, ApiKeyStatus, SysEventType } from '@arcaai/domains';
   import { EventEmitter2 } from '@nestjs/event-emitter';

   @Injectable()
   export class ApiKeyEventHandlers {
       private readonly logger = new Logger(ApiKeyEventHandlers.name);

       constructor(
           private readonly apiKeyRepository: ApiKeyRepository,
           private readonly eventEmitter: EventEmitter2,
       ) {}

       @OnEvent('user.deleted')
       async handleUserDeleted(payload: { userId: string; tenantId?: string }): Promise<void> {
           const { userId } = payload;

           this.logger.log({
               message: 'Handling user deletion for API keys',
               userId,
           });

           const userKeys = await this.apiKeyRepository.findAll({
               where: {
                   userId,
                   keyStatus: ApiKeyStatus.ACTIVE,
               },
           });

           if (userKeys.length === 0) {
               this.logger.debug({ message: 'No active API keys for deleted user', userId });
               return;
           }

           for (const key of userKeys) {
               key.keyStatus = ApiKeyStatus.INACTIVE;
               key.metaData = {
                   ...(key.metaData as object || {}),
                   deactivationReason: 'owner_deleted',
                   previousOwnerId: userId,
                   deactivatedAt: new Date().toISOString(),
               };
               await this.apiKeyRepository.update(key.id, key);
           }

           this.eventEmitter.emit('sys.event', {
               type: SysEventType.ResourceUpdated,
               data: {
                   action: 'bulk_deactivation',
                   reason: 'owner_deleted',
                   userId,
                   affectedKeyCount: userKeys.length,
                   affectedKeyIds: userKeys.map(k => k.id),
               },
           });

           this.logger.warn({
               message: 'API keys deactivated due to user deletion',
               userId,
               keyCount: userKeys.length,
           });
       }
   }
   ```

2. Register in module:

   ```typescript
   // In apikey.service.module.ts
   providers: [ApiKeyService, ApiKeyEventHandlers, /* ... */],
   ```

---

### Task 4.4: Add Ownership Transfer Endpoint

**Files**:
- Modify: `packages/applications/src/services/apiKey/IApiKeyService.ts`
- Modify: `packages/applications/src/services/apiKey/apikey.service.ts`
- Modify: `apps/api/src/modules/api-key/api-key.controller.ts`

**Steps**:

1. Add to interface:

   ```typescript
   transferOwnership(id: EntityId, newUserId: string): Promise<ApiKeyEntity>;
   ```

2. Implement in service:

   ```typescript
   async transferOwnership(id: EntityId, newUserId: string): Promise<ApiKeyEntity> {
       const apiKey = await this.apiKeyRepository.findById(id);
       const previousUserId = apiKey.userId;

       apiKey.userId = newUserId;
       if (!apiKey.originalCreatorId) {
           apiKey.originalCreatorId = previousUserId;
       }
       apiKey.metaData = {
           ...(apiKey.metaData as object || {}),
           ownershipTransfers: [
               ...((apiKey.metaData as any)?.ownershipTransfers || []),
               {
                   from: previousUserId,
                   to: newUserId,
                   transferredAt: new Date().toISOString(),
                   transferredBy: this.requestUser?.id,
               },
           ],
       };

       const updated = await this.apiKeyRepository.update(id, apiKey);

       this.broadcastSysEvent(SysEventType.ResourceUpdated, {
           resourceId: updated.id,
           data: {
               action: 'ownership_transfer',
               previousUserId,
               newUserId,
               transferredBy: this.requestUser?.id,
           },
       });

       return updated;
   }
   ```

3. Add controller endpoint:

   ```typescript
   @ApiEndpoint({
       returnedModel: ApiKeyResponse,
       method: HttpMethod.POST,
       path: ':id/transfer',
       by: ['id'],
   })
   @ApiParam({ name: 'id', description: 'API Key ID', type: String })
   @ApiResponse({ status: 200, description: 'Ownership transferred' })
   @CanUpdate('ApiKey')
   async transferOwnership(
       @Param('id') id: string,
       @Body() body: { newUserId: string },
   ): Promise<ApiKeyResponse> {
       const result = await this.apiKeyService.transferOwnership(id, body.newUserId);
       return ApiKeyDtoMapper.ToResponse(result);
   }
   ```

---

## Workstream 5: Rate Limiting (Redis)

### Task 5.1: Create Rate Limiter Service

**Files**:
- Create: `packages/applications/src/services/apiKey/apikey-rate-limiter.service.ts`
- Create: `packages/applications/src/services/apiKey/apikey-rate-limiter.service.module.ts`

**Steps**:

1. Create the service:

   ```typescript
   import { Injectable, Logger, Inject, Optional } from '@nestjs/common';
   import { IRedisCacheService } from '../../services/baseServices/redis';

   export interface RateLimitResult {
       allowed: boolean;
       remaining: number;
       limit: number;
       resetAt: Date;
   }

   export const IApiKeyRateLimiter = Symbol('IApiKeyRateLimiter');

   @Injectable()
   export class ApiKeyRateLimiter {
       private readonly logger = new Logger(ApiKeyRateLimiter.name);
       private readonly WINDOW_MS = 60_000; // 1-minute window

       constructor(
           @Optional() @Inject(IRedisCacheService) private readonly redis?: IRedisCacheService,
       ) {}

       async checkRateLimit(
           apiKeyId: string,
           tenantId: string,
           limit: number,
       ): Promise<RateLimitResult> {
           if (!limit || limit <= 0) {
               return { allowed: true, remaining: Infinity, limit: 0, resetAt: new Date() };
           }

           if (!this.redis?.isConnected()) {
               this.logger.warn({ message: 'Rate limiting skipped — Redis unavailable' });
               return { allowed: true, remaining: limit, limit, resetAt: new Date() };
           }

           const now = Date.now();
           const windowKey = `ratelimit:${tenantId}:${apiKeyId}:${Math.floor(now / this.WINDOW_MS)}`;

           try {
               const current = await this.redis.incr(windowKey);
               if (current === 1) {
                   await this.redis.expire(windowKey, Math.ceil(this.WINDOW_MS / 1000) + 1);
               }

               const resetAt = new Date((Math.floor(now / this.WINDOW_MS) + 1) * this.WINDOW_MS);

               return {
                   allowed: current <= limit,
                   remaining: Math.max(0, limit - current),
                   limit,
                   resetAt,
               };
           } catch (error) {
               this.logger.error({
                   message: 'Rate limit check failed',
                   apiKeyId,
                   error: error instanceof Error ? error.message : String(error),
               });
               return { allowed: true, remaining: limit, limit, resetAt: new Date() };
           }
       }
   }
   ```

---

### Task 5.2: Integrate Rate Limiter into Validation Service

**Files**:
- Modify: `apps/api/src/services/api-key-validation.service.ts`

**Steps**:

1. Inject rate limiter and check after key validation:

   ```typescript
   constructor(
       @Inject(IApiKeyService) private readonly apiKeyService: IApiKeyService,
       @Inject(IApiKeyRateLimiter) private readonly rateLimiter: ApiKeyRateLimiter,
   ) {}

   async validateApiKey(/* ... */): Promise<ApiKeyValidationResult> {
       // ... existing validation ...

       // Rate limit check
       if (apiKeyEntity.rateLimit && apiKeyEntity.rateLimit > 0) {
           const rateResult = await this.rateLimiter.checkRateLimit(
               apiKeyEntity.id,
               apiKeyEntity.tenantId || 'global',
               apiKeyEntity.rateLimit,
           );

           if (!rateResult.allowed) {
               throw new HttpException(
                   {
                       statusCode: 429,
                       message: 'Rate limit exceeded',
                       retryAfter: Math.ceil((rateResult.resetAt.getTime() - Date.now()) / 1000),
                   },
                   429,
               );
           }

           // Attach rate limit info for response headers
           validationResult.rateLimit = rateResult;
       }

       return validationResult;
   }
   ```

---

### Task 5.3: Fix Usage Endpoint

**Files**:
- Modify: `apps/api/src/modules/api-key/api-key.controller.ts`

**Steps**:

1. Inject rate limiter and return real-time stats:

   ```typescript
   @CanRead('ApiKey')
   async getUsage(@Param('id') id: string): Promise<{
       totalCalls: number;
       lastUsedAt: Date | null;
       rateLimitRemaining: number;
       rateLimitTotal: number;
       windowResetAt: Date | null;
   }> {
       const apiKey = await this.apiKeyService.fetchById(id);
       const mapped = ApiKeyDtoMapper.ToResponse(apiKey);
       const rateLimit = mapped.rateLimit ?? 0;

       let remaining = rateLimit;
       let resetAt: Date | null = null;

       if (rateLimit > 0) {
           const rateResult = await this.rateLimiter.checkRateLimit(
               id,
               mapped.tenantId || 'global',
               rateLimit,
           );
           remaining = rateResult.remaining;
           resetAt = rateResult.resetAt;
       }

       return {
           totalCalls: mapped.usageCount ?? 0,
           lastUsedAt: mapped.lastUsedAt ?? null,
           rateLimitRemaining: remaining,
           rateLimitTotal: rateLimit,
           windowResetAt: resetAt,
       };
   }
   ```

---

### Task 5.4: Optimize Usage Tracking

**Files**:
- Modify: `packages/applications/src/services/apiKey/apikey.service.ts`

**Steps**:

1. Replace the read-then-write pattern with atomic increment. Add a direct Prisma method to the repository or use the database service:

   ```typescript
   async updateUsage(apiKeyId: string, ipAddress?: string): Promise<void> {
       try {
           // Atomic increment — no extra read required
           const db = this.apiKeyRepository.$();
           await db.Where({ id: apiKeyId }).Update({
               lastUsedAt: new Date(),
               usageCount: { increment: 1 },
           });

           this.broadcastSysEvent(SysEventType.ResourceUpdated, {
               resourceId: apiKeyId,
               disableAuditLog: true,
               data: { ipAddress },
           });
       } catch (error) {
           this.logger.warn({
               message: 'Failed to update API key usage',
               keyId: apiKeyId,
               error: error instanceof Error ? error.message : String(error),
           });
       }
   }
   ```

   If the query builder doesn't support `{ increment: 1 }`, fall back to direct Prisma:

   ```typescript
   // Inject CoreDatabaseService
   await this.databaseService.client.apiKey.update({
       where: { id: apiKeyId },
       data: {
           lastUsedAt: new Date(),
           usageCount: { increment: 1 },
       },
   });
   ```

---

## Workstream 6: Code Quality & DRY Refactor

### Task 6.1: Refactor Guard to Delegate to Validation Service

**Files**:
- Modify: `apps/api/src/guards/apikey.guard.ts` (reduce from ~231 to ~60 lines)
- Modify: `apps/api/src/services/api-key-validation.service.ts`

**Steps**:

1. Ensure `ApiKeyValidationService` has all the logic (it mostly does already).

2. Rewrite `ApiKeyGuard` as a thin wrapper:

   ```typescript
   @Injectable()
   export class ApiKeyGuard implements CanActivate {
       private readonly logger = new Logger(ApiKeyGuard.name);

       constructor(
           private readonly reflector: Reflector,
           private readonly validationService: ApiKeyValidationService,
           private readonly clsService: ClsService<IActiveUserContext>,
       ) {}

       async canActivate(context: ExecutionContext): Promise<boolean> {
           const request = context.switchToHttp().getRequest<Request>();
           const rawApiKey = this.validationService.extractApiKeyFromRequest(request);
           const ipAddress = this.getClientIp(request);

           const requiredScopes = this.reflector.getAllAndOverride<string[]>(
               API_KEY_REQUIRED_SCOPES,
               [context.getHandler(), context.getClass()],
           );

           const { apiKeyEntity } = await this.validationService.validateApiKey(
               rawApiKey,
               ipAddress,
               requiredScopes,
           );

           request['apiKey'] = apiKeyEntity;

           if (apiKeyEntity.userId) {
               this.clsService.set('user', {
                   id: apiKeyEntity.userId,
                   tenantId: apiKeyEntity.tenantId,
               });
           }

           if (apiKeyEntity.tenantId && !this.clsService.get('tenantId')) {
               this.clsService.set('tenantId', apiKeyEntity.tenantId);
           }

           this.logger.debug({
               message: 'API key validated',
               keyId: apiKeyEntity.id,
               keyName: apiKeyEntity.keyName,
               tenantId: apiKeyEntity.tenantId,
           });

           return true;
       }

       private getClientIp(request: Request): string {
           const forwarded = request.headers['x-forwarded-for'];
           if (forwarded) {
               const ips = (typeof forwarded === 'string' ? forwarded : forwarded[0]).split(',');
               return ips[0].trim();
           }
           return request.ip || request.socket?.remoteAddress || 'unknown';
       }
   }
   ```

3. Move `getClientIp` to a shared utility if used elsewhere.

---

### Task 6.2: Use `@CanList` for List Endpoints

**Files**:
- Modify: `apps/api/src/modules/api-key/api-key.controller.ts`

**Steps**:

1. Change the `fetchAll` decorator:

   ```typescript
   // Before:
   @CanRead('ApiKey')
   async fetchAll(...)

   // After:
   @CanList('ApiKey')
   async fetchAll(...)
   ```

---

## Workstream 7: Key Rotation & Expiration

### Task 7.1: Add Rotation Fields to Schema

**Files**:
- Modify: `packages/database/src/prisma/db_main/apikey.prisma`

**Steps**:

1. Add fields after `userId`:

   ```prisma
   // Rotation tracking
   rotatedFromKeyId  String?
   rotatedToKeyId    String?
   rotationExpiresAt DateTime?

   // Preserve original creator across ownership transfers
   originalCreatorId String?
   ```

2. Add index:

   ```prisma
   @@index([rotationExpiresAt], name: "ApiKey_rotationExpiresAt_idx")
   ```

3. Generate migration:

   ```bash
   npx prisma migrate dev --name add_apikey_rotation_fields
   ```

---

### Task 7.2: Implement Key Rotation

**Files**:
- Modify: `packages/applications/src/services/apiKey/IApiKeyService.ts`
- Modify: `packages/applications/src/services/apiKey/apikey.service.ts`

**Steps**:

1. Add to interface:

   ```typescript
   rotateKey(id: EntityId, overlapHours?: number): Promise<CreateApiKeyResult>;
   ```

2. Implement:

   ```typescript
   async rotateKey(id: EntityId, overlapHours: number = 48): Promise<CreateApiKeyResult> {
       const oldKey = await this.apiKeyRepository.findById(id);

       if (oldKey.keyStatus !== ApiKeyStatus.ACTIVE) {
           throw new ArgumentInvalidException('Only active keys can be rotated');
       }

       if (oldKey.rotatedToKeyId) {
           throw new ArgumentInvalidException('Key has already been rotated. Revoke the old key first.');
       }

       const result = await this.create({
           keyName: oldKey.keyName,
           keyType: oldKey.keyType,
           scopes: oldKey.scopes as string[],
           allowedIps: oldKey.allowedIps as string[],
           rateLimit: oldKey.rateLimit ?? undefined,
           expiresAt: oldKey.expiresAt?.toISOString(),
           description: `Rotated from ${oldKey.keyPrefix}... on ${new Date().toISOString()}`,
           environment: oldKey.environment ?? undefined,
       });

       // Link old → new
       oldKey.rotatedToKeyId = result.apiKey.id;
       oldKey.rotationExpiresAt = new Date(Date.now() + overlapHours * 60 * 60 * 1000);
       await this.apiKeyRepository.update(oldKey.id, oldKey);

       // Link new → old
       result.apiKey.rotatedFromKeyId = oldKey.id;
       await this.apiKeyRepository.update(result.apiKey.id, result.apiKey);

       this.broadcastSysEvent(SysEventType.ResourceUpdated, {
           resourceId: oldKey.id,
           data: {
               action: 'key_rotation',
               oldKeyId: oldKey.id,
               newKeyId: result.apiKey.id,
               overlapHours,
               rotationExpiresAt: oldKey.rotationExpiresAt,
           },
       });

       this.logger.log({
           message: 'API key rotated',
           oldKeyId: oldKey.id,
           newKeyId: result.apiKey.id,
           overlapHours,
       });

       return result;
   }
   ```

---

### Task 7.3: Add Rotation Endpoint

**Files**:
- Modify: `apps/api/src/modules/api-key/api-key.controller.ts`

**Steps**:

1. Add endpoint:

   ```typescript
   @ApiEndpoint({
       returnedModel: ApiKeyResponse,
       method: HttpMethod.POST,
       path: ':id/rotate',
       by: ['id'],
   })
   @ApiParam({ name: 'id', description: 'API Key ID', type: String })
   @ApiResponse({ status: 201, description: 'Key rotated. New raw key returned only once.' })
   @CanUpdate('ApiKey')
   async rotate(
       @Param('id') id: string,
       @Body() body: { overlapHours?: number },
   ): Promise<{ apiKey: ApiKeyResponse; rawKey: string }> {
       const result = await this.apiKeyService.rotateKey(id, body.overlapHours);
       return {
           apiKey: ApiKeyDtoMapper.ToResponse(result.apiKey),
           rawKey: result.rawKey,
       };
   }
   ```

---

### Task 7.4: Auto-Revoke Expired Rotated Keys

**Files**:
- Create: `packages/applications/src/services/apiKey/apikey.scheduler.ts`
- Modify: `packages/applications/src/services/apiKey/apikey.service.module.ts`

**Steps**:

1. Create scheduler:

   ```typescript
   import { Injectable, Logger, Inject } from '@nestjs/common';
   import { Cron, CronExpression } from '@nestjs/schedule';
   import { ApiKeyRepository, ApiKeyStatus, SysEventType } from '@arcaai/domains';
   import { EventEmitter2 } from '@nestjs/event-emitter';

   @Injectable()
   export class ApiKeyScheduler {
       private readonly logger = new Logger(ApiKeyScheduler.name);

       constructor(
           private readonly apiKeyRepository: ApiKeyRepository,
           private readonly eventEmitter: EventEmitter2,
       ) {}

       @Cron(CronExpression.EVERY_HOUR)
       async revokeExpiredRotatedKeys(): Promise<void> {
           this.logger.debug({ message: 'Checking for expired rotated keys' });

           const expiredKeys = await this.apiKeyRepository.findAll({
               where: {
                   rotationExpiresAt: { lte: new Date() },
                   keyStatus: ApiKeyStatus.ACTIVE,
                   rotatedToKeyId: { not: null },
               },
           });

           if (expiredKeys.length === 0) return;

           for (const key of expiredKeys) {
               key.keyStatus = ApiKeyStatus.REVOKED;
               await this.apiKeyRepository.update(key.id, key);

               this.logger.log({
                   message: 'Auto-revoked expired rotated key',
                   keyId: key.id,
                   keyName: key.keyName,
                   rotatedToKeyId: key.rotatedToKeyId,
               });
           }

           this.eventEmitter.emit('sys.event', {
               type: SysEventType.ResourceUpdated,
               data: {
                   action: 'auto_revoke_expired_rotation',
                   keyCount: expiredKeys.length,
                   keyIds: expiredKeys.map(k => k.id),
               },
           });
       }

       @Cron(CronExpression.EVERY_DAY_AT_6AM)
       async checkExpiringKeys(): Promise<void> {
           this.logger.debug({ message: 'Checking for keys expiring soon' });

           const sevenDaysFromNow = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
           const oneDayFromNow = new Date(Date.now() + 24 * 60 * 60 * 1000);

           const expiringKeys = await this.apiKeyRepository.findAll({
               where: {
                   expiresAt: { lte: sevenDaysFromNow, gt: new Date() },
                   keyStatus: ApiKeyStatus.ACTIVE,
               },
           });

           for (const key of expiringKeys) {
               const daysUntilExpiry = Math.ceil(
                   (key.expiresAt!.getTime() - Date.now()) / (24 * 60 * 60 * 1000)
               );

               this.eventEmitter.emit('sys.event', {
                   type: SysEventType.ResourceUpdated,
                   data: {
                       action: 'key_expiration_warning',
                       keyId: key.id,
                       keyName: key.keyName,
                       userId: key.userId,
                       tenantId: key.tenantId,
                       expiresAt: key.expiresAt,
                       daysUntilExpiry,
                       urgency: daysUntilExpiry <= 1 ? 'critical' : daysUntilExpiry <= 3 ? 'high' : 'medium',
                   },
               });
           }

           if (expiringKeys.length > 0) {
               this.logger.log({
                   message: 'Expiration warnings sent',
                   keyCount: expiringKeys.length,
               });
           }
       }
   }
   ```

2. Register in module:

   ```typescript
   providers: [ApiKeyService, ApiKeyEventHandlers, ApiKeyScheduler, /* ... */],
   ```

---

### Task 7.5: Enforce Mandatory Expiration

**Files**:
- Modify: `packages/applications/src/services/apiKey/apikey.service.ts`

**Steps**:

1. Define max lifetimes:

   ```typescript
   const MAX_EXPIRATION_DAYS: Record<ApiKeyType, number> = {
       [ApiKeyType.SDK]: 365,
       [ApiKeyType.WEBHOOK]: 180,
       [ApiKeyType.INTEGRATION]: 90,
       [ApiKeyType.SERVICE_ACCOUNT]: 90,
   };
   ```

2. Enforce in `create()`:

   ```typescript
   const maxDays = MAX_EXPIRATION_DAYS[keyType];
   const maxDate = new Date(Date.now() + maxDays * 24 * 60 * 60 * 1000);

   let expiresAt: Date;
   if (request.expiresAt) {
       expiresAt = new Date(request.expiresAt);
       if (expiresAt > maxDate) {
           throw new ArgumentInvalidException(
               `${keyType} keys cannot expire more than ${maxDays} days from now. ` +
               `Maximum expiration: ${maxDate.toISOString()}`
           );
       }
       if (expiresAt <= new Date()) {
           throw new ArgumentInvalidException('Expiration date must be in the future');
       }
   } else {
       expiresAt = maxDate;
   }
   ```

---

## Execution Order

The recommended execution order respects dependencies:

```
Phase 1 (Can run in parallel):
  ├── WS-1: Security Hardening
  ├── WS-2: Scope Registry & Validation
  ├── WS-3: Tenant Isolation Enforcement
  └── WS-5: Rate Limiting (Redis)

Phase 2 (Depends on WS-3):
  └── WS-4: User Linking & Lifecycle

Phase 3 (Depends on WS-1):
  └── WS-7: Key Rotation & Expiration

Phase 4 (Can run anytime, but best after WS-5):
  └── WS-6: Code Quality & DRY Refactor
```

## Estimated Total Effort

| Workstream | Tasks | Estimated Hours |
|-----------|-------|----------------|
| WS-1: Security Hardening | 3 | 2-3h |
| WS-2: Scope Registry | 4 | 4-6h |
| WS-3: Tenant Isolation | 3 | 2-3h |
| WS-4: User Linking | 4 | 4-6h |
| WS-5: Rate Limiting | 4 | 4-6h |
| WS-6: Code Quality | 2 | 2-3h |
| WS-7: Key Rotation | 5 | 6-8h |
| **Total** | **25** | **24-35h** |
