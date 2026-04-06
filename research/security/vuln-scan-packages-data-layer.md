# Vulnerability Scan: Data Layer Packages

**Scope**: `packages/database/`, `packages/domains/`, `packages/applications/`, `packages/exceptions/`
**Date**: 2026-03-24
**Last Updated**: 2026-04-06
**Scanner**: Deep manual analysis + dependency audit
**Classification**: Healthcare AI — HIPAA-adjacent sensitivity

---

## Executive Summary

| Severity | Count | Immediate Action |
|----------|-------|------------------|
| **CRITICAL** | 5 | Patch within 24 hours |
| **HIGH** | 9 | Patch within 7 days |
| **MEDIUM** | 8 | Patch within 30 days |
| **LOW** | 6 | Next release cycle |
| **INFO** | 4 | Track and review |
| **Total** | **32** | |

The data layer has a fundamentally sound architecture — DDD boundaries, soft-delete extension, factory-driven entity creation, and CASL-based authorization are well-designed. However, several vulnerability classes persist that could enable **cross-tenant data access**, **soft-delete bypass**, **SQL injection**, and **privilege escalation** in a healthcare context where patient data confidentiality is paramount.

---

## 1. Dependency CVEs

### packages/database

| Package | Version | Risk | Notes |
|---------|---------|------|-------|
| `prisma` | ^7.5.0 | **LOW** | Actively maintained. No critical CVEs at time of scan. |
| `@prisma/client` | ^7.5.0 | **LOW** | Same as above. |
| `@prisma/adapter-pg` | ^7.5.0 | **LOW** | PostgreSQL adapter — review changelogs for driver-level issues. |
| `bcryptjs` | ^3.0.3 | **LOW** | Pure JS bcrypt. No known CVEs. Note: bcryptjs truncates passwords at 72 bytes — unicode inputs may silently lose entropy (see VLN-RAND-02). |
| `pg` | ^8.20.0 | **LOW** | Mature. Monitor for connection-string injection advisories. |

### packages/domains

| Package | Version | Risk | Notes |
|---------|---------|------|-------|
| `class-transformer` | ^0.5.1 | **MEDIUM** | Prototype pollution via `plainToInstance` if `excludeExtraneousValues` is not set globally. See VLN-MASS-01. |
| `uuidv7` | ^1.2.1 | **INFO** | Time-ordered UUIDs leak creation timestamps. Acceptable for internal IDs but avoid exposing in public APIs. |

### packages/applications

| Package | Version | Risk | Notes |
|---------|---------|------|-------|
| `class-transformer` | ^0.5.1 | **MEDIUM** | Same as domains — needs global `excludeExtraneousValues: true`. |
| `class-validator` | ^0.14.1 | **LOW** | No critical CVEs. Ensure `whitelist: true, forbidNonWhitelisted: true` in global pipe. |
| `jsonwebtoken` | ^9.0.3 | **MEDIUM** | Historical CVEs around algorithm confusion. Ensure `algorithms` whitelist is set in verify options. |
| `openid-client` | 5.7.1 | **HIGH** | **Pinned to exact version** — not using `^` range. Check if this is intentional. v5.x is legacy; v6.x rewrote the API. Ensure issuer discovery validates TLS. |
| `@casl/ability` | ^6.8.0 | **MEDIUM** | No CVEs but the `manage` + `all` rule is extremely permissive (see VLN-AUTHZ-01). |
| `puppeteer` | ^24.40.0 | **HIGH** | Chromium download in a backend package is a large attack surface. Verify this is truly needed in the application services layer. |
| `yaml` | ^2.8.3 | **LOW** | YAML parsing can be exploited for prototype pollution — ensure no untrusted YAML is parsed. |
| `axios` | ^1.13.6 | **LOW** | Monitor for SSRF via URL parsing. |
| `mqtt` | ^5.15.0 | **MEDIUM** | Ensure TLS is enforced and broker credentials are not hardcoded. |
| `nodemailer` | ^6.10.1 | **LOW** | SMTP credentials should be env-injected, not hardcoded. |

### packages/exceptions

| Package | Version | Risk | Notes |
|---------|---------|------|-------|
| `nestjs-cls` | ^5.4.3 | **INFO** | No CVEs. Used for correlation ID propagation. |

---

## 2. SQL Injection (VLN-SQLI)

