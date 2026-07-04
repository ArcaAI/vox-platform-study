# Security Audit Report: Data Layer Packages

**Audit Date**: 2026-03-24
**Last Updated**: 2026-04-06
**Scope**: `packages/database/`, `packages/domains/`, `packages/applications/`
**Auditor**: Security Auditor Agent
**HOPE Monorepo Version**: Current working branch

> **Update (2026-04-06)**: Re-scan confirmed all Critical/High findings remain open. `$queryRawUnsafe` still exposed in repository interface. `findUnique` still bypasses soft-delete filter. CryptoService still uses AES-256-CBC. Token revocation still returns `false` (TODO stub).

---

## Executive Summary

This report covers a comprehensive security audit of the three core data layer packages in the HOPE healthcare AI monorepo: the **database package** (Prisma 7 + PostgreSQL), the **domains package** (DDD entities, factories, mappers, repositories), and the **applications package** (service layer, DTOs, authorization).

### Risk Overview

| Severity | Count | Description |
|----------|-------|-------------|
| **Critical** | 2 | SQL injection via `$queryRawUnsafe`, hardcoded seed credentials |
| **High** | 5 | Hard delete paths bypass soft-delete, `findUnique` bypasses soft-delete filter, missing tenant isolation in repositories, mass assignment via `applyChangesToEntity`, AES-CBC without authentication tag |
| **Medium** | 6 | Seed data contains plaintext API key material, S3 secret key in seed defaults, `password` stored without guaranteed hashing at entity layer, missing input validation on `rawQuery` repository method, QueryBuilder Debug leaks query info, WebSocket API key extraction allows query parameter keys |
| **Low** | 4 | Entity `validate()` not called on `create()`, default salt rounds for bcrypt are low-side, audit log for READ events disabled by default, SysEvent missing schema validation |
| **Info** | 3 | Prisma driver adapter migration, CLS context dependency, openid-client pinned version |

**Overall Assessment**: The architecture is well-designed with a clear separation of concerns, soft-delete enforcement at the database layer, and proper use of Prisma parameterized queries for standard CRUD. However, **critical SQL injection risk** exists through the `rawQueryUnsafe` method exposed in both the repository and database service layers. The healthcare domain demands PHI/PII-specific protections that are currently absent (no field-level encryption, no data masking in logs/events).

---

## Package 1: `packages/database/` — Prisma 7 + PostgreSQL

### Summary Table

| # | Severity | Category | File | OWASP |
|---|----------|----------|------|-------|
| DB-001 | Info | Config | `schema.prisma` | — |
| DB-002 | Medium | Secrets | `seed/00-constants.ts` | A02 |
| DB-003 | Critical | Secrets | `seed/91-user.ts` | A07 |
| DB-004 | Medium | Secrets | `seed/06-stt.ts:1544` | A02 |
| DB-005 | High | Soft Delete | `client.ts:171-173` | A01 |
| DB-006 | Low | Config | `client.ts:61-63` | A05 |

### Detailed Findings

---

#### DB-001: Prisma 7 Driver Adapter Pattern (Info)

**Severity**: Info
**Location**: `packages/database/src/client.ts:56`
**OWASP**: —

**Description**:
The database uses Prisma 7's driver adapter pattern (`@prisma/adapter-pg`) which provides the connection string directly in application code rather than the schema file. This is the correct pattern for Prisma 7 and does not expose the connection string in the schema.

**Evidence**:
```typescript
const adapter = new PrismaPg({ connectionString });
```

**Status**: Acceptable — connection string sourced from `DATABASE_URL` env var.

---

#### DB-002: Seed Data Contains Raw API Key Material

**Severity**: Medium
**Location**: `packages/database/src/prisma/db_main/seed/00-constants.ts:169-179`
**OWASP**: A02 — Cryptographic Failures

**Description**:
The `SEED_API_KEY_RAW` constant contains plaintext raw API key values. While these are development/test seeds, if this file is accidentally used in production seeding or the values leak into logs, they provide valid authentication tokens.

**Evidence**:
```typescript
export const SEED_API_KEY_RAW = {
    SDK_DOCTOR: 'hope_sk_test_a5c5e56x54c4437fbd6ce7dee9_631238',
    SDK_DOCTOR2: 'hope_sk_test_b7d8f67y65d5548gce8df8eef0_742349',
    // ... 7 more raw keys
};
```

**Impact**: If these seeds run in production or the constants are imported outside seed context, attackers gain valid API keys.

**Recommended Fix**:
1. Add environment guards to seed runner preventing execution with `NODE_ENV=production`
2. Generate ephemeral keys at seed time rather than storing static values
3. Add `.env.production` guard that blocks seed execution

---

#### DB-003: Hardcoded Default Password in Seed Data

**Severity**: Critical
**Location**: `packages/database/src/prisma/db_main/seed/91-user.ts:39`
**OWASP**: A07 — Identification and Authentication Failures

