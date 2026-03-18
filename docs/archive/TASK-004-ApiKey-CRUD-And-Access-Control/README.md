# TASK-004: API Key CRUD & Access Control Enhancement

- **Ticket Number**: TASK-004
- **Created Date**: 2026-02-06
- **Last Updated**: 2026-02-06
- **Status**: Completed

## Requirement Analysis

The API Key application service (`packages/applications/src/services/apiKey/`) previously only implemented authentication-support operations (hash lookup, usage tracking, validity checks, audit logging). It was missing:

1. **Full CRUD management** - create, fetchAll, fetchById, update, delete, revoke operations
2. **IP allowlist enforcement** - `allowedIps` stored but never checked during authentication
3. **Scope enforcement** - `scopes` field stored but never enforced in the guard
4. **Key format validation** - `isValidKeyFormat()` was a stub that always returned true for keys >= 20 chars
5. **Entity validation** - `ApiKeyEntity.validate()` threw NotImplemented
6. **Guard metadata wiring** - `@ApiKeyProtected()` decorator set metadata but the guard never read it

### Acceptance Criteria

- [x] ApiKeyService implements create, fetchAll, fetchAllByTenantId, fetchById, update, deleteById, revokeKey
- [x] IApiKeyService interface includes all CRUD method signatures + isIpAllowed + hasScope
- [x] ApiKeyGuard enforces IP allowlist when `allowedIps` is configured
- [x] ApiKeyGuard enforces scope checking when `scopes` / required scopes are configured
- [x] ApiKeyGuard uses `@ApiKeyProtected()` metadata via Reflector
- [x] `isValidKeyFormat()` properly validates the `{prefix}_{type}_{randomHex}_{checksum}` structure
- [x] `ApiKeyEntity.validate()` implements business validation rules
- [x] Unit tests cover all new CRUD methods, IP allowlist, scopes, and guard enhancements

## Current State Evaluation

### Existing Implementation (before TASK-004)
- **Domain Layer**: Entity, Factory, Repository, Mapper - all complete and properly structured
- **DTOs**: CreateApiKeyRequest, UpdateApiKeyRequest, ApiKeyResponse, PaginatedApiKeyResponse - defined
- **DTO Mapper**: ApiKeyDtoMapper with ToResponse and ToPaginatedResponse - ready to use
- **Service Module**: ApiKeyServiceModule properly wired with DI
- **Auth Guard**: ApiKeyGuard authenticated keys via SHA-256 hash lookup (no IP/scope enforcement)
- **Validation Service**: ApiKeyValidationService for HTTP/WebSocket key extraction
- **Prisma Schema**: Complete with all fields, indexes, and enums

## Implementation Summary

### Files Modified

#### 1. `packages/applications/src/services/apiKey/IApiKeyService.ts`
- **Added**: `CreateApiKeyResult` interface (returns entity + raw key shown once)
- **Added**: CRUD methods: `create`, `fetchAll`, `fetchAllByTenantId`, `fetchById`, `update`, `deleteById`, `revokeKey`
- **Added**: Access control methods: `isIpAllowed`, `hasScope`
- **Preserved**: All existing authentication-support methods

#### 2. `packages/applications/src/services/apiKey/apikey.service.ts`
Complete rewrite with full implementation:
- **Key Generation**: `generateRawKey()` - cryptographically secure key generation using `crypto.randomBytes`
  - Format: `{service}_{typePrefix}_{randomHex(64)}_{checksum(6)}`
  - Type prefixes: SDK=`sk`, WEBHOOK=`wh`, INTEGRATION=`int`, SERVICE_ACCOUNT=`sa`
  - Checksum derived from SHA-256 of the random portion (fast client-side rejection)
- **CRUD**: Full lifecycle following the peer service pattern (UserService, TagService, WebhookService)
  - `create()`: Generates raw key, SHA-256 hashes it, stores hash+prefix+checksum, returns raw key once
  - `fetchAll()` / `fetchAllByTenantId()`: Paginated queries with audit events
  - `fetchById()`: Single key lookup with audit event
  - `update()`: Change tracking pattern with `updateEntity()` + `hasChanges` check
  - `deleteById()`: Soft delete via `repository.softDelete()`
  - `revokeKey()`: Sets status to REVOKED, prevents re-activation, audit logged