### VLN-SQLI-01: `$queryRawUnsafe` Exposed via CoreDatabaseService [CRITICAL]

**File**: `packages/domains/src/common/databaseServices/core/core.database.service.ts:69-71`

```typescript
async query(query: string) {
    return await this.prisma.$queryRawUnsafe(query);
}
```

This method accepts a raw string and passes it directly to `$queryRawUnsafe`. Although marked `@deprecated`, it is:
- Publicly accessible on the injected `CoreDatabaseService`
- Forwarded by `Repository.rawQueryUnsafe()` at `packages/domains/src/common/repository.ts:215-217`

**Impact**: Any service with a `CoreDatabaseService` reference can construct and execute arbitrary SQL. If any user-controlled input reaches this path, full database compromise is possible.

**Remediation**:
1. Remove the `query()` method entirely or make it `private`
2. Remove `rawQueryUnsafe()` from the Repository base class
3. If raw SQL is needed, enforce tagged template literals via `queryRaw` exclusively
4. Add ESLint rule to ban `$queryRawUnsafe` imports

### VLN-SQLI-02: Repository `rawQuery` and `rawQueryUnsafe` Methods [HIGH]

**File**: `packages/domains/src/common/repository.ts:211-217`

```typescript
public async rawQuery(query: string): Promise<unknown> {
    return await this.db.query(query);
}

public async rawQueryUnsafe(query: string): Promise<unknown> {
    return await this.db.queryRawUnsafe(query);
}
```

Both methods accept raw string queries. Any repository subclass (or service holding a repository reference) can call these. No parameterization, no input sanitization.

**Remediation**: Remove both methods from the base Repository class. If raw SQL is needed, it should go through a dedicated, audited path with parameterized queries only.

### VLN-SQLI-03: QueryBuilder Bypasses Soft-Delete Extension [MEDIUM]

**File**: `packages/domains/src/common/queryBuilder.ts:233-243`

The `ToList()` and `Single()` methods call `this.dbContext.findMany()` directly on the Prisma delegate. The QueryBuilder is initialized with `this.db` from the Repository (line 225), which is the model delegate — but whether this delegate carries the soft-delete extension depends on whether `_databaseContext` points to the extended client or a raw transaction client.

If used during a transaction where the context is the base (unextended) client, soft-delete filtering is bypassed.

**Remediation**: Ensure QueryBuilder always routes through the extended client, or explicitly add `resourceStatus: { not: 'DELETED' }` in the QueryBuilder's `Build()` method for models that support soft-delete.

---

## 3. Soft-Delete Bypass (VLN-SDEL)

### VLN-SDEL-01: `findById` Uses `findUnique` — No Soft-Delete Filter [CRITICAL]

**File**: `packages/domains/src/common/repository.ts:91-99`

```typescript
public async findById(id: EntityId): Promise<DomainEntity> {
    const model = await this.db.findUnique({
        where: { id },
        include: this._includes,
    });
```

The soft-delete Prisma extension at `packages/database/src/client.ts:171-173` does **not** apply the filter for `findUnique`:

```typescript
async findUnique({ model, operation, args, query }) {
    return query(args); // NO FILTER APPLIED
},
```

This means `findById()` — the most commonly used repository method — **returns soft-deleted records**. Any code path that fetches an entity by ID (updates, permission checks, relation loading) can operate on deleted data.

**Impact**: Deleted patient records, consultations, and user accounts remain accessible through direct ID lookup. In a healthcare system, this violates data lifecycle guarantees.

**Remediation**:
1. Change `findById()` to use `findFirst` with `{ id }` as the where clause (soft-delete filter applied)
2. OR apply the soft-delete filter in the `findUnique` extension handler (add `applySoftDeleteFilter(args)` like the other handlers)
3. Add integration test verifying `findById` cannot return DELETED entities

### VLN-SDEL-02: Custom Repository Methods Using `(this as any).db` May Bypass Extension [HIGH]

**Files**: Multiple repositories use `(this as any).db.findMany/findFirst/aggregate/count` directly:
- `ConsultationRepository.ts` (lines 93, 114, 184, 237, 259, 310, 353, 367)
- `ContextItemRepository.ts` (lines 72, 92, 119, 139, 159, 178, 194, 253-254, 281, 294, 330, 353, 376, 397, 420, 443)
- `AudioRecordingRepository.ts` (lines 25, 38, 52, 63, 76, 85, 98)
- `SummaryMetaRepository.ts` (lines 26, 40, 53, 66, 77, 94, 110)
- `NamedEntityRepository.ts`