**Description**:
All seeded users use a hardcoded password `password123`. While this is intended for development, the seed runner has no production guard, and the `migrate.sh` script runs seeds as part of the deployment pipeline.

**Evidence**:
```typescript
const defaultPassword = await hashPassword('password123');
```

The deployment migration script (`migrate.sh:15`) unconditionally runs seeds:
```bash
./packages/database/node_modules/.bin/tsx packages/database/dist/index.js
```

**Impact**: If `migrate.sh` runs in a production environment, all seeded users (including admin accounts) will have the well-known password `password123`.

**Recommended Fix**:
1. Add `NODE_ENV` check at the top of `seed/index.ts` that throws in production
2. Separate migration (`migrate deploy`) from seeding in the deployment script
3. Use environment-specific passwords or disable user seeding in production

---

#### DB-004: S3 Secret Key Hardcoded in Seed Defaults

**Severity**: Medium
**Location**: `packages/database/src/prisma/db_main/seed/06-stt.ts:1544-1545`
**OWASP**: A02 — Cryptographic Failures

**Description**:
The STT global settings seed stores the MinIO/S3 secret key with a hardcoded fallback `minio_admin` that becomes the stored value in the database if the environment variable is missing.

**Evidence**:
```typescript
{
    key: 'S3_SECRET_KEY',
    value: process.env.MINIO_SECRET_KEY || 'minio_admin',
    description: 'S3 secret key',
}
```

**Impact**: If `MINIO_SECRET_KEY` is not set during seeding, the database stores `minio_admin` as the S3 secret key, which may persist into staging/production.

**Recommended Fix**:
1. Throw an error if `MINIO_SECRET_KEY` is not set rather than falling back
2. Store a placeholder that cannot be used for authentication (e.g., `CHANGE_ME_BEFORE_PRODUCTION`)
3. Add startup validation that checks stored S3 credentials are not default values

---

#### DB-005: `findUnique` Does Not Apply Soft-Delete Filter

**Severity**: High
**Location**: `packages/database/src/client.ts:171-173`
**OWASP**: A01 — Broken Access Control

**Description**:
The soft-delete extension explicitly omits filtering from `findUnique`. The comment in `CoreDatabaseService` (line 47) acknowledges this as a "Prisma limitation", but the repository's `findById` method uses `findUnique` — meaning **all `findById` calls can return soft-deleted (DELETED) records**.

**Evidence**:
```typescript
// client.ts — soft-delete extension
async findUnique({ model, operation, args, query }) {
    // No soft-delete filter applied!
    return query(args);
},
```

```typescript
// repository.ts — findById uses findUnique
public async findById(id: EntityId): Promise<DomainEntity> {
    const model = await this.db.findUnique({
        where: { id },
        include: this._includes,
    });
```

**Impact**: Any service calling `repository.findById(id)` can access DELETED records. This means:
- Deleted consultations with PHI can still be retrieved
- Deleted users can still be looked up
- Deleted API keys can potentially be reactivated

**Recommended Fix**:
Convert `findById` to use `findFirst` with the soft-delete filter:
```typescript
public async findById(id: EntityId): Promise<DomainEntity> {
    const model = await this.db.findFirst({
        where: {
            id,
            ...(this.supportsSoftDelete ? { resourceStatus: { not: 'DELETED' } } : {}),
        },
        include: this._includes,
    });
    if (!model) {
        throw new DataNotFoundException(this.db.name || Repository.name, id);
    }
    return this._mapper.toDomainEntity(model);
}
```

---

#### DB-006: Query Logging Enabled in Development

**Severity**: Low
**Location**: `packages/database/src/client.ts:61-63`
**OWASP**: A05 — Security Misconfiguration

**Description**:
Full query logging is enabled in development mode, which may log sensitive data including PHI in query parameters.

**Evidence**:
```typescript
log: process.env.NODE_ENV === 'development'
    ? ['query', 'error', 'warn']
    : ['error'],
```

**Recommended Fix**: Ensure development environments do not process real patient data, or add query log redaction.

---

## Package 2: `packages/domains/` — DDD Entities, Factories, Mappers, Repositories

### Summary Table

| # | Severity | Category | File | OWASP |
|---|----------|----------|------|-------|
| DOM-001 | Critical | SQL Injection | `repository.ts:211-216` | A03 |
| DOM-002 | Critical | SQL Injection | `databaseServices/core/core.database.service.ts:69-70` | A03 |
| DOM-003 | High | Hard Delete | `repository.ts:142-148` | A01 |
| DOM-004 | High | Hard Delete | `NamedEntityRepository.ts:169-173` | A01 |
| DOM-005 | High | Access Control | `repository.ts` (all) | A01 |
| DOM-006 | Low | Validation | `base.entity.ts:362` | A04 |
| DOM-007 | Medium | Logging | `queryBuilder.ts:214-231` | A09 |
| DOM-008 | Medium | Data Protection | Entity layer (all) | A02 |