- **IP Allowlist**: `isIpAllowed()` supports exact match, wildcard patterns (`192.168.1.*`), and CIDR notation (`192.168.1.0/24`)
- **Scope Checking**: `hasScope()` supports exact match, wildcard (`*`), and parent scope inheritance (`stt` grants `stt:transcribe`)
- **Key Format Validation**: `isValidKeyFormat()` now validates against regex: `^[a-z]+_[a-z]+_[a-f0-9]{32,}_[a-f0-9]{6}$`
- **Preserved**: All existing methods (hashKey, extractChecksum, validateChecksum, getByKeyHash, updateUsage, isKeyValid, logKeyEvent)

#### 3. `packages/domains/src/entities/generated/core/ApiKeyEntity.ts`
- **Implemented**: `validate()` method with business rules:
  - Required: keyName (non-empty, max 255), keyHash, keyPrefix, keyType, keyStatus
  - Range: rateLimit >= 0, description max 1000 chars
  - Logic: expiresAt must be after createdAt

#### 4. `apps/api/src/guards/apikey.guard.ts`
- **Added**: IP allowlist enforcement via `enforceIpAllowlist()` → calls `apiKeyService.isIpAllowed()`
- **Added**: Scope enforcement via `enforceScopes()` using Reflector to read `API_KEY_REQUIRED_SCOPES` metadata
- **Added**: `@ApiKeyProtected()` metadata reading via `reflector.getAllAndOverride()`
- **Added**: `ForbiddenException` handling (IP/scope violations return 403, not 401)
- **Exported**: `API_KEY_REQUIRED_SCOPES` constant for decorator use

#### 5. `apps/api/src/decorators/api-key-protected.decorator.ts`
- **Enhanced**: Now accepts optional scope arguments: `@ApiKeyProtected('stt:transcribe', 'tts:synthesize')`
- Sets both `IS_API_KEY_PROTECTED` and `API_KEY_REQUIRED_SCOPES` metadata

#### 6. `apps/api/src/services/api-key-validation.service.ts`
- **Added**: IP allowlist enforcement in `validateApiKey()` flow
- **Added**: Scope enforcement in `validateApiKey()` flow
- **Added**: `requiredScopes` optional parameter to `validateApiKey()`
- **Added**: `ForbiddenException` import and handling

#### 7. `packages/applications/src/services/apiKey/__tests__/apikey.service.test.ts`
Comprehensive test suite covering:
- **Key Generation** (6 tests): Format, type prefixes, uniqueness, checksum validity
- **Hashing** (5 tests): SHA-256, consistency, collision resistance
- **Format Validation** (6 tests): Valid keys, edge cases, null/undefined
- **CRUD** (16 tests): Create, fetchAll, fetchAllByTenantId, fetchById, update, deleteById, revokeKey
- **Auth Support** (8 tests): getByKeyHash, isKeyValid, updateUsage
- **IP Allowlist** (8 tests): No config, exact match, wildcard, CIDR, /32, whitespace
- **Scope Checking** (7 tests): No config, wildcard, exact match, parent scope, child scope
- **Checksum Validation** (5 tests): Match, mismatch, null, case-sensitivity
- **Audit Logging** (3 tests): Action mapping, error resilience

### API Key Lifecycle

```
Create → ACTIVE → [Update/Use] → REVOKED (permanent)
                              → INACTIVE (can reactivate)
                              → EXPIRED (automatic)
                              → DELETED (soft delete)
```

### Security Model

| Layer | Enforcement | Description |
|-------|------------|-------------|
| **Authentication** | ApiKeyGuard | SHA-256 hash lookup, status + expiration validation |
| **IP Allowlist** | ApiKeyGuard | Exact match, wildcard, CIDR notation |
| **Scope Access** | ApiKeyGuard | Route-level scope requirements via `@ApiKeyProtected()` |
| **Audit Trail** | SysEvent | All CRUD operations and key usage events are logged |

### Build Note

After modifying `packages/applications`, run `pnpm build` in the `packages/applications` workspace to regenerate TypeScript declarations. The `apps/api` layer imports from `@arcaai/applications` and needs the updated `.d.ts` files for full type resolution.
