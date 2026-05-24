# TASK-301: System Configuration & Multi-Tenancy — Deep Assessment

| Field | Value |
|-------|-------|
| **Ticket** | TASK-301 |
| **Created** | 2026-05-24 |
| **Updated** | 2026-05-24 |
| **Status** | Review |
| **Type** | Assessment / Architecture Audit |
| **Packages** | `packages/applications`, `packages/database`, `packages/domains`, `apps/api`, `packages/agentic-sdk-v2`, `apps/ui-playground` |
| **Predecessor** | TASK-258 (Tenant Config Provisioning) |
| **Successor work** | TBD per §6 Roadmap |

---

## Requirement Analysis

### Description

Audit-only assessment of the **System Configuration implementation for multi-tenancy** across the HOPE monorepo. The user requested:

1. Deep external research on 2025-2026 best practices for multi-tenant system configuration in SaaS / B2B platforms.
2. Code review, database review, and security audit of the current implementation.
3. A consolidated report of what should be improved / changed.
4. Suggestions of latest best practices to implement, fix, or enhance.

### Business Context

HOPE is a multi-tenant healthcare AI platform handling PHI (Protected Health Information). Configuration drives both functional behaviour (model defaults, feature flags, namespaces) and security-critical behaviour (JWT signing keys, S3 credentials, OIDC client secrets). A defect in this surface can translate directly into a HIPAA breach (cross-tenant PHI leak), SOC2 finding (insufficient access control), or GDPR violation (integrity loss).

### Scope (read-only audit; NO source modified)

- Process / environment config (`ConfigService` + `IAppConfig`)
- DB-backed runtime config (`GlobalSetting` table, `AppSettingsService` cache, `TenantService` config methods, `GlobalSettingService`)
- Tenant context propagation (`nestjs-cls`, CASL authorization)
- Provisioning lifecycle (`provisionTenantConfigs`, `__GLOBAL__` sentinel tenant pattern)
- SDK + admin UI consumers (`@arcaai/vox` `ConfigManager`, `ui-playground` admin pages)

### Out of scope (will be revisited if user prioritizes)

- Python service config (apps/stt-v2, apps/smr, apps/nlp, apps/tts) — only touched insofar as they consume `GlobalSetting`-derived values from the API layer
- Frontend state management beyond config reads

---

## Methodology

Five parallel subagents were dispatched:

| Agent | Role | Output |
|---|---|---|
| `researcher` | External best-practice research, 2024-2026 | ~4,400-word document with cited sources, library shortlist, anti-pattern list |
| `code-reviewer` | Implementation-level review of tenant + globalSetting + appSettings + config services | 38 findings, severity-tagged, file:line citations |
| `database-admin` | Schema design + migration + indexing + RLS strategy | 16 schema findings + indexing recommendations + provisioning rewrite + isolation strategy comparison |
| `security-auditor` | Threat-modelled audit assuming a malicious authenticated tenant user | 20 findings including 8 P0s with full exploit chains and CWE/HIPAA mapping |
| `scout` | Blast-radius map of all System Config consumers across the monorepo | Inventory of ~50+ production files touching config, full setting keys catalog, propagation map |

The four findings-agents arrived at independent conclusions; the most critical defects were **cross-confirmed** by ≥ 2 agents.

---

## Current State Evaluation

### Architecture Snapshot

```
HOPE System Configuration — Three Parallel Stacks
─────────────────────────────────────────────────────────────────────
Stack 1: PROCESS / ENV
└─ IConfigService (singleton, IAppConfig type, ~30 keys)
   ├─ loads from .env.{dev,test,production} on boot
   └─ NOT tenant-aware (by design)

Stack 2: DB-BACKED RUNTIME CONFIG (the GlobalSetting surface)
├─ core.GlobalSetting table
│   • value String, dataType ValueType
│   • tenantId String? @default("50000000-…") — nullable, sentinel default
│   • locked Boolean for system-managed defaults
├─ "__GLOBAL__" sentinel tenant holds master defaults
├─ AppSettingsService — Map<key, entity>, 45s cron
│   ⚠ NOT tenant-aware → cross-tenant cache key collision
├─ TenantService.fetchTenantConfigs / updateTenantConfigs (HTTP)
├─ TenantService.provisionTenantConfigs (clones __GLOBAL__ on tenant create)
├─ GlobalSettingService — DORMANT (no controller wired; SDK hook orphan)
└─ CASL @CanManage('Tenant'), SUPER_ADMIN bypass

Stack 3: PARALLEL @nestjs/config (consultation/summary/DNA processors)
└─ Reads SMR_URL, NLP_URL, SMR_SERVICE_TOKEN

Cross-cutting
├─ Tenant context: nestjs-cls (AsyncLocalStorage), from JWT
├─ Prisma client extension: ONLY soft-delete (NO tenant filter)
├─ NO PostgreSQL Row-Level Security
├─ NO FK GlobalSetting.tenantId → Tenant.id
└─ NO envelope encryption on locked secrets
```

### Consumer Blast Radius

- ~50+ production TypeScript files touching config layers
- Densest clusters: **auth/JWT (4), S3/storage (4), tenant config APIs (5), SDK ConfigManager/ModelRegistry (4), consultation feature flags (3)**
- Setting keys catalog: **15+ code-referenced keys are not seeded** (JWT_SECRET_KEY, OIDC_*, isMaintenance, healthCheck.*, metrics.*, crypto.*, SDK orphans default-language and enable-real-time-transcription)

### Severity Tally

| Severity | Count | Examples |
|---|---|---|
| **P0** (critical / breach-grade) | **9** | Cross-tenant cache leak, mass-assignment via missing whitelist, `@Authorize()` empty-list bypass, role-assignment privilege escalation, plaintext secrets, audit-log secret leak, no FK on `tenantId`, non-transactional batch update, mutable `__GLOBAL__` defaults clone |
| **P1** (high) | **14** | Sequential N+1 provisioning, 45s cron + no on-write invalidation, dormant unwired `GlobalSettingService`, value-mask side-effect on change tracking, lying PaginatedTenantConfigResponse cast, missing array body validation, identifier regex too loose, `__GLOBAL__` exposed in tenant lists, JWT-secret triple-source drift, no Prisma tenant filter, `value: String + dataType` modeling, etc. |
| **P2** | **~19** | SRP violations, dual `ConfigService` stacks, direct DB writers bypassing TenantService, missing optimistic locking, missing length caps, missing CHECK constraints |
| **P3** | **~10** | Magic strings, dead methods (`loadVaultSecrets`), naming/documentation drift |

---

## P0 Critical Findings

Each P0 is independently confirmed by at least two of the four assessors.

### P0-1 — Cross-tenant cache collision in `AppSettingsService` (confirmed by all four agents)

**Location**: `packages/applications/src/services/baseServices/_meta/appSettings/appSettings.service.ts:185-209`

```ts
const newCache = new Map<string, GlobalSettingEntity>();
const globalSettings = await this.globalSettingRepository.findAll({});
globalSettings.forEach((setting) => {
  newCache.set(setting.key, setting);   // ← keyed by .key only; tenants collide
});
```