### Detailed Findings

---

#### DOM-001: SQL Injection via `rawQuery` / `rawQueryUnsafe` in Repository

**Severity**: Critical
**Location**: `packages/domains/src/common/repository.ts:211-216`
**OWASP**: A03 — Injection

**Description**:
The base `Repository` class exposes two raw query methods that accept unparameterized string queries. Both are part of the `IRepository` interface, meaning all 30+ repositories inherit this attack surface. The `rawQueryUnsafe` method directly calls Prisma's `$queryRawUnsafe` which performs **zero parameterization**.

**Evidence**:
```typescript
public async rawQuery(query: string): Promise<unknown> {
    return await this.db.query(query);
}

public async rawQueryUnsafe(query: string): Promise<unknown> {
    return await this.db.queryRawUnsafe(query);
}
```

The interface mandates this method:
```typescript
// IRepository.ts:43
rawQuery(query: string): Promise<unknown>;
```

**Impact**: Any service that constructs a query string with user input and passes it to `rawQuery()` or `rawQueryUnsafe()` is vulnerable to full SQL injection. In a healthcare system, this could lead to:
- Exfiltration of all patient data (PHI)
- Modification of medical records
- Privilege escalation via direct DB manipulation
- Complete database destruction

**Recommended Fix**:
1. **Remove `rawQueryUnsafe`** from the repository interface and implementation entirely
2. Replace `rawQuery` with a parameterized version:
```typescript
public async rawQuery<T>(
    query: TemplateStringsArray,
    ...values: unknown[]
): Promise<T> {
    const dbService = this._unitOfWorkService.getDatabaseService();
    return (dbService as any).$queryRaw<T>(query, ...values);
}
```
3. Audit all callers to ensure no string concatenation is used
4. Add ESLint rule to flag `$queryRawUnsafe` usage

---

#### DOM-002: SQL Injection via CoreDatabaseService.query()

**Severity**: Critical
**Location**: `packages/domains/src/common/databaseServices/core/core.database.service.ts:69-70`
**OWASP**: A03 — Injection

**Description**:
The `CoreDatabaseService` wraps Prisma's `$queryRawUnsafe` in a method called simply `query()` that accepts an unparameterized string. The `@deprecated` annotation suggests awareness of the risk, but the method remains available.

**Evidence**:
```typescript
/**
 * Execute raw SQL query (unsafe - use with caution)
 * @deprecated Prefer queryRaw for parameterized queries
 */
async query(query: string) {
    return await this.prisma.$queryRawUnsafe(query);
}
```

**Impact**: Same as DOM-001. Any code path injecting `CoreDatabaseService` and calling `.query()` with dynamic input is vulnerable.

**Recommended Fix**:
1. Remove the deprecated `query()` method
2. Ensure the safe `queryRaw()` method is the only option
3. Search the codebase for all callers and migrate them

---

#### DOM-003: Hard Delete Exposed in Base Repository

**Severity**: High
**Location**: `packages/domains/src/common/repository.ts:142-148`
**OWASP**: A01 — Broken Access Control

**Description**:
The base `Repository` class exposes a `delete()` method that performs a **hard delete** (permanent removal from the database). This method is part of the `IRepository` interface. While `softDelete()` exists alongside it, nothing prevents services from calling `delete()` instead.

**Evidence**:
```typescript
public async delete(id: EntityId): Promise<DomainEntity> {
    const model = await this.db.delete({
        where: { id },
        include: this._includes,
    });
    return this._mapper.toDomainEntity(model);
}
```

**Impact**: In a healthcare system, hard deletion of records violates:
- HIPAA data retention requirements
- Audit trail integrity
- Legal hold obligations
- Patient safety (deleted medical records)

**Recommended Fix**:
1. Remove `delete()` from the `IRepository` interface
2. Replace with `softDelete()` as the only deletion method
3. If hard delete is ever needed (e.g., GDPR right-to-erasure), create a separate `AdminRepository` with explicit authorization checks and audit logging

---

#### DOM-004: Hard Delete (deleteMany) in NamedEntityRepository

**Severity**: High
**Location**: `packages/domains/src/repositories/generated/core/NamedEntityRepository.ts:169-173`
**OWASP**: A01 — Broken Access Control

**Description**:
The `NamedEntityRepository` implements a `deleteByContextItem()` method that uses `deleteMany` to permanently remove all named entities for a context item. Named entities contain medical NER data (medications, conditions, procedures, anatomy).

**Evidence**:
```typescript
async deleteByContextItem(contextItemId: string): Promise<number> {
    const result = await (this as any).db.deleteMany({
        where: { contextItemId }
    });
    return result.count;
}
```