These bypass the base Repository's typed interface. While `findMany` and `findFirst` DO have soft-delete filtering via the extension, the `(this as any)` cast eliminates TypeScript's ability to verify the query shape, potentially allowing queries that circumvent the extension if the `_databaseContext` changes.

**Remediation**: Refactor to use the base Repository's `findAll`/`findFirst` methods, or create properly typed protected methods for custom queries.

### VLN-SDEL-03: `Repository.delete()` Performs Hard Delete [HIGH]

**File**: `packages/domains/src/common/repository.ts:142-148`

```typescript
public async delete(id: EntityId): Promise<DomainEntity> {
    const model = await this.db.delete({
        where: { id },
        include: this._includes,
    });
    return this._mapper.toDomainEntity(model);
}
```

The `delete()` method performs a **hard delete** from the database. While `softDelete()` exists alongside it, nothing prevents a service from calling `delete()` directly. In a healthcare system, hard deletes of patient data violate audit trail and data retention requirements.

**Remediation**:
1. Remove `delete()` from the base Repository or make it `protected`
2. Require explicit opt-in for hard delete (e.g., `hardDelete()` with admin-only guard)
3. Add runtime check: throw if `supportsSoftDelete` is true and `delete()` is called

---

## 4. Tenant Isolation Bypass (VLN-TENANT)

### VLN-TENANT-01: Repository Methods Without `tenantId` Filter [CRITICAL]

Multiple repository methods query by entity ID alone without requiring `tenantId`:

| Repository | Method | Missing tenantId |
|---|---|---|
| `ConsultationRepository` | `findWithContext(consultationId)` | YES |
| `ConsultationRepository` | `findWithRelations(consultationId)` | YES |
| `ConsultationRepository` | `findConsultationChain(consultationId)` | YES |
| `ConsultationRepository` | `findRevisits(parentConsultationId)` | YES |
| `ContextItemRepository` | `findByConsultation(consultationId)` | YES |
| `ContextItemRepository` | `findTranscripts(consultationId)` | YES |
| `ContextItemRepository` | `findSummaries(consultationId)` | YES |
| `ContextItemRepository` | `findWithVersions(id)` | YES |
| `ContextItemRepository` | `findWithAudioRecordings(id)` | YES |
| `ContextItemRepository` | `findWithAllRelations(id)` | YES |
| `ContextItemRepository` | `findByDnaWritingStyle(dnaStyleId)` | YES |
| `ContextItemRepository` | `findNeedingQdrantSync(limit)` | YES |
| `AudioRecordingRepository` | `findByContextItem(contextItemId)` | YES |
| `AudioRecordingRepository` | `findByMediaId(mediaId)` | YES |
| `AudioRecordingRepository` | `findByFormat(format)` | YES |
| `AudioRecordingRepository` | `getNextSequenceNumber(contextItemId)` | YES |
| `AudioRecordingRepository` | `getTotalDuration(contextItemId)` | YES |
| `AudioRecordingRepository` | `countByContextItem(contextItemId)` | YES |
| `SummaryMetaRepository` | `findByContextItem(contextItemId)` | YES |
| `SummaryMetaRepository` | `findByAiModel(aiModelId)` | YES |
| `SummaryMetaRepository` | `findByCaseNoteId(caseNoteId)` | YES |
| `SummaryMetaRepository` | `findByDateRange(startDate, endDate)` | YES |
| `SummaryMetaRepository` | `getAverageProcessingTime(aiModelId)` | YES |
| `SummaryMetaRepository` | `getTotalTokenUsage(aiModelId)` | YES |
| `NamedEntityRepository` | `findByContextItem(contextItemId)` | YES |
| Base `Repository` | `findById(id)` | YES |

**Impact**: If an attacker knows or guesses a consultationId or contextItemId from another tenant, they can retrieve that tenant's medical records, transcripts, summaries, and audio recordings. The UUIDv7 IDs are time-ordered, making enumeration feasible.

**Remediation**:
1. Add a `tenantId` parameter to ALL repository methods that query by entity ID
2. Create a base method `findByIdForTenant(id, tenantId)` that adds tenant filtering
3. Consider a Prisma middleware/extension that auto-injects `tenantId` from CLS context into all queries
4. Add integration tests that verify cross-tenant access is denied