**Why it matters**: `cacheAppSettings()` loads every `GlobalSetting` row across every tenant and stores them in a `Map` keyed only by `setting.key`. When multiple tenants share a key (the common case after `provisionTenantConfigs` clones the `__GLOBAL__` defaults into a new tenant), whichever Prisma returns last wins for the entire process. Consumers like `JwtStrategy` (reads `JWT_SECRET_KEY` at boot), `S3Service` (reads `S3_ACCESS_KEY`/`S3_SECRET_KEY` at init), `OidcStrategy`, `CryptoService`, and `MaintenanceInterceptor` therefore receive a non-deterministically-chosen tenant's value — and on cron rotation, the "winner" can change without any code change.

**Recommended fix**:
1. **Split** `AppSettingsService` into `PlatformSettingsService` (system-wide, loads only `tenantId = __GLOBAL__`) and `TenantSettingsService` (per-tenant `Map<tenantId, Map<key, entity>>`).
2. Add a startup invariant: refuse to start if more than one row exists for any platform key.
3. Move JWT/S3/OIDC out of the DB entirely into env vars or a vault (finish the dormant `loadVaultSecrets()` in `config.service.ts:195`).

### P0-2 — Mass-assignment chain → JWT secret hijack

**Location**: `apps/api/src/main.ts:221`, `packages/applications/src/common/applyChangesToEntity.ts:64-102`, `packages/applications/src/services/tenant/tenant.service.ts:498-518`

The global `ValidationPipe` is constructed without `whitelist: true` / `forbidNonWhitelisted: true`. The service's update logic spreads `{ ...changes }` into `applyChangesToEntity`, which writes any key the client sends via `(entity as any)[key] = value`. A regular DOCTOR can therefore submit:

```json
[{"id":"<their-unlocked-setting-id>",
  "value":"<attacker-jwt-secret>",
  "key":"JWT_SECRET_KEY",
  "locked":true,
  "tenantId":"<global-tenant-uuid>"}]
```