**Impact**: Permanent loss of medical NER data with no audit trail and no recovery path.

**Recommended Fix**: Replace with a soft-delete or archival pattern. If NamedEntity doesn't have `resourceStatus`, add it or use a separate `archivedAt` timestamp.

---

#### DOM-005: No Tenant Isolation in Repository Layer

**Severity**: High
**Location**: `packages/domains/src/common/repository.ts` (all query methods)
**OWASP**: A01 — Broken Access Control

**Description**:
The base `Repository` class performs no automatic tenant scoping. Methods like `findById`, `findAll`, `findFirst`, `update`, and `delete` operate across all tenants. Tenant isolation depends entirely on the service layer passing `where: { tenantId }` filters, which is inconsistent across services.

Only 2 of the services in `packages/applications` were found to include `tenantId` in their repository queries:
- `apikey.service.ts` — `fetchAllByTenantId` adds tenant filter
- `tenant.service.ts` — inherently tenant-scoped

All other services (consultation, user, department, etc.) rely on the CASL policy engine at the controller level, with **no defense-in-depth at the repository layer**.

**Evidence**:
```typescript
// Any service can call:
const entity = await this.repository.findById(id);
// Returns the entity regardless of tenant — no tenantId check
```

**Impact**: A bug or missing authorization check in any service allows cross-tenant data access. In multi-tenant healthcare, this means accessing another hospital's patient data.

**Recommended Fix**:
1. Add a tenant-aware repository base class that automatically injects `tenantId` from CLS context
2. Override `findById` to include tenant filter: `where: { id, tenantId }`
3. Implement defense-in-depth: repository-level + service-level + controller-level tenant checks

---

#### DOM-006: Entity `validate()` Not Called Automatically

**Severity**: Low
**Location**: `packages/domains/src/common/baseEntity/base.entity.ts:362`
**OWASP**: A04 — Insecure Design

**Description**:
`BaseEntity` declares an abstract `validate()` method, but it is never called automatically during entity construction or before persistence. Validation depends on the caller (factory or service) explicitly invoking it.

**Evidence**:
```typescript
public abstract validate(): void;
// Constructor does NOT call validate()
constructor(init: IBaseEntity) {
    this._id = init.id;
    // ... field assignments, no validate() call
}
```

**Recommended Fix**: Call `this.validate()` at the end of the `BaseEntity` constructor, or make factories responsible and audit that all factories call it.

---

#### DOM-007: QueryBuilder Debug Method Leaks Query Structure

**Severity**: Medium
**Location**: `packages/domains/src/common/queryBuilder.ts:214-231`
**OWASP**: A09 — Security Logging and Monitoring Failures

**Description**:
The `QueryBuilder.Debug()` method uses `console.log` to dump the full Prisma query structure including where clauses, which may contain PHI (patient IDs, names, medical record numbers).

**Evidence**:
```typescript
Debug(): void {
    const query = this.Build();
    console.log('Prisma Query:', JSON.stringify({
        where: query.where,
        select: query.select,
        // ...
    }, null, 2));
}
```

**Recommended Fix**: Remove or gate behind a `DEBUG` flag that is disabled in staging/production. Never log query parameters containing PHI.

---

#### DOM-008: No Field-Level Encryption for PHI

**Severity**: Medium
**Location**: All entity files in `packages/domains/src/entities/`
**OWASP**: A02 — Cryptographic Failures

**Description**:
Healthcare-sensitive fields are stored in plaintext in the database:
- `UserProfile`: `firstName`, `lastName`, `email`, `phone` (PII)
- `Consultation`: `patientId` (PHI reference)
- `ContextItem`: `content` (may contain medical transcripts, summaries — PHI)
- `NamedEntity`: `text`, `normalizedText` (medical entities — PHI)
- `User`: `password`, `secret1`, `secret2` (credentials)

While `password` is hashed at the seed level, there is no enforcement at the entity or database layer.

**Recommended Fix**:
1. Implement field-level encryption for PII fields using the existing `CryptoService`
2. At minimum, add encryption for `UserProfile.phone`, `UserProfile.email`
3. Consider column-level PostgreSQL encryption (pgcrypto) for `ContextItem.content`
4. Ensure `User.secret1` and `User.secret2` are always hashed before persistence

---

## Package 3: `packages/applications/` — Service Layer, DTOs, Authorization

### Summary Table

| # | Severity | Category | File | OWASP |
|---|----------|----------|------|-------|
| APP-001 | High | Mass Assignment | `applyChangesToEntity.ts:83-104` | A01 |
| APP-002 | High | Crypto | `crypto/crypto.service.ts:52-63` | A02 |
| APP-003 | Medium | API Key | `apikey.service.ts:789-799` | A07 |
| APP-004 | Low | Crypto | `crypto/crypto.service.ts:12` | A02 |
| APP-005 | Medium | Data Exposure | `user/user.service.ts:63-64` | A01 |
| APP-006 | Medium | Access Control | `authorization/unified-auth.guard.ts:294-299` | A07 |
| APP-007 | Low | Audit | `sysEvent/sysEvent.service.ts:244-246` | A09 |
| APP-008 | Low | Events | `common/base.service.ts:37-48` | A04 |
| APP-009 | Info | Dependencies | `package.json:76` | A06 |