### VLN-TENANT-02: `findPaginatedWithRelations` Accepts `filters` Without Tenant Enforcement [HIGH]

**File**: `packages/domains/src/repositories/generated/core/ConsultationRepository.ts:218-252`

```typescript
async findPaginatedWithRelations(params: {
    filters: Record<string, unknown>;
    // ...
}): Promise<ConsultationEntity[]> {
    const where: Record<string, unknown> = {
        ...filters,  // User-controlled filters spread directly
        resourceStatus: filters.resourceStatus ?? ResourceStatusType.ENABLED,
    };
```

The `filters` object is spread directly into the `where` clause. If the caller doesn't include `tenantId` in filters, no tenant scoping is applied. The `Record<string, unknown>` type provides zero type safety.

**Remediation**: Make `tenantId` a required, separate parameter (not part of the filters object).

---

## 5. Mass Assignment (VLN-MASS)

### VLN-MASS-01: Service `create()` Methods Spread Request Directly into Factory [HIGH]

Multiple services spread the request DTO directly into the entity factory:

```typescript
// packages/applications/src/services/security/role/role.service.ts:40-43
async create(request: CreateRoleRequest): Promise<RoleEntity> {
    const newRole = RoleFactory.CreateRole({
        createdBy: this.requestUser?.id,
        ...request  // All request properties become entity properties
    });
```

Found in: `RoleService`, `PermissionService`, `RolePermissionService`, `TagService`, `TenantService`, `WebhookService`, `NotificationService`, `GlobalSettingService`, `UserSettingsService`.

If `CreateRoleRequest` (or any other request DTO) does not explicitly exclude sensitive fields (`id`, `resourceStatus`, `tenantId`, `createdAt`, etc.), an attacker can set these via the HTTP request body.

**Impact**: An attacker could:
- Set their own `id` to a predictable value
- Set `resourceStatus` to bypass soft-delete
- Set `tenantId` to access another tenant's scope
- Set `createdBy` to impersonate another user

**Remediation**:
1. Ensure ALL request DTOs use `class-validator`'s `@IsOptional()` only for truly optional fields
2. Add `@Exclude()` decorator on ALL sensitive base entity fields in request DTOs
3. Set `class-transformer` globally with `excludeExtraneousValues: true`
4. In factories, explicitly pick only allowed fields instead of spreading

### VLN-MASS-02: `broadcastSysEvent` Allows Data Override via Spread [MEDIUM]

**File**: `packages/applications/src/common/base.service.ts:37-48`

```typescript
broadcastSysEvent(type: SysEventType, data: Partial<SysEvent>): void {
    this.eventEmitter.emit(type, {
        responsibleEntityId: this.requestUser?.id,
        // ...CLS defaults...
        ...data, // Caller data overrides CLS defaults
    });
}
```

The comment says "Caller data spread LAST so explicit values override CLS defaults." This is intentional for background jobs, but it means any service code can emit events with a forged `responsibleEntityId`, `tenantId`, or `correlationId`.

**Remediation**: Validate that override fields come from trusted sources. Add a `SystemContext` marker type that only internal/background services can construct.

---

## 6. Race Conditions (VLN-RACE)

### VLN-RACE-01: No Optimistic Locking on Entity Updates [HIGH]

**File**: `packages/domains/src/common/repository.ts:132-140`

```typescript
public async update(id: EntityId, entity: DomainEntity): Promise<DomainEntity> {
    const changes = this._mapper.toPersistenceChanges(entity);
    const model = await this.db.update({
        where: { id },
        data: changes,
    });
    return this._mapper.toDomainEntity(model);
}
```

Every Prisma model has a `version` (Int) field (`_version` in the database). However, the `update()` method does NOT check or increment the version. Two concurrent updates to the same entity will result in a **last-write-wins** race condition.

In a healthcare system, concurrent updates to consultation summaries, case notes, or patient records can silently lose clinical data.

**Impact**: Lost updates on concurrent edits to patient records.

**Remediation**:
1. Add `version` check in the `where` clause: `where: { id, version: currentVersion }`
2. Increment version in `data`: `data: { ...changes, version: { increment: 1 } }`
3. Catch `PrismaClientKnownRequestError` with code `P2025` (record not found) and throw a `DataConflictException`