→ locked-check passes (original row was unlocked) → entity fields are silently rewritten → next cache cycle (≤45s) overwrites the platform JWT secret. The same primitive works for `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `OIDC_CALLBACK_URL`, `crypto.saltRounds`.

**Recommended fix (3 lines, layered)**:

1. `apps/api/src/main.ts:221` →
   ```typescript
   new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true, forbidUnknownValues: true })
   ```
2. `tenant.service.ts:503` → replace `const { id: _id, ...changes } = config` with an explicit allowlist: `const changes = { value: config.value, description: config.description }`.
3. Make `key`, `tenantId`, `locked`, `defaultValue` immutable on `GlobalSettingEntity` (remove the public setters or guard them).

**Effort**: S (~1-2 hours). **Blast radius if NOT fixed**: cross-tenant credential takeover.

### P0-3 — `@Authorize()` with no permissions auto-allows authenticated users

**Location**: `packages/applications/src/authorization/authorization.guard.ts:96-100`

```ts
// No permissions required = allow (but still need authentication)
if (!required || required.length === 0) {
  return true;
}
```

Multiple admin controllers carry `@Authorize()` at the class level with no permission tuple — `UserController` (`apps/api/src/modules/user/user.controller.ts:30-32`), `DepartmentController`, `StorageAccessKeyController`, `TenantBucketController`. Any authenticated user (DOCTOR, NURSE) can therefore call `POST /api/v1/admin/users/:id/roles { roleId: <SUPER_ADMIN_ROLE_ID> }` (line 221-229 of `user.controller.ts`) → trivial privilege escalation.

**Recommended fix**:
1. Invert the default in `AuthorizationGuard` (empty list = **deny** on `admin/*` routes).
2. Replace every class-level `@Authorize()` on an admin controller with `@CanManage(<Subject>)`.
3. Add a boot-time route-introspection guard that refuses startup if any `admin/*` route lacks an explicit permission decorator.

**Effort**: S (≤4h for fix + decorator sweep). **Compliance**: HIPAA §164.308(a)(3), SOC2 CC6.1/CC6.3.

### P0-4 — `UserRoleAssignmentService.create` accepts arbitrary `roleId` and `tenantId`

**Location**: `packages/applications/src/services/user/userRoleAssignment/userRoleAssignment.service.ts`, `packages/applications/src/services/user/userRoleAssignment/dto/createUserRoleAssignment.request.ts:5-19`

Even with P0-3 fixed (so a TENANT_ADMIN reaches the service properly), the service performs zero policy check on `roleId`. A tenant admin granted `manage:UserRoleAssignment` (with the CASL condition `tenantId: '${context.tenantId}'`) can therefore assign **any role** — including SUPER_ADMIN.

**Recommended fix**: in the service, look up the target role's `isSystemRole` and refuse system roles unless caller is SUPER_ADMIN. Server-control `tenantId` from CLS (don't trust the body).

### P0-5 — Locked-setting / `__GLOBAL__` guards bypassable via `tenantId` mass-assignment

**Location**: `packages/applications/src/services/tenant/tenant.service.ts:483-518`

If P0-2 is exploitable, an attacker can set `tenantId` on one of their own rows to the `__GLOBAL__` UUID. The next tenant onboarding event then calls `provisionTenantConfigs` (line 119-186), which reads `__GLOBAL__` settings and clones the attacker's poisoned row into every new tenant. **Persistent infection.**

**Recommended fix**: same as P0-2 (allowlist) + reject `provisionTenantConfigs` source rows whose `updatedAt > seedTimestamp` unless `createdBy === SUPER_ADMIN`.

### P0-6 — Audit log persists plaintext locked secrets

**Location**: `packages/applications/src/services/tenant/tenant.service.ts:520-523`

```ts
this.broadcastSysEvent(SysEventType.ResourceUpdated, {
  resourceIds: updatedConfigs.map((config) => config.id),
  data: updatedConfigs.map((config) => config.toObject()),
});
```

Every locked-setting update by SUPER_ADMIN writes the plaintext value into `auditLog.data` (HIPAA requires audit logs to be retained 6+ years). Replicas, SIEM, backups, and DR copies all carry these secrets. **Key rotation becomes actively harmful** — each rotation leaks the new key into a wider surface than the original storage.

**Recommended fix**: introduce a `@Secret` field decorator; the SysEvent serializer scrubs `value` / `defaultValue` for rows where `locked === true`, logging only `{ id, key, changedFields }`.

### P0-7 — `value` column stored plaintext (including locked secrets)

**Location**: `packages/database/src/prisma/db_main/globalSetting.prisma:16`

The schema stores `value String`. `locked: true` rows already include provider credentials in seeds (`smr-provider-models`). A single DB backup leak exposes every tenant's secret material.

**Recommended fix**: envelope encryption — `valueCipher BYTEA + valueKeyId UUID + valueIv BYTEA + valueTag BYTEA`, decryption only at trusted call sites. Use KMS (AWS, Azure Key Vault, GCP KMS) or HashiCorp Vault Transit. Per-tenant DEK encrypted with a platform KEK.

### P0-8 — No foreign key from `GlobalSetting.tenantId` → `Tenant.id`

**Location**: `packages/database/src/prisma/db_main/globalSetting.prisma:8`, `tenant.prisma:1-29`

```prisma
tenantId String? @default("50000000-0000-0000-0000-000000000000")
```

No FK + nullable + sentinel default = silent orphan rows + silent default-fallthrough on insert. Postgres also treats `NULL` as distinct from `NULL` in unique constraints, so `(tenantId IS NULL, name, key)` allows duplicates that break the `Map<key>` cache further.

**Recommended fix**:

```prisma
model GlobalSetting {
  ...
  tenantId String                                  // remove ? and default
  tenant   Tenant @relation(fields: [tenantId], references: [id], onDelete: Restrict)
}
model Tenant {
  ...
  settings GlobalSetting[]
}
```

Pre-migration: `SELECT COUNT(*) FROM "core"."GlobalSetting" gs LEFT JOIN "core"."Tenant" t ON t.id = gs."tenantId" WHERE t.id IS NULL;` — back-fill any orphans before adding the constraint.

### P0-9 — `updateTenantConfigs` is non-transactional

**Location**: `packages/applications/src/services/tenant/tenant.service.ts:472-531`

The for-loop performs N independent DB writes. Any mid-batch failure (locked-row guard, validation, DB error) leaves partial state: e.g. updating `{stt-model, smr-model, smr-provider}` and failing on row 3 means row 1+2 are persisted, row 3 not, with no rollback. SMR validation (`validateSmrConfigValue`) is also order-dependent — provider/model updates in the same batch validate against the OLD provider's catalog.

**Recommended fix**: wrap the loop in `CoreUnitOfWorkService.startTransaction()`; pre-validate all rows before any write. The project's own application-services rule (`04-application-services.mdc`) requires `CoreUnitOfWorkService` for multi-entity writes — this is a rule violation.

---

## P1 High-Severity Findings (selected)

### P1-1 — `GlobalSettingService` is dormant but exported (loaded gun)

`packages/applications/src/services/globalSetting/globalSetting.service.ts` — `// TODO: Implement this`, `create()` trusts body `tenantId` with no CLS comparison, `fetchAll()` returns rows across all tenants. SDK hook `useGlobalSettings` points at `/admin/settings/*` endpoints that don't exist. Either **complete it correctly** (tenant-aware) or **delete the entire service + SDK hook + DTOs**.

### P1-2 — Sequential N+1 inserts in `provisionTenantConfigs`

`tenant.service.ts:148-176` does `for ... await create()` — ~17 round-trips per tenant, no atomicity. Replace with:

```typescript
const cloned = sourceSettings.map(src => GlobalSettingFactory.CreateGlobalSetting({...}));
await this.globalSettingRepository.createMany(cloned, /* skipDuplicates */ true);
```

One round-trip, transactional, ~10-50× faster, idempotent on retry.

### P1-3 — 45s cron + no on-write invalidation = pod-skew + stale reads

Horizontal scaling = N pods each running their own 45s cron loop over all tenants. After a write: pod A sees new value, pod B sees old, for up to 45 seconds. At 100k tenants × 17 settings, the cron pulls 1.7M rows every 45s — 500ms+ scan per pod, ~10MB/s DB→app bandwidth.

**Fix**: switch to event-driven invalidation. Two options:
1. **PostgreSQL LISTEN/NOTIFY** → app subscribes; lowest infra cost.
2. **Redis Pub/Sub** → on every `globalSettingRepository.update()`, publish `cache:invalidate:{tenantId}:{key}`; pods subscribe and evict the entry.

Combined with **per-tenant cache key** (`Map<tenantId, Map<key, entity>>` or Redis key `config:{tenantId}:{key}`) and SWR semantics.

### P1-4 — `value` masking mutates entity change tracking

`tenant.service.ts:430-435`: setting `config.value = ''` to mask locked values for non-super-admins fires the entity setter, which adds to `_changes`. If the same entity is later persisted (e.g. through any future cross-handler reuse), the mask is committed to the DB as a real value. Use a separate response-mapping path that doesn't mutate the entity.

### P1-5 — Composite unique `(tenantId, name, key)` should be `(tenantId, key)`

`globalSetting.prisma:37` — `name` in the unique constraint allows two rows with same `(tenantId, key)` but different display names → cache key collision, last-write-wins.

### P1-6 — `value: String + dataType: ValueType` should be `Json` + Zod/JSON Schema

The current pattern (`JSON.stringify` at write, `parsedValue` at read) is double serialization with no DB-side validation, no JSONB indexing, no UI form auto-generation. 2025-2026 standard: store as JSONB, validate at write time with Zod (TS-first) or JSON Schema + AJV (cross-language).

### P1-7 — `__GLOBAL__` sentinel tenant is exposed in `fetchAll` / `fetchAllByTenantCodeName`

A future RBAC relaxation (e.g. helpdesk read role) immediately exposes the system tenant. Filter at the repository level by default.

### Other P1s (summarized)

- `PaginatedTenantConfigResponse` cast lies — `tenantId`/`tenantCode` never populated
- Missing `@ValidateNested({ each: true })` + `@Type(() => UpdateTenantConfigRequest)` on PATCH body arrays
- `resolveTenantByIdentifier` doesn't filter soft-deletes
- UUID regex too loose (accepts UUIDv0–v15, no canonical-form check)
- Tenant create has partial-failure tolerance (`try/catch` around bucket + config provisioning) — should be all-or-nothing transactional
- JWT secret routed through three different paths (`AppSettingsService`, `authenticateJwt.ts` raw env, `gen-dev-token` env) — drift between sign and verify possible
- Direct Prisma client usage in `getUsageStats()` bypasses the repository (rule violation)
- `getValueWithDefault<T>` silently returns string when `JSON.parse` fails — types lie

---

## P2 / P3 Findings (highlights)

- **SRP violation**: `TenantService` is a god-class doing tenant CRUD + GlobalSetting provisioning + SMR validation + locked enforcement + masking. Split into `TenantService` + `TenantConfigService` + `TenantProvisioningService`.
- **`__GLOBAL__` defaults pattern**: 2025 anti-pattern. Use layered resolution (system → tenant → department → user) at read time; defaults live in a separate `SettingDefinition` catalog table, never cloned.
- **`defaultValue` denormalization** drift: every tenant carries its own copy of the default, freezing at provisioning time.
- **`locked: Boolean`** is too coarse — convert to `SettingType { USER_OVERRIDABLE | ADMIN_LOCKED | SYSTEM_INTERNAL | SECRET }`.
- **`createdBy` / `updatedBy`** are nullable String with sentinel default, no FK to `User`. SOC2 audit will flag.
- **`version: Int @default(1)`** is unused for optimistic locking — either wire it or remove it.
- **No length caps** on `name`, `description`, `value` — DoS via 100MB description string is possible.
- **No CHECK constraints** on `dataType` vs `value` shape.
- **Dual `ConfigService`** stacks (HOPE `IConfigService` + NestJS `@nestjs/config`). Unify on `IConfigService`.
- **Direct `process.env` reads** in 15+ production hotspots, including secrets (`JWT_SECRET_KEY`, `SMR_SERVICE_TOKEN`, `API_KEY_PEPPER`, `SESSION_SECRET_KEY`).
- **Dead methods**: `loadVaultSecrets()` (throws), `validateSettingValue()` (unused).
- **Setting keys catalog drift**: ~15 keys referenced in code, never seeded.
- **CSRF not enforced** on `PATCH /tenant/me/config` (session cookie present, no SameSite=strict, no CSRF token).

---

## Best Practices to Adopt (2025-2026)

### B.1 Tenant isolation — defense in depth

| Layer | Status today | Recommended |
|---|---|---|
| HTTP boundary (CASL) | ✓ Present (`@CanManage`) | Keep, expand to all admin/* routes |
| Service-layer manual `where: { tenantId }` | ✓ Present | Keep as fail-safe |
| Prisma client extension (auto-inject tenant filter from CLS) | ✗ Missing | **Add (P0)** — pattern in `prisma/prisma-client-extensions/row-level-security` |
| PostgreSQL Row-Level Security (RLS) | ✗ Missing | **Add (Phase 2)** for HIPAA defense in depth |
| Encryption at rest (column-level for secrets) | ✗ Missing | **Add (P0)** — envelope encryption with KMS |

For HOPE's deployment model (≤ 50 tenants today, potentially ≤ 500 by 2027), the path is:
1. **Phase 1 (now)**: Prisma extension auto-filter (3-day effort) + Postgres CHECK constraints on `(tenantId, key)` for platform keys.
2. **Phase 2 (Q3 2026)**: RLS on all tenant-scoped tables once PgBouncer is on session-mode (or Supavisor session-mode).
3. **Skip**: schema-per-tenant and database-per-tenant — overkill at this scale.

### B.2 Configuration storage modeling

Move away from `value: String + dataType` to:

```prisma
model GlobalSetting {
  // ... metadata fields ...
  settingType  SettingType @default(USER_OVERRIDABLE)
  value        Json?       @db.JsonB           // non-secret values
  valueCipher  Bytes?                          // encrypted secrets
  valueKeyId   String?                         // KMS key reference
  valueIv      Bytes?
  valueTag     Bytes?
  schema       Json?       @db.JsonB           // JSON Schema for validation
}