### Detailed Findings

---

#### APP-001: Mass Assignment via `applyChangesToEntity`

**Severity**: High
**Location**: `packages/applications/src/common/applyChangesToEntity.ts:83-104`
**OWASP**: A01 — Broken Access Control

**Description**:
The `applyChangesToEntity` function iterates over all keys in the `changes` object and assigns them directly to the entity via `(entity as any)[key] = value`. This allows mass assignment of any field, including security-sensitive properties like `id`, `createdBy`, `createdAt`, `resourceStatus`, and `tenantId`.

While specific `resourceStatus` values are handled through dedicated methods, all other fields are blindly assigned.

**Evidence**:
```typescript
} else if (value !== undefined) {
    if (key === 'resourceStatus') {
        // Handled via switch
    } else {
        (entity as any)[key] = value;  // Mass assignment!
    }
}
```

Services pass DTO fields directly:
```typescript
// user.service.ts
this.updateEntity(user, request);  // request is the raw UpdateUserRequest DTO
```

**Impact**: If a DTO allows unexpected fields (no strict validation), an attacker can:
- Modify `id` to hijack another entity
- Change `createdBy` / `updatedBy` to impersonate
- Set `tenantId` to gain cross-tenant access
- Override `resourceStatus` timestamps

**Recommended Fix**:
1. Add a field allowlist to `applyChangesToEntity`:
```typescript
const PROTECTED_FIELDS = new Set(['id', 'createdBy', 'createdAt', 'tenantId', 'version']);

for (const key of Object.keys(changes)) {
    if (PROTECTED_FIELDS.has(key as string)) {
        throw new ForbiddenException(`Cannot modify protected field: ${key}`);
    }
    // ... existing logic
}
```
2. Ensure all DTOs use `class-validator` with `@Allow()` whitelisting
3. Use `plainToInstance` with `excludeExtraneousValues: true` in the controller layer

---

#### APP-002: AES-256-CBC Without Authentication (No AEAD)

**Severity**: High
**Location**: `packages/applications/src/services/crypto/crypto.service.ts:52-63`
**OWASP**: A02 — Cryptographic Failures

**Description**:
The `CryptoService` uses AES-256-CBC, which provides confidentiality but **not integrity**. An attacker who can modify the ciphertext (e.g., in the database or during transit) can perform a **padding oracle attack** or flip bits to alter the decrypted plaintext without detection.

**Evidence**:
```typescript
private readonly DEFAULT_ALGORITHM = 'aes-256-cbc';

async encrypt(data: string, key: string): Promise<string> {
    const iv = crypto.randomBytes(this.ivLength);
    const cipher = crypto.createCipheriv(this.algorithm, Buffer.from(key), iv);
    // No authentication tag!
    let encrypted = cipher.update(data);
    encrypted = Buffer.concat([encrypted, cipher.final()]);
    return iv.toString('hex') + ':' + encrypted.toString('hex');
}
```

**Impact**: Encrypted PHI could be tampered with without detection, violating HIPAA integrity requirements.

**Recommended Fix**:
Switch to AES-256-GCM which provides authenticated encryption:
```typescript
private readonly DEFAULT_ALGORITHM = 'aes-256-gcm';

async encrypt(data: string, key: string): Promise<string> {
    const iv = crypto.randomBytes(12); // 96-bit IV for GCM
    const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(key, 'hex'), iv);
    let encrypted = cipher.update(data, 'utf8');
    encrypted = Buffer.concat([encrypted, cipher.final()]);
    const authTag = cipher.getAuthTag();
    return `${iv.toString('hex')}:${encrypted.toString('hex')}:${authTag.toString('hex')}`;
}
```

---

#### APP-003: WebSocket API Key Extraction From Query Parameters

**Severity**: Medium
**Location**: `packages/applications/src/services/apiKey/apikey.service.ts:805-821`
**OWASP**: A07 — Identification and Authentication Failures

**Description**:
The WebSocket API key extraction method (`extractApiKeyFromWebSocket`) allows API keys in URL query parameters **without the `API_KEY_ALLOW_QUERY_PARAM` guard** that exists for HTTP requests. This means WebSocket URLs containing API keys can be logged by proxies, CDNs, and browser history.