### VLN-RACE-02: `softDelete` and `restore` Without Version Check [MEDIUM]

**File**: `packages/domains/src/common/repository.ts:167-208`

Both `softDelete()` and `restore()` update `resourceStatus` without checking the current version. Two simultaneous soft-delete requests or a delete-then-restore race could leave the entity in an inconsistent state.

**Remediation**: Add version check (same pattern as VLN-RACE-01).

### VLN-RACE-03: Transaction Support is Minimal [MEDIUM]

**File**: `packages/applications/src/services/baseServices/unitsOfWork/core/core.unitOfWork.ts:20-26`

```typescript
async startTransaction(): Promise<void> {
    this.transactionClient = await this.databaseService.baseClient.$transaction(
        async (tx) => tx
    );
```

The transaction is created with the **base client** (not the extended client), meaning soft-delete filtering is bypassed within transactions. Additionally, no service code was found using `startTransaction()` in production flows — multi-step mutations (create consultation + create context items) are not wrapped in transactions.

**Remediation**:
1. Use the extended client for transactions
2. Audit all multi-step service operations and wrap in transactions
3. Add transactional integration tests

---

## 7. Type Confusion (VLN-TYPE)

### VLN-TYPE-01: Pervasive `as any` in Repository Layer [MEDIUM]

Found 50+ instances of `(this as any).db` in custom repository methods:
- `ConsultationRepository`: 13 instances
- `ContextItemRepository`: 20+ instances
- `AudioRecordingRepository`: 8 instances
- `SummaryMetaRepository`: 8 instances

The `as any` casts bypass TypeScript's type system, eliminating compile-time verification that:
- Query shapes match Prisma's expected types
- Where clauses contain valid fields
- Include relations exist on the model

**Remediation**: Create a properly typed `protected` getter for model-specific operations, or use Prisma's generated delegate types.

### VLN-TYPE-02: `as any` in PolicyEngine Authorization Check [HIGH]

**File**: `packages/applications/src/authorization/policy.engine.ts:203-207`

```typescript
can(ability: AppAbility, action: string, subject: string, resource?: Record<string, unknown>): boolean {
    if (resource) {
        return ability.can(action, subject as any, resource as any);
    }
    return ability.can(action, subject);
}
```

The `subject as any` and `resource as any` casts bypass CASL's type checking. If `subject` doesn't match a registered CASL subject type, the permission check may silently fail open (return true when it should deny).

**Remediation**: Use proper CASL subject types. Define a union type of all valid subjects and validate `subject` against it.

### VLN-TYPE-03: Unified Auth Guard Sets User Context with `as any` [MEDIUM]

**File**: `packages/applications/src/authorization/unified-auth.guard.ts:153-157`

```typescript
this.cls.set('user', {
    id: apiKeyEntity.userId,
    tenantId: apiKeyEntity.tenantId,
} as any);
```

The `as any` cast means the "user" object set in CLS doesn't match the `UserSession` type. Downstream code that reads `this.requestUser` may get an incomplete user session (missing `firstName`, `lastName`, `email`, `roles`, `permissions`), causing null reference errors or authorization bypasses.

**Remediation**: Define a minimal API key session type that satisfies `UserSession` or create a separate CLS key for API key context.

---

## 8. Error Information Oracle (VLN-ERR)

### VLN-ERR-01: Stack Traces Leaked in Non-Production Environments [MEDIUM]

**File**: `packages/exceptions/src/common/base.exception.ts:46-58`

```typescript
public toJSON(): SerializedException {
    return {
        message: this.message,
        code: this.code,
        correlationId: this.correlationId,
        stack: process.env['NODE_ENV'] === 'production'
            ? undefined
            : this.stack,
        cause: this.cause ? JSON.stringify(this.cause) : undefined,
        metadata: this.metadata,
    };
}
```

Issues:
1. **`NODE_ENV` check is string comparison** — if `NODE_ENV` is `Production` (capitalized), `prod`, or unset, stack traces leak.
2. **`cause` is serialized without filtering** — the original error may contain SQL queries, connection strings, or internal paths.
3. **`metadata` is passed through unfiltered** — callers can attach arbitrary data that reaches the API response.