enum SettingType {
  USER_OVERRIDABLE  // tenant admin can edit
  ADMIN_LOCKED      // super-admin only
  SYSTEM_INTERNAL   // never shown in UI
  SECRET            // encrypted, never logged
}
```

Validate with **Zod v4** (TS-first, `z.toJSONSchema()` for cross-language) or **JSON Schema + AJV** (cross-language native).

### B.3 Layered config resolution — replace `__GLOBAL__` clone

```typescript
async resolveConfig(tenantId: string, key: string): Promise<unknown> {
  // 1. user override
  const userOverride = await userSettingRepo.findFirst({ where: { userId, key }});
  if (userOverride) return userOverride.value;
  // 2. department override
  const deptOverride = await deptSettingRepo.findFirst({ where: { departmentId, key }});
  if (deptOverride) return deptOverride.value;
  // 3. tenant override
  const tenantOverride = await tenantSettingRepo.findFirst({ where: { tenantId, key }});
  if (tenantOverride) return tenantOverride.value;
  // 4. system default (single source of truth, never cloned)
  const definition = await settingDefinitionRepo.findFirst({ where: { key }});
  return definition?.defaultValue ?? null;
}
```

Benefits: (a) no clone on tenant create → 0 inserts instead of 17, (b) updating a default for all tenants who haven't overridden = 1 row write, (c) drift impossible by design, (d) tenant offboarding = `DELETE WHERE tenantId = ?` only.

### B.4 Cache + propagation

Replace 45s cron with:

```typescript
// On write
await globalSettingRepository.update(id, entity);
await redis.publish('config:invalidate', JSON.stringify({ tenantId, key }));