**Evidence**:
```typescript
extractApiKeyFromWebSocket(request: ...): string | null {
    // ... header extraction
    if (!apiKey && request.url) {
        const url = new URL(request.url, 'http://localhost');
        const apiKeyFromQuery = url.searchParams.get('apiKey') || url.searchParams.get('api-key');
        if (apiKeyFromQuery) {
            return apiKeyFromQuery;  // No guard like HTTP has!
        }
    }
}
```

Compare with the HTTP method which checks `API_KEY_ALLOW_QUERY_PARAM`:
```typescript
// HTTP version has this guard
const allowQueryParam = process.env.API_KEY_ALLOW_QUERY_PARAM === 'true';
if (!allowQueryParam) { return null; }
```

**Impact**: API keys in WebSocket URLs will appear in:
- Reverse proxy access logs
- Browser developer tools / history
- Network monitoring tools
- CDN/WAF logs

**Recommended Fix**: Apply the same `API_KEY_ALLOW_QUERY_PARAM` guard to WebSocket extraction, or require WebSocket authentication via the initial HTTP upgrade handshake headers only.

---

#### APP-004: Default bcrypt Salt Rounds

**Severity**: Low
**Location**: `packages/applications/src/services/crypto/crypto.service.ts:12`
**OWASP**: A02 — Cryptographic Failures

**Description**:
The default salt rounds for bcrypt is set to 10. While this was acceptable a few years ago, current guidance recommends 12-14 rounds for healthcare applications to resist GPU-based attacks.

**Evidence**:
```typescript
private readonly DEFAULT_SALT_ROUNDS = 10;
```

**Recommended Fix**: Increase to 12 as default, configurable via app settings.

---

#### APP-005: Full User Entity Broadcast in SysEvent

**Severity**: Medium
**Location**: `packages/applications/src/services/user/user/user.service.ts:63-64`
**OWASP**: A01 — Broken Access Control

**Description**:
When creating or viewing users, the service broadcasts the entire user entity (including `password` hash, `secret1`, `secret2`) via `SysEvent`. These events are queued to Redis (BullMQ) and processed asynchronously, potentially exposing sensitive data in Redis, logs, and downstream consumers.

**Evidence**:
```typescript
// user.service.ts:60-64
this.broadcastSysEvent(SysEventType.ResourceCreated, {
    resourceId: user.id,
    createdAt: user.createdAt,
    data: user.toObject() as object  // Includes password hash, secrets!
});
```

The same pattern appears in `fetchById` (line 184-187) and `deleteById` (line 234-237).

**Impact**: Password hashes and service account secrets are stored in Redis job queues and audit log tables, accessible to any system with Redis or database read access.

**Recommended Fix**:
Create a `toSafeObject()` method on `UserEntity` that excludes sensitive fields:
```typescript
public toSafeObject(): object {
    const obj = this.toObject();
    delete obj.password;
    delete obj.secret1;
    delete obj.secret2;
    return obj;
}
```

---

#### APP-006: IP Spoofing via X-Forwarded-For

**Severity**: Medium
**Location**: `packages/applications/src/authorization/unified-auth.guard.ts:294-299`
**OWASP**: A07 — Identification and Authentication Failures

**Description**:
The `getClientIp` method trusts the first IP in `X-Forwarded-For` header without validation. An attacker can spoof this header to bypass API key IP allowlists.

**Evidence**:
```typescript
private getClientIp(request: any): string {
    const forwarded = request?.headers?.['x-forwarded-for'];
    if (forwarded) {
        const ips = (typeof forwarded === 'string' ? forwarded : forwarded[0]).split(',');
        return ips[0].trim();  // Trusts first IP — attacker-controllable!
    }
    return request?.ip || request?.socket?.remoteAddress || 'unknown';
}
```

**Impact**: An attacker can set `X-Forwarded-For: 10.0.0.1` to match an API key's `allowedIps` list, bypassing IP restrictions.

**Recommended Fix**:
1. Use the last IP in the chain (added by the trusted reverse proxy), or
2. Configure the number of trusted proxies and use the correct offset
3. In NestJS, use `app.set('trust proxy', 1)` and rely on `request.ip`

---

#### APP-007: READ Audit Logging Disabled by Default

**Severity**: Low
**Location**: `packages/applications/src/services/sysEvent/sysEvent.service.ts:244-246`
**OWASP**: A09 — Security Logging and Monitoring Failures

**Description**:
READ operations on healthcare data are not logged to the audit trail by default. This is a deliberate design decision for performance, but in healthcare compliance (HIPAA), access to PHI must be logged regardless of the operation type.

**Evidence**:
```typescript
if (!event.disableAuditLog && event.forceAuditLog) {
    this.queueAuditLogJob(jobs, event, AuditAction.READ, JobType.ResourceViewed);
}
```

**Recommended Fix**:
For PHI-containing resources (Consultation, ContextItem, NamedEntity, UserProfile), force audit logging of READ events:
```typescript
const PHI_RESOURCES = new Set(['Consultation', 'ContextItem', 'NamedEntity', 'UserProfile']);
const shouldAuditRead = event.forceAuditLog || PHI_RESOURCES.has(event.resourceType);
```