**Remediation**:
1. Use a strict check: `['production', 'prod'].includes(process.env.NODE_ENV?.toLowerCase())`
2. Filter `cause` to only include `message` and `code`, not the full error object
3. Sanitize `metadata` before serialization

### VLN-ERR-02: `DataNotFoundException` Leaks Entity Names and IDs [MEDIUM]

**File**: `packages/exceptions/src/backend/persistence/dataNotFound.exception.ts:20-21`

```typescript
super(
    `[DB] ${entity} with ID ${entityId} could not be found.`,
```

The error message includes the Prisma model name (e.g., "consultation", "contextItem") and the queried ID. This reveals:
- Database table/model names
- That the specific ID exists or doesn't exist (enumeration oracle)
- Internal naming conventions

**Remediation**: Use generic messages in production: "The requested resource was not found." Log the detailed message server-side only.

### VLN-ERR-03: Repository `findFirst` Leaks Query Props in Exception [LOW]

**File**: `packages/domains/src/common/repository.ts:107-108`

```typescript
throw new DataNotFoundException(this.db.name || Repository.name, JSON.stringify(props));
```

The full query properties (including filter values, tenant IDs, etc.) are serialized into the exception message.

**Remediation**: Pass only a generic identifier, log the full props server-side.

---

## 9. Authorization Bypass (VLN-AUTHZ)

### VLN-AUTHZ-01: `manage` + `all` CASL Rule Grants God-Mode [CRITICAL]

**File**: `packages/database/src/prisma/db_main/seed/01-policy.ts:51-53`

```typescript
{
    name: 'system-full-access',
    rules: [
        { action: 'manage', subject: 'all' },
    ],
},
```

The `manage` action on `all` subjects with no conditions gives **unrestricted access to every resource across every tenant**. This policy is assigned to the `SUPER_ADMIN` role. If any user is incorrectly assigned this role, or if the role assignment is compromised, the attacker gains full database access.

**Issues**:
1. No condition restricting this to specific tenants
2. No IP restrictions or MFA requirements at the policy level
3. If the Redis cache for abilities is poisoned, a user could be granted this ability

**Remediation**:
1. Add explicit conditions even for super admin (e.g., IP whitelist)
2. Require MFA verification before granting manage-all ability
3. Add rate limiting on admin-level operations
4. Log all actions performed under this policy

### VLN-AUTHZ-02: Policy Rules Stored as Unvalidated JSON [HIGH]

**File**: `packages/applications/src/authorization/policy.engine.ts:346`

```typescript
const rules = policy.rules as PolicyRule[];
```

Policy rules are stored as JSON in the database and cast directly to `PolicyRule[]` without validation. A compromised database record or admin UI injection could insert rules that:
- Grant `manage` on `all` to any user
- Use malicious conditions that exploit CASL's query engine
- Include `inverted: true` rules that negate deny rules

**Remediation**:
1. Validate policy rules against a JSON schema before applying
2. Add a checksum/signature to policy records
3. Log when policies are modified and alert on `manage` + `all` rules

### VLN-AUTHZ-03: `scopeOverrides.additionalRules` Bypass Policy [HIGH]

**File**: `packages/applications/src/authorization/policy.engine.ts:311-315`

```typescript
if (scopeOverrides?.additionalRules) {
    for (const rule of scopeOverrides.additionalRules) {
        allRules.push(this.resolveRule(rule, context));
    }
}
```

`scopeOverrides` comes from the `UserRoleAssignment.scopeOverrides` JSON field. If an attacker can modify this field (via SQL injection, admin UI XSS, or direct DB access), they can inject arbitrary CASL rules into any user's ability set — including `{ action: 'manage', subject: 'all' }`.

**Remediation**:
1. Validate `additionalRules` against a whitelist of allowed actions/subjects
2. Deny `manage`+`all` in additionalRules
3. Add audit logging when scopeOverrides are modified

---

## 10. Insecure Randomness (VLN-RAND)

### VLN-RAND-01: `Math.random()` in Pipeline Run IDs [LOW]

**Files**:
- `packages/pipeline/src/core/ParallelPipeline.ts:502`
- `packages/pipeline/src/core/SequentialPipeline.ts:418`

```typescript
private generateRunId(): string {
    return `${this.name}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}