// On every pod
redis.subscribe('config:invalidate', (msg) => {
  const { tenantId, key } = JSON.parse(msg);
  cache.delete(`${tenantId}:${key}`);
});
```

Or use Postgres LISTEN/NOTIFY (no Redis dependency). Add SWR semantics — serve stale while async-revalidating.

### B.5 Provisioning rewrite

Replace sequential loop with single statement:

```typescript
const sourceSettings = await globalSettingRepository.findAll({ where: { tenantId: GLOBAL_TENANT_ID }});
const cloned = sourceSettings.map(src => GlobalSettingFactory.CreateGlobalSetting({
  tenantId: newTenantId,
  name: src.name, key: src.key, dataType: src.dataType,
  description: src.description, namespace: src.namespace,
  defaultValue: src.defaultValue ?? src.value,
  value: src.defaultValue ?? src.value,
  locked: src.locked,
  createdBy: this.requestUser?.id,
}));
await globalSettingRepository.createMany(cloned, true);
```

Better still — **stop cloning entirely** and use layered resolution at read time (§B.3).

### B.6 Mandatory secret externalization

Move `JWT_SECRET_KEY`, OIDC client secrets, S3 keys, SMR provider credentials **out of `GlobalSetting`** into env vars OR a vault (Vault Transit / AWS Secrets Manager / Azure Key Vault). The dormant `loadVaultSecrets()` in `config.service.ts:195` is the right architecture — finish it.

### B.7 Audit + history

Add `GlobalSettingHistory` table (mirror of existing `PromptVersion`, `ContextItemVersion` pattern in the codebase). Append-only, populated by a Prisma extension on every update. Indexed on `(globalSettingId, changedAt DESC)`. Supports "show diff over time" and "rollback to T-3d".

Add a `@Secret` field decorator that audit serializers respect (never log decrypted secrets).

### B.8 Observability

Adopt OpenTelemetry semantic conventions for config events (`feature_flag.evaluation` log shape standardized in 2025). Emit on every config read with `tenantId` / `key` / `value.hash` (never the raw value).

### B.9 Recommended library shortlist (NestJS + Prisma + PG + Redis)

| Concern | Library | License | Why |
|---|---|---|---|
| Tenant Prisma extension | `prisma-tenant-extension` or `@nestarc/tenancy` | MIT | Auto-inject `where: { tenantId }`; `failClosed` mode |
| Schema validation (TS) | `zod` v4 | MIT | `z.toJSONSchema()`; 14× faster than v3 |
| Schema validation (cross-lang) | `ajv` v8 | MIT | De-facto JSON Schema |
| Admin form UI from schema | `@rjsf/core` + theme | Apache-2.0 | Renders editable forms from JSON Schema |
| App-level authz | `@casl/ability` + `@casl/prisma` (already in use) | MIT | `accessibleBy` pushes permission to Prisma `where` |
| Cache invalidation | `ioredis` Pub/Sub OR `pg-listen` | MIT | Event-driven; replaces 45s cron |
| Feature flag SDK | `@openfeature/server-sdk` | Apache-2.0 | Vendor-agnostic, swap providers without code change |
| Secrets / column encryption | AWS KMS data keys + envelope OR Vault Transit | varies | HIPAA-eligible under BAA |
| Audit log destination | S3 Object Lock (compliance, 6yr) | — | HIPAA requires effective immutability |
| Observability | `@opentelemetry/api` + `feature_flag.evaluation` events | Apache-2.0 | OTel SemConv 2025 |

---

## Recommended Implementation Roadmap

### Phase 0 — Emergency hotfix (≤ 1 day) — **HARD GATE**

> **Commitment (locked 2026-05-24)**: **Phase 0 MUST be implemented in full before any other phase begins.** All five items below are non-negotiable preconditions for Phase 1; partial Phase 0 ships are explicitly forbidden. If a Phase 0 item is blocked, escalate — do not pull a Phase 1 item forward to "stay productive".

| # | Action | Effort | Risk reduction |
|---|---|---|---|
| 1 | Enable `ValidationPipe({ whitelist: true, forbidNonWhitelisted: true })` globally | XS | Closes P0-2 mass-assignment |
| 2 | Allowlist fields in `updateTenantConfigs` (no spread) | XS | Closes P0-2 even if (1) regresses |
| 3 | Invert default in `AuthorizationGuard` for `admin/*` (deny on empty list) + sweep admin controllers for missing `@CanManage` | S | Closes P0-3 / P0-4 escalation chain |
| 4 | Add audit-log secret scrubbing (`@Secret` decorator or quick filter for `locked: true` rows) | S | Closes P0-6 ongoing leak |
| 5 | Add boot-time invariant check: refuse to start if > 1 row exists for any platform key | XS | Detects P0-1 cache poisoning |
| 6 | **Rotate and remove the real `AZURE_OPENAI_API_KEY` / `SMR_V2_AZURE_API_KEY` currently committed in `apps/api/.env.dev`** | XS | Treats live credential exposure as immediate incident |

**Outcome**: closes the most critical exploit chains AND removes the live-credential exposure detected by the inventory audit. No Phase 1 item starts until items 1-6 are deployed to prod and verified via the smoke checklist below.

**Phase 0 verification gate (exit criteria)** — all must be true before Phase 1:

- [ ] CI red-team test: a `DOCTOR` user `PATCH`ing `JWT_SECRET_KEY` returns 403/400, not 200
- [ ] CI red-team test: `POST /admin/users/:id/roles` from a DOCTOR returns 403
- [ ] Boot-time invariant fails fast in a staging env primed with a duplicate platform key
- [ ] Audit-log SQL query confirms no new entries contain decrypted secret values for rows where `locked: true`
- [ ] `apps/api/.env.dev` and `apps/api/.env.example` carry no values matching `gitleaks` known-secret patterns
- [ ] Re-deployed JWT_SECRET_KEY rotation has occurred and old tokens have expired

### Phase 1 — Structural correctness (2-3 weeks)

| # | Action | Effort | Notes |
|---|---|---|---|
| 6 | Split `AppSettingsService` into `PlatformSettingsService` + `TenantSettingsService` (per-tenant cache) | M | Closes P0-1 properly; aligns consumers |
| 7 | Replace sequential `provisionTenantConfigs` loop with `createMany` inside `CoreUnitOfWorkService.startTransaction` | S | Closes P1-2 / P0-9 |
| 8 | Add Prisma client extension for tenant auto-filter (CLS-based) with `skipTenantCheck` escape hatch | M | Defense in depth |
| 9 | Delete OR complete `GlobalSettingService` + SDK `useGlobalSettings` + `/admin/settings/*` endpoints | M | Closes P1-1 latent gun |
| 10 | Add FK `GlobalSetting.tenantId → Tenant.id` (after orphan back-fill); make `tenantId` `NOT NULL`; tighten unique to `(tenantId, key)` | M | Closes P0-8 / P1-5 |
| 11 | Move JWT/S3/OIDC secrets out of `GlobalSetting` into env or vault; finish `loadVaultSecrets()` | M | Closes P0-7 partially + P2 drift |
| 12 | Replace `value: String + dataType` with `value Json @db.JsonB` + Zod validation | M | Closes P1-6 |

### Phase 2 — Architecture upgrade (1-2 months)

| # | Action | Effort | Notes |
|---|---|---|---|
| 13 | Implement layered config resolution; introduce `SettingDefinition` catalog; deprecate `__GLOBAL__` clone | L | §B.3 — removes ~17 inserts per tenant create |
| 14 | Replace 45s cron with event-driven invalidation (Postgres LISTEN/NOTIFY or Redis Pub/Sub) | M | Closes P1-3 |
| 15 | Add envelope encryption (`valueCipher` + KMS) for `SECRET` rows | L | Closes P0-7 fully |
| 16 | Add `GlobalSettingHistory` table + auto-population via Prisma extension | M | SOC2/HIPAA evidence; rollback capability |
| 17 | Replace `locked: Boolean` with `SettingType` enum; migrate existing rows | M | Better policy granularity |
| 18 | Unify NestJS `ConfigService` consumers onto HOPE `IConfigService` | S | Closes P2 drift |
| 19 | Eliminate direct `process.env` reads outside `IConfigService` | M | Closes P2 drift |
| 20 | Add per-route guard audit (boot-time refusal if any `admin/*` lacks explicit permission) | S | Continuous P0-3 prevention |

### Phase 3 — HIPAA hardening (1-2 months)

| # | Action | Effort | Notes |
|---|---|---|---|
| 21 | Enable PostgreSQL Row-Level Security on all tenant-scoped tables | L | Requires PgBouncer session-mode migration |
| 22 | Move audit log destination to S3 Object Lock (compliance mode, 6yr) | M | HIPAA §164.316(b)(2)(i) |
| 23 | Add cross-tenant fuzz tests (property-based) for every tenant-scoped repository | M | Continuous regression prevention |
| 24 | Add mass-assignment red-team contract tests for every DTO | S | Continuous P0-2 prevention |
| 25 | Adopt OpenFeature server SDK (or equivalent) for feature flag delivery — replace ad-hoc `enable-*` reads | M | Industry standard; OTel-native |

**Total effort estimate**: ~3-5 months at 1 senior engineer, less if parallelized across 2-3 engineers using the strict file-ownership pattern from TASK-258.

---

## Compliance Gap Summary

What an external auditor would flag today (HIPAA Security Rule + SOC2 Trust Service Criteria + GDPR):

| Control | Status | Driving finding |
|---|---|---|
| HIPAA §164.312(a)(1) Access Control | ❌ Failed | P0-3, P0-4 |
| HIPAA §164.312(a)(2)(iv) Encryption at rest | ❌ Failed | P0-7 |
| HIPAA §164.312(b) Audit Controls | ⚠ Partial | Works, but P0-6 contaminates logs |
| HIPAA §164.312(c)(1) Integrity | ❌ Failed | P0-2, P0-5 (data corruption possible) |
| HIPAA §164.316(b)(2)(i) Audit retention 6yr | ❓ Unverified | Depends on audit destination — not in code |
| SOC2 CC6.1 Logical access | ❌ Failed | P0-3 |
| SOC2 CC6.3 Segregation of duties | ❌ Failed | P0-4 |
| SOC2 CC6.7 Restrict information | ❌ Failed | P0-1, P0-7 |
| SOC2 CC7.2 Detect & respond | ⚠ Partial | P0-6 contaminates response evidence |
| GDPR Art. 25 Data protection by design | ❌ Failed | P0-2 mass-assignment |
| GDPR Art. 32(1)(a) Encryption | ❌ Failed | P0-7 |
| GDPR Art. 32(1)(b) Integrity & confidentiality | ❌ Failed | P0-1, P0-2 |
| GDPR Art. 32(4) Authorization of processing | ❌ Failed | P0-3, P0-4 |

**Phase 0 hotfix closes**: CC6.1, CC6.3, integrity-related criteria. Encryption (P0-7) requires Phase 2 work.

---

## Decisions (Locked-in 2026-05-24)

The decision points from the original assessment are resolved. Each decision constrains the design from Phase 1 onward.

| # | Question | **Decision** | Implication |
|---|---|---|---|
| 1 | Tenant count target by 2027 | **≤ 50** | Focus on **Prisma client extension** for tenant filtering (Phase 1, item 8). PostgreSQL Row-Level Security is **deferred to Phase 3** as defense-in-depth, not as the primary isolation boundary. |
| 2 | Deployment model | **Pooled multi-tenant DB** | One PG instance + (eventually) PgBouncer + Prisma extension is the canonical isolation chain. Per-deployment DB is explicitly not on the roadmap. |
| 3 | `__GLOBAL__` semantics | **Keep clone-on-create today.** Layered read-time resolution is a documented future migration. | Phase 1/2 keep current pattern (with the P0/P1 fixes). The migration plan lives in [`research/architecture/system-config-multi-tenancy/01-layered-resolution-migration.md`](../../../research/architecture/system-config-multi-tenancy/01-layered-resolution-migration.md). Reserve `TASK-3XX-Layered-Config-Resolution` for when prioritized. |
| 4 | Secrets storage path | **Env vars today.** Cloud-managed secrets manager (AWS Secrets Manager OR Azure Key Vault) is a documented future migration. | Phase 0 Item 6 + Phase 1 Item 11 enforce env-only secrets. The migration plan lives in [`research/architecture/system-config-multi-tenancy/02-secrets-cloud-kms-migration.md`](../../../research/architecture/system-config-multi-tenancy/02-secrets-cloud-kms-migration.md). |
| 5 | PgBouncer mode | **Best practice fit to Prisma + Prisma Client**: **session-mode pooling** with `@prisma/adapter-pg` tuned via adapter options (Prisma 7 ignores legacy `connection_limit` URL param). Don't deploy a pooler today (≤ 50 tenants); add PgBouncer-session as part of the Phase 3 RLS rollout. | Full guide + drift with existing Patroni HA blueprint flagged in [`research/architecture/system-config-multi-tenancy/03-pgbouncer-prisma.md`](../../../research/architecture/system-config-multi-tenancy/03-pgbouncer-prisma.md). |
| 6 | Optimistic locking on config writes | **Don't touch `_version` today.** Optimistic locking via `_version` + RFC 7232 ETag/If-Match is the recommended pattern; rollout deferred. | Migration plan in [`research/architecture/system-config-multi-tenancy/04-optimistic-locking.md`](../../../research/architecture/system-config-multi-tenancy/04-optimistic-locking.md). When prioritized, start with `TenantService.updateTenantConfigs` (highest-value, lowest-effort). |
| 7 | PG version | **PostgreSQL ≥ 17** | RLS performance, planner improvements, and `pg_stat_io` are all current-gen. No version uplift required. |
| 8 | Acceptable Phase 0 disruption window | **Phase 0 MUST be completely implemented before moving further** | Hard gate enshrined in the Roadmap above. Partial Phase 0 ships forbidden. |

### Reserved tickets (assign when scheduling)

| Ticket placeholder | Driving plan |
|---|---|
| `TASK-3XX-Layered-Config-Resolution` | `01-layered-resolution-migration.md` |
| `TASK-3XX-Secrets-Manager-Migration` | `02-secrets-cloud-kms-migration.md` |
| `TASK-3XX-PgBouncer-Session-Rollout` | `03-pgbouncer-prisma.md` |
| `TASK-3XX-Optimistic-Locking-Config` | `04-optimistic-locking.md` |

---

## Configuration Inventory Findings (cross-stack audit)

A parallel inventory pass over **all environment variables** and **all DB-stored configurations** (global + tenant-scoped) was conducted alongside the original assessment. The full key catalog, scope-violation list, and rename/move/delete recommendations are in the audit transcripts (delivered with this update) and are summarized here. Concretely:

### IV.1 Live credentials in source-controlled files (CRITICAL — Phase 0 Item 6)

`apps/api/.env.dev` currently contains real Azure OpenAI credentials (`AZURE_OPENAI_API_KEY`, `SMR_V2_AZURE_API_KEY`). Treat as compromised: rotate immediately, remove from all `.env*` files, add `gitleaks` pre-commit hook.

### IV.2 Scope violations — settings in the wrong bucket

| Setting | Today | Should be | Why |
|---|---|---|---|
| `S3_ACCESS_KEY`, `S3_SECRET_KEY` | `GlobalSetting` table (plaintext, `seed/06-stt.ts:1690-1712`) | Env / Vault (SYSTEM) | Plaintext secret in DB column; audit-log replication of this on rotation makes it worse |
| `S3_ENDPOINT`, `base_url` (api_gateway) | `GlobalSetting` table (`seed/06-stt.ts`) | Process env (SYSTEM) | Infrastructure URLs vary by deployment, not by tenant |
| `JWT_SECRET_KEY`, `OIDC_CLIENT_SECRET` | `GlobalSetting` cache + env fallback (drift) | Env / Vault only | Currently routed through three paths (`AppSettingsService`, `authenticateJwt.ts`, `gen-dev-token`) — sign/verify can drift |
| `local-asr-models`, `local-vad-models`, `local-noise-suppression-models`, `smr-provider-models` | `GlobalSetting` per-tenant (×4 identical copies) | `GlobalSetting` on `__GLOBAL__` only (GLOBAL-DB catalog) | Identical catalog for every tenant; wastes rows; drift risk on update |
| `SMR_V2_OLLAMA_DEFAULT_MODEL`, `AZURE_TTS_DEFAULT_VOICE`, `AZURE_TTS_DEFAULT_LANGUAGE` | Process env | TENANT-DB (`default-smr-model`, `default-tts-voice`, `default-tts-language`) | Per-tenant preferences hardcoded as a system-wide env |

### IV.3 Setting key drift between backend seed and SDK `TENANT_CONFIG_KEYS`

| Drift class | Examples | Action |
|---|---|---|
| **ORPHAN_IN_SDK** — SDK declares key, backend never seeds it | `default-language`, `enable-real-time-transcription` | Add seed rows in `seed/11-global-setting.ts` |
| **DEAD_KEY** — backend seeds key, SDK ignores it | `enable-consultation-sharing`, `smr-provider-models` (in `TENANT_CONFIG_KEYS` sense) | Either expose in SDK or remove the seed |
| **NAME_DRIFT** — same concept, different IDs | SDK default `silero-vad-v5` vs seed `silero-v5`; SDK SYSTEM_DEFAULT `smr.provider='openai'` vs seed `default-smr-provider='ollama'` | Pick canonical, align SDK SYSTEM_DEFAULTS to backend seeds |
| **DEAD ENDPOINT** — SDK calls `/admin/settings/*` (`GLOBAL_SETTINGS_ENDPOINTS`) | `useGlobalSettings.list/create/update/delete` | No `GlobalSettingsController` exists; either implement or remove from SDK |
| **CONTRACT GAP** — backend uses key not exposed to SDK | `default-stt-pipeline` (resolved in `userPreferences.service.ts:19`) | Document as server-internal or surface via SDK |

### IV.4 Naming convention violations

Five distinct styles currently coexist:

| Style | Where | Recommendation |
|---|---|---|
| SCREAMING_SNAKE_CASE | env vars (✓), system-style keys in `GlobalSetting` (✗) | Keep for env; migrate system keys in GlobalSetting to dot.notation |
| kebab-case | TENANT-DB feature flags (✓), tenant defaults (✓) | Keep |
| dot.notation | system-level GlobalSetting (`crypto.saltRounds`, `monitoring.collectInterval`) (✓) | Keep for SYSTEM/GLOBAL-DB |
| camelCase | UserSettings keys (✓) | Keep for user preferences |
| snake_case | Python pydantic field names (internally only, env vars are SCREAMING_SNAKE) | OK at field level; env vars must stay SCREAMING_SNAKE |

### IV.5 Inter-service env var inconsistencies (api / stt-v2 / smr / nlp / tts)

| Concept | api | stt-v2 | smr | Action |
|---|---|---|---|---|
| OTel exporter | `OTEL_EXPORTER_OTLP_ENDPOINT` | `OTEL_EXPORTER_ENDPOINT` (missing `_OTLP_`) | `SMR_V2_OTEL_EXPORTER_ENDPOINT` | Standardize on `OTEL_EXPORTER_OTLP_ENDPOINT` everywhere |
| OTel enable | `OTEL_TRACES_ENABLED` + `OTEL_METRICS_ENABLED` | `OTEL_ENABLED` (combined) | `SMR_V2_OTEL_ENABLED` | Split per-signal granularity in all services |
| Log level | `LOG_LEVEL` (`info` lowercase) | `LOG_LEVEL` (`INFO` uppercase) | `SMR_V2_LOG_LEVEL` | Drop service prefix; standardize lowercase values |
| DB URL | `DATABASE_URL` (and stale `DB_CONNECTION_STRING` in some `.env`) | `DATABASE_URL` | `DATABASE_URL` | Delete `DB_CONNECTION_STRING*` aliases |
| Redis | `REDIS_HOST` + `REDIS_PORT` + `REDIS_PASS` | `REDIS_URL` | `SMR_V2_REDIS_URL` | Document: api uses decomposed form, Python uses URL; both valid, just call out |
| MinIO/S3 secret | env + GlobalSetting + Docker `MINIO_ROOT_*` | env | — | Single source = Vault; remove duplicates |

### IV.6 Dead env vars (no code reads)

`DEBUG_MODE`, `VERBOSE_LOGGING`, `ENABLE_PROFILING`, `SENTRY_DSN_API`, `PERMIT_*`, `SUMMARY_SERVICE_PROVIDER`, `MLFLOW_TRACKING_URI`, `MLFLOW_MODEL_REGISTRY`, `WORKER_CONCURRENCY` (duplicate of `WORKER_THREADS`), `API_PORT` (duplicate of `PORT`), `TTS_PORT` / `SMR_PORT` / `NLP_PORT` / `FEDL_PORT` (redundant — only `_URL` consumed). All listed in the inventory's "Section K — Deletion list" with file:line.

### IV.7 GlobalSetting orphans (code references with no seed row)

~24 keys read via `appSettingsService.getValueWithDefault(...)` but never seeded — they silently fall back to hardcoded defaults. Most notable:

- `JWT_SECRET_KEY` (falls back to `'default-jwt-secret-key-change-in-production'` — **active production risk**)
- `OIDC_CLIENT_SECRET` (falls back to `'default-client-secret'`)
- `isMaintenance`, `crypto.saltRounds`, `crypto.algorithm`, `crypto.ivLength`, `healthCheck.endpoints`, `healthCheck.diskThreshold`, `healthCheck.memoryThreshold`, `monitoring.retentionLimit`, `monitoring.integrations`, `monitoring.collectInterval`, `metrics.defaultMetricsInterval`, `metrics.prefix`
- `S3_REJECT_UNAUTHORIZED`, `S3_PRESIGNED_URL_EXPIRY`, `S3_MAX_RETRIES`, `S3_REQUEST_TIMEOUT`

**Action**: create `seed/12-system-config.ts` to seed `__GLOBAL__` rows for all of these with the type-correct defaults; remove the inline fallbacks once seeded.

### IV.8 IAppConfig type drift

- `PORT` declared `string` but used as `number` (`main.ts:195`)
- `LOG_FILE_MAX_FILES` declared `number` but parsed from string via `parseInt`
- `URL` declared but no clear consumer found
- `TTS_PORT` / `SMR_PORT` / `NLP_PORT` / `FEDL_PORT` declared but never consumed independently of the `_URL` siblings
- Missing from `IAppConfig` but consumed: `SHUTDOWN_TIMEOUT_MS`, `SHUTDOWN_DRAIN_DELAY_MS`, `SESSION_SECRET_KEY`, `CORS_ALLOWED_ORIGINS`, `LOG_CONSOLE_ENABLED`, `LOG_CONSOLE_JSON`, `LOKI_ENABLED`

### IV.9 Target taxonomy (post-cleanup)

| Bucket | Owner | Naming | Examples | Notes |
|---|---|---|---|---|
| **Environment / process** | Platform engineers | `SCREAMING_SNAKE_CASE` | `DATABASE_URL`, `REDIS_HOST`, `STT_V2_URL`, `LOG_LEVEL`, OTel vars, ports | Deployment-scoped; never changes at runtime |
| **Global DB config** (`GlobalSetting`, `tenantId = __GLOBAL__`) | Platform engineers via admin UI | `dot.notation` for system keys, `kebab-case` for ops flags | `stt.config.*`, `crypto.*`, `healthCheck.*`, `monitoring.*`, `ux-constants.smr-provider-models`, catalog rows | Platform-wide; cached |
| **Tenant DB config** (`GlobalSetting`, per-tenant) | Tenant admins via admin UI | `kebab-case` | `enable-*`, `default-stt-model`, `default-smr-provider`, `vad-sensitivity` | Per-tenant overrides |
| **User DB config** (`UserSetting`, `arcaai-sdk` namespace) | End users | `camelCase` | `workflowMode`, `language`, `dnaStyleId`, `localConfig` | Per-user prefs |
| **Vault** (post-migration) | Secrets manager | provider native | `JWT_SECRET_KEY`, `SESSION_SECRET_KEY`, `OIDC_CLIENT_SECRET`, S3 creds, MQTT_PASS, REDIS_PASS, Azure/HF/Langfuse keys | Fetched on boot |

> **Phase 1 must produce a single source-controlled "Config Inventory" document** (this section, expanded into a per-key catalog) that the team treats as the canonical reference. Every Phase 1 PR that adds / removes / renames a key updates that document in the same commit.

---

## Companion Research Documents

Detailed knowledge bases for the four migration plans cited in §Decisions live at:

| # | Topic | Path | Status | Companion ticket / Stream |
|---|---|---|---|---|
| 1 | `__GLOBAL__` clone → layered read-time resolution | [`research/architecture/system-config-multi-tenancy/01-layered-resolution-migration.md`](../../../research/architecture/system-config-multi-tenancy/01-layered-resolution-migration.md) | Knowledge base — **archived (skipped per user 2026-05-24)** | None — `__GLOBAL__` stays clone-on-create |
| 2 | Env-var secrets → HashiCorp Vault (primary) / AWS / Azure | [`research/architecture/system-config-multi-tenancy/02-secrets-cloud-kms-migration.md`](../../../research/architecture/system-config-multi-tenancy/02-secrets-cloud-kms-migration.md) | Knowledge base — **scheduled** | [`TASK-302 Stream B`](../TASK-302-System-Config-Implementation-Roadmap/02-vault-migration.md) |
| 3 | PgBouncer mode + Prisma 7 best practices (session vs transaction, RLS prep) | [`research/architecture/system-config-multi-tenancy/03-pgbouncer-prisma.md`](../../../research/architecture/system-config-multi-tenancy/03-pgbouncer-prisma.md) | Knowledge base — **scheduled (with user answers)** | [`TASK-302 Stream C`](../TASK-302-System-Config-Implementation-Roadmap/03-pgbouncer-rollout.md) |
| 4 | Optimistic locking via `_version` + ETag/If-Match | [`research/architecture/system-config-multi-tenancy/04-optimistic-locking.md`](../../../research/architecture/system-config-multi-tenancy/04-optimistic-locking.md) | Knowledge base — **scheduled** | [`TASK-302 Stream D`](../TASK-302-System-Config-Implementation-Roadmap/04-optimistic-locking.md) |
| 0 | Overview / index for the subfolder | [`research/architecture/system-config-multi-tenancy/00-overview.md`](../../../research/architecture/system-config-multi-tenancy/00-overview.md) | Index | — |

> **Implementation roadmap**: All scheduled work above is coordinated under the umbrella ticket **[TASK-302 — System Configuration Implementation Roadmap](../TASK-302-System-Config-Implementation-Roadmap/README.md)**, which sequences four streams (A: Phase 0 Hotfix, B: Vault, C: PgBouncer, D: Optimistic Locking), enforces cross-stream dependencies, and assigns subagent roles per task. Stream A (Phase 0) is a **hard gate** — must complete before B/C/D start.

---

## References

External sources cited in the research phase (year-tagged for currency):

- **AWS** — [SaaS Lens: Silo / Pool / Bridge Models](https://docs.aws.amazon.com/wellarchitected/latest/saas-lens/silo-pool-and-bridge-models.html) (2024); [Multi-tenant config with tagged storage](https://aws.amazon.com/blogs/architecture/build-a-multi-tenant-configuration-system-with-tagged-storage-patterns/) (2024)
- **Microsoft** — [Azure App Configuration multitenancy](https://learn.microsoft.com/en-us/azure/architecture/guide/multitenant/service/app-configuration) (2025); [Deployment Stamps Pattern](https://learn.microsoft.com/en-us/azure/architecture/patterns/deployment-stamp) (2025)
- **Postgres RLS** — [Supabase RLS performance guide](https://supabase.com/docs/guides/troubleshooting/rls-performance-and-best-practices-Z5Jjwv) (2025); [Cadence RLS for SaaS](https://cadence.withremote.ai/blog/postgres-rls-saas) (2025); [DebuggAI RLS vs schemas vs DBs](https://debugg.ai/resources/postgres-multitenancy-rls-vs-schemas-vs-separate-dbs-performance-isolation-migration-playbook-2025) (2025)
- **Prisma + tenancy** — [Prisma RLS extension](https://github.com/prisma/prisma-client-extensions/tree/main/row-level-security) (2024); [nestjs-tenancy](https://github.com/nestarc/nestjs-tenancy) (2025); [@casl/prisma](https://www.npmjs.com/package/@casl/prisma) (2025)
- **Schema validation** — [Zod v4 JSON Schema](https://zod.dev/json-schema) (2025); [DEV.to Zod vs JSON Schema](https://dev.to/dataformathub/zod-vs-json-schema-why-2026-is-the-year-of-type-safe-data-contracts-18mf) (2026)
- **Cache invalidation** — [oneuptime Redis-PG sync](https://oneuptime.com/blog/post/2026-03-31-redis-how-to-sync-redis-cache-with-postgresql-changes/view) (2026)
- **Feature flags / observability** — [OpenFeature](https://openfeature.dev/) (2025); [OTel feature flag events](https://opentelemetry.io/docs/specs/semconv/feature-flags/feature-flags-events/) (2025); [LaunchDarkly Progressive Rollouts](https://launchdarkly.com/docs/home/releases/progressive-rollouts) (2025)
- **HIPAA / compliance** — [Aptible HIPAA log retention](https://www.aptible.com/hipaa/audit-log-retention) (2025); [VertiComply HIPAA encryption](https://verticomply.com/blog/hipaa-phi-encryption-requirements) (2026); [Vault Transit](https://docs.hashicorp.com/vault/docs/secrets/transit) (2025)
- **Provisioning / sagas** — [Outbox pattern](https://microservices.io/patterns/data/transactional-outbox.html); [Tenant onboarding LLD](https://www.techinterview.org/post/3233468287/lld-tenant-onboarding/) (2025)
- **Authorization** — [Permit.io OSS authz survey](https://www.permit.io/blog/top-open-source-authorization-tools-for-enterprises-in-2026) (2026)

---

## Change History

- **2026-05-24** — Initial assessment authored by parent orchestrator agent, drawing on parallel subagent reports (researcher / code-reviewer / database-admin / security-auditor / scout). Status: Review. No source code modified.
- **2026-05-24** — Decisions locked-in: tenant count ≤ 50, pooled multi-tenant DB, PG ≥ 17, `__GLOBAL__` kept clone-on-create, secrets stay in env, PgBouncer recommended in session-mode (deferred to Phase 3), `_version` opt-locking documented but not implemented, Phase 0 made a hard gate. Phase 0 expanded with Item 6 (rotate live Azure keys committed in `.env.dev`) and explicit exit criteria. Added cross-stack Configuration Inventory section (live-credential incident, scope violations, SDK ↔ backend drift, naming convention map, target taxonomy). Added Companion Research Documents section linking to four knowledge bases under `research/architecture/system-config-multi-tenancy/`. No source code modified.
- **2026-05-24** — Implementation roadmap commissioned: user selected (a) **implement Vault migration** with HashiCorp Vault as primary for local + self-hosted (AWS/Azure deferred as stub providers), (b) **implement optimistic locking**, (c) **roll out PgBouncer** per user's locked-in answers in research doc §10 (keep transaction mode IF Prisma 7 validation passes; keep `auth_file`; keep per-node placement; use `DATABASE_URL`+`DIRECT_URL` split), (d) **skip layered resolution** (research doc 01 archived). Created [`TASK-302 — System Configuration Implementation Roadmap`](../TASK-302-System-Config-Implementation-Roadmap/README.md) coordinating 4 streams (~157 tasks, ~30 code-review gates, ~61–66 eng-days total, ~5–6 calendar weeks with 4 engineers + 1 SRE in parallel). Stream A (Phase 0) is the hard gate. Updated Companion Research Documents table with companion-stream links. No source code modified.