---

#### APP-008: SysEvent Payload Has No Schema Validation

**Severity**: Low
**Location**: `packages/applications/src/common/base.service.ts:37-48`
**OWASP**: A04 — Insecure Design

**Description**:
The `broadcastSysEvent` method accepts `Partial<SysEvent>` and spreads it with CLS context values. There is no validation that required fields are present or that the payload matches the expected schema. A malformed event could cause silent failures in audit logging.

**Evidence**:
```typescript
broadcastSysEvent(type: SysEventType, data: Partial<SysEvent>): void {
    this.eventEmitter.emit(type, {
        responsibleEntityId: this.requestUser?.id,
        // ...CLS defaults
        ...data,  // Caller can override anything, no validation
    });
}
```

**Recommended Fix**: Validate required fields before emitting. At minimum, warn if `resourceType` is missing.

---

#### APP-009: Pinned openid-client Version

**Severity**: Info
**Location**: `packages/applications/package.json:76`
**OWASP**: A06 — Vulnerable and Outdated Components

**Description**:
The `openid-client` dependency is pinned to `5.7.1` (not a range). This version is from 2024 and may miss security patches. Version 6.x is a major rewrite (ESM-only) which may require migration effort.

**Evidence**:
```json
"openid-client": "5.7.1",
```

**Recommended Fix**: Upgrade to the latest 5.x patch version (use `^5.7.1` range), or plan migration to `openid-client@6`.

---

## Cross-Cutting Concerns

### CC-001: No Row-Level Security (RLS) in PostgreSQL

The database schema uses application-level tenant filtering rather than PostgreSQL Row-Level Security (RLS). Given the multi-tenant healthcare deployment, RLS would provide defense-in-depth against cross-tenant access bugs.

**Recommendation**: Implement RLS policies on tables containing PHI:
```sql
ALTER TABLE "core"."Consultation" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "core"."Consultation"
    USING ("tenantId" = current_setting('app.tenant_id')::text);
```

### CC-002: Audit Log Stores Full Data Payloads

The `AuditLog` model stores `data` and `previousData` as JSONB fields without size limits or content filtering. Services broadcast full entity objects (including `toObject()` results with all fields) into audit logs.

**Risk**: Audit logs will contain unredacted PHI, password hashes, and API key metadata. This creates a secondary data store that may not have the same access controls as the primary tables.

**Recommendation**:
1. Implement a data sanitization layer in `SysEventService` before persisting to audit log
2. Define a per-resource-type field allowlist for audit data
3. Redact password hashes, secrets, and PII from audit payloads

### CC-003: No Data Masking/Redaction Framework

The codebase has no systematic approach to masking PHI in:
- Log output (Prisma query logs, application logs)
- Error messages (exception messages include query details)
- SysEvent payloads
- API responses

**Recommendation**: Implement a `DataMasker` utility and integrate it into:
- Logger transport layer
- SysEvent serialization
- Error response formatting
- DTO response mapping

### CC-004: Transaction Safety in UnitOfWork

The `UnitOfWorkService` uses CLS (Continuation-Local Storage) to store transaction clients. If a request spawns concurrent async operations, they may share the same CLS context and inadvertently use the same transaction, leading to race conditions.

**Recommendation**: Document transaction boundaries clearly and test concurrent operations within a single request.

---

## Recommendations — Prioritized

### Immediate (Critical — Fix within 24-48 hours)

1. **Remove `rawQueryUnsafe`** from `Repository` and `CoreDatabaseService` (DOM-001, DOM-002)
2. **Add production guard** to seed runner preventing execution when `NODE_ENV=production` (DB-003)
3. **Separate migration from seeding** in `migrate.sh` — only run `prisma migrate deploy` in production (DB-003)

### Short-Term (High — Fix within 1 week)

4. **Fix `findById` soft-delete bypass** by converting to `findFirst` with tenant + status filter (DB-005)
5. **Remove hard `delete()` from `IRepository`** interface, replace with `softDelete()` only (DOM-003)
6. **Fix `deleteByContextItem` in NamedEntityRepository** to use soft-delete (DOM-004)
7. **Add tenant isolation** to repository base class using CLS context (DOM-005)
8. **Add field allowlist** to `applyChangesToEntity` to prevent mass assignment (APP-001)
9. **Migrate AES-256-CBC to AES-256-GCM** in CryptoService (APP-002)
10. **Fix IP extraction** in `getClientIp` to use trusted proxy offset (APP-006)

### Medium-Term (Medium — Fix within 1 sprint)