```

`Math.random()` is not cryptographically secure. Pipeline run IDs are predictable, which could allow an attacker to guess and access other users' pipeline run results.

**Remediation**: Use `crypto.randomUUID()` or `uuidv7()`.

### VLN-RAND-02: bcryptjs 72-Byte Password Truncation [INFO]

**File**: `packages/database/src/prisma/db_main/seed/91-user.ts:35`

bcryptjs silently truncates passwords at 72 bytes. Unicode-heavy passwords (like `пароль密码🔐` found in tests) may have more than 72 bytes despite appearing short. Users with long passwords may authenticate with a truncated version.

**Remediation**: Document the 72-byte limit. Consider pre-hashing with SHA-256 before bcrypt (standard practice).

### VLN-RAND-03: Default Seed Password `password123` [INFO]

**File**: `packages/database/src/prisma/db_main/seed/91-user.ts:39`

```typescript
const defaultPassword = await hashPassword('password123');
```

All seeded users share the same password. If seed data accidentally runs in production, all accounts are compromised.

**Remediation**: Generate random passwords for seed users. Store them in a secure output channel, not in the seed script.

---

## 11. Prototype Pollution (VLN-PROTO)

### VLN-PROTO-01: `Object.assign(this, props)` in Event Constructors [MEDIUM]

**File**: `packages/domains/src/common/events/arcaai.event.ts:76-105`

```typescript
export class ResourceCreatedEvent extends SysEvent {
    constructor(props: ResourceCreatedEventProps) {
        super(props);
        Object.assign(this, props);
    }
}
```

All event subclasses (`ResourceCreatedEvent`, `ResourceViewedEvent`, `ResourceUpdatedEvent`, `ResourceDeletedEvent`) use `Object.assign(this, props)`. If `props` contains `__proto__`, `constructor`, or `prototype` keys, it could pollute the event object's prototype chain.

Since events are constructed from service code (via `broadcastSysEvent`), the risk depends on whether event `data` comes from user input.

**Remediation**:
1. Use explicit property assignment instead of `Object.assign`
2. Or sanitize `props` to remove `__proto__`, `constructor`, `prototype` keys
3. The `SysEvent` constructor already does explicit assignment — remove the `Object.assign` in subclasses

### VLN-PROTO-02: `removeNullValues` Recursive Object Processing [LOW]

**File**: `packages/domains/src/common/repository.ts:238-257`

```typescript
function removeNullValues(obj: Record<string, any>): Record<string, any> {
    for (const [key, value] of Object.entries(obj)) {
        if (typeof value === 'object' && !Array.isArray(value)) {
            cleanedObject[key] = removeNullValues(value);
        }
    }
}
```

This function recursively processes nested objects. If a malicious object with `__proto__` as a key is passed, it would be copied into the cleaned object. The risk is LOW because this processes entity data going to Prisma, which has its own sanitization.

**Remediation**: Add `key !== '__proto__' && key !== 'constructor'` guard.

---

## 12. Event Injection (VLN-EVENT)

### VLN-EVENT-01: SysEvent `data` and `metaData` Accept Arbitrary Payloads [MEDIUM]

**File**: `packages/domains/src/common/events/arcaai.event.ts:6-31`

```typescript
export interface SysEventProps {
    metaData?: JsonValue | object;
    data?: JsonValue | object;
    previousData?: JsonValue | object;
    disableAuditLog?: boolean;
    forceAuditLog?: boolean;
}
```

Event properties accept `JsonValue | object` — effectively any JSON-serializable value. Key risks:

1. **`disableAuditLog: true`** can be set by any service, silently suppressing audit trail for sensitive operations
2. **`forceAuditLog: true`** can flood the audit log (DoS)
3. **`data` and `previousData`** could contain crafted payloads that exploit downstream event handlers (e.g., webhook delivery, notification templates)
4. **`responsibleEntityId`** can be forged via the `broadcastSysEvent` spread pattern (see VLN-MASS-02)

**Remediation**:
1. Make `disableAuditLog` only settable by system-level services (not via event spread)
2. Validate event data against a schema before processing
3. Size-limit `data`, `metaData`, and `previousData` fields
4. Sanitize event payloads before webhook delivery

---

## Consolidated Remediation Priority

### Immediate (24 hours)

| ID | Finding | Effort |
|----|---------|--------|
| VLN-SQLI-01 | Remove `$queryRawUnsafe` from CoreDatabaseService | Small |
| VLN-SDEL-01 | Fix `findById` to filter soft-deleted records | Small |
| VLN-TENANT-01 | Add tenantId to ConsultationRepository ID-based methods | Medium |
| VLN-AUTHZ-01 | Add conditions to `manage`+`all` policy | Small |
| VLN-AUTHZ-03 | Validate `scopeOverrides.additionalRules` | Medium |

### Within 7 days

| ID | Finding | Effort |
|----|---------|--------|
| VLN-SQLI-02 | Remove `rawQuery`/`rawQueryUnsafe` from Repository | Small |
| VLN-SDEL-02 | Refactor custom repo methods to use base Repository | Large |
| VLN-SDEL-03 | Remove/protect hard `delete()` method | Small |
| VLN-TENANT-02 | Enforce tenantId in `findPaginatedWithRelations` | Small |
| VLN-MASS-01 | Add `excludeExtraneousValues` globally + DTO audit | Medium |
| VLN-RACE-01 | Add optimistic locking to `update()` | Medium |
| VLN-AUTHZ-02 | Validate policy rules JSON against schema | Medium |
| VLN-TYPE-02 | Fix `as any` in PolicyEngine.can() | Small |
| VLN-TYPE-03 | Fix user context type in unified auth guard | Small |

### Within 30 days

| ID | Finding | Effort |
|----|---------|--------|
| VLN-SQLI-03 | Fix QueryBuilder soft-delete bypass | Medium |
| VLN-RACE-02 | Add version check to softDelete/restore | Small |
| VLN-RACE-03 | Use extended client for transactions | Medium |
| VLN-ERR-01 | Harden NODE_ENV check + filter cause/metadata | Small |
| VLN-ERR-02 | Genericize DataNotFoundException messages | Small |
| VLN-TYPE-01 | Reduce `as any` usage in repositories | Large |
| VLN-PROTO-01 | Replace Object.assign in event constructors | Small |
| VLN-EVENT-01 | Add event payload validation and size limits | Medium |
| VLN-MASS-02 | Protect broadcastSysEvent from CLS override | Medium |

### Next Release

| ID | Finding | Effort |
|----|---------|--------|
| VLN-RAND-01 | Replace Math.random in pipeline IDs | Small |
| VLN-RAND-02 | Document bcrypt 72-byte limit | Small |
| VLN-RAND-03 | Randomize seed passwords | Small |
| VLN-ERR-03 | Sanitize findFirst exception props | Small |
| VLN-PROTO-02 | Guard removeNullValues against __proto__ | Small |
| openid-client | Evaluate upgrade to v6.x | Medium |

---

## Dependency Update Recommendations

| Package | Current | Recommended Action |
|---------|---------|-------------------|
| `openid-client` | 5.7.1 (pinned) | Evaluate v6.x migration or at minimum use `^5.7.x` |
| `puppeteer` | ^24.40.0 | Move to devDependencies if only used for PDF generation in dev/CI |
| `class-transformer` | ^0.5.1 | No update needed, but enable `excludeExtraneousValues` globally |
| `jsonwebtoken` | ^9.0.3 | Ensure `algorithms` whitelist in verify options |
| `mqtt` | ^5.15.0 | Ensure TLS enforcement and credential rotation |

---

## Architecture Recommendations

1. **Tenant Isolation Middleware**: Implement a Prisma extension that auto-injects `tenantId` from CLS into all queries. This is the single highest-impact change — it eliminates an entire class of vulnerabilities.

2. **Repository Method Pattern**: All custom repository methods should follow this pattern:
   ```typescript
   async findByX(tenantId: string, xId: string): Promise<Entity | null> {
       return this.findFirst({ filters: { tenantId, id: xId } });
   }
   ```

3. **Soft-Delete Consistency**: Either:
   - Apply soft-delete filter to `findUnique` in the extension (breaking change, but correct)
   - Replace all `findById` calls with `findFirst` by ID (safer, incremental)

4. **Event Bus Hardening**: Add an event middleware layer that validates payloads, enforces size limits, and prevents `disableAuditLog` from being set outside system services.

5. **Policy Rule Validation**: Add a JSON Schema validator for CASL rules stored in the database. Block `manage`+`all` rules from being created via the admin API.

---

*Report generated by deep manual analysis of the HOPE monorepo data layer packages.*
*Next scan recommended: After remediation of CRITICAL findings.*