11. **Sanitize SysEvent payloads** — create per-resource field allowlists, exclude password hashes (APP-005)
12. **Apply WebSocket API key query param guard** (APP-003)
13. **Implement PHI-aware audit logging** for READ operations on sensitive resources (APP-007)
14. **Remove S3 secret key hardcoded fallback** in seed data (DB-004)
15. **Add field-level encryption** for PII fields in UserProfile (DOM-008)
16. **Remove QueryBuilder.Debug()** or gate behind debug flag (DOM-007)

### Long-Term (Strategic — Plan for next quarter)

17. **Implement PostgreSQL Row-Level Security** for tenant isolation defense-in-depth (CC-001)
18. **Build data masking/redaction framework** for logs, events, and error responses (CC-003)
19. **Implement automated PHI detection** in audit log payloads (CC-002)
20. **Increase bcrypt salt rounds** to 12+ (APP-004)
21. **Upgrade `openid-client`** to latest patch or plan v6 migration (APP-009)
22. **Add ESLint rules** to flag `$queryRawUnsafe`, `console.log`, and unfiltered `toObject()` in event payloads

---

## OWASP Compliance Checklist

| Category | Status | Notes |
|----------|--------|-------|
| A01: Broken Access Control | ⚠️ Partial | Soft-delete bypass on findUnique, no tenant isolation at repo layer, hard delete exposed |
| A02: Cryptographic Failures | ⚠️ Partial | API key hashing is good (SHA-256 + HMAC), but AES-CBC lacks integrity, no field encryption for PHI |
| A03: Injection | ❌ Fail | `$queryRawUnsafe` exposed in repository and database service |
| A04: Insecure Design | ⚠️ Partial | Entity validation not enforced automatically, SysEvent schema not validated |
| A05: Security Misconfiguration | ✅ Pass | Environment-based config, production checks for env loading |
| A06: Vulnerable Components | ⚠️ Partial | Pinned openid-client, dependencies mostly current |
| A07: Authentication Failures | ⚠️ Partial | Good API key management, but WebSocket allows query param keys, seed passwords are weak |
| A08: Integrity Failures | ✅ Pass | CI/CD pipeline uses proper build steps |
| A09: Logging Failures | ⚠️ Partial | Good audit logging framework, but READ events skipped, PHI in log payloads |
| A10: SSRF | ✅ Pass | No URL-based external fetching in data layer |

---

## Appendix: Files Reviewed

### packages/database/
- `src/client.ts` — Prisma client configuration, soft-delete extension
- `src/env.ts` — Environment loading
- `src/index.ts` — Package exports, seed runner
- `prisma.config.ts` — Prisma configuration
- `src/prisma/db_main/schema.prisma` — Data source configuration
- `src/prisma/db_main/user.prisma` — User, UserProfile, UserSettings, UserMedia models
- `src/prisma/db_main/rbac.prisma` — Role, Policy, RolePolicy models
- `src/prisma/db_main/consultation.prisma` — Consultation, ContextItem, AudioRecording, SummaryMeta, NamedEntity models
- `src/prisma/db_main/apikey.prisma` — ApiKey model
- `src/prisma/db_main/audit.prisma` — AuditLog model
- `src/prisma/db_main/enums.prisma` — All enum definitions
- `src/prisma/db_main/tenant.prisma` — Tenant model
- `src/prisma/db_main/seed/*.ts` — All seed files
- `migrate.sh` — Production migration script
- `package.json` — Dependencies

### packages/domains/
- `src/common/baseEntity/base.entity.ts` — BaseEntity with change tracking
- `src/common/baseEntity/base.aggregate.ts` — BaseAggregate with domain events
- `src/common/repository.ts` — Base repository with CRUD, raw query, soft delete
- `src/common/repository.helpers.ts` — Query formatting helpers
- `src/common/queryBuilder.ts` — QueryBuilder with Debug method
- `src/common/unitOfWork.service.ts` — Transaction management via CLS
- `src/common/databaseServices/core/core.database.service.ts` — Raw query methods
- `src/interfaces/IRepository.ts` — Repository interface
- `src/entities/generated/core/ApiKeyEntity.ts` — ApiKey entity with validation
- `src/repositories/generated/core/NamedEntityRepository.ts` — Hard delete method
- `package.json` — Dependencies

### packages/applications/
- `src/common/base.service.ts` — BaseService with SysEvent broadcasting
- `src/common/applyChangesToEntity.ts` — Entity change application (mass assignment risk)
- `src/authorization/unified-auth.guard.ts` — Unified JWT + API key authentication guard
- `src/services/apiKey/apikey.service.ts` — API key lifecycle management
- `src/services/crypto/crypto.service.ts` — Encryption and hashing
- `src/services/sysEvent/sysEvent.service.ts` — Audit log and event processing
- `src/services/user/user/user.service.ts` — User CRUD service
- `package.json` — Dependencies

---

*Report generated: 2026-03-24 | Next review recommended: 2026-06-24 (quarterly)*
