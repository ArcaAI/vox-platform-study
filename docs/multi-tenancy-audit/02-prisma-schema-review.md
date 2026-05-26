# Prisma Schema & Database-Layer Multi-Tenancy Audit

| Field | Value |
|---|---|
| **Scope** | `packages/database/` schema, migrations, Prisma client, RLS posture, PgBouncer config |
| **Method** | Read-only evidence-based review (no code changed) |
| **Reviewer** | code-reviewer subagent |
| **Date** | 2026-05-25 |
| **Prior context** | `.cursor/projects/multi-tenancy-audit/01-research-best-practices.md`, `research/architecture/system-config-multi-tenancy/03-pgbouncer-prisma.md`, `docs/implementation/TASK-302-System-Config-Implementation-Roadmap/` |
| **Verdict** | **NOT RELIABLE** — tenant isolation at the data layer is entirely application-mediated; the database will happily return cross-tenant rows on any query that forgets a `tenantId` filter. See §B for the blocker list. |

---

## A. Inventory

`tenantId FK` = is there an `@relation` / SQL `FOREIGN KEY` to `Tenant("id")`? `RLS?` = is there a Postgres RLS policy in any migration? Source files cited as `packages/database/src/prisma/db_main/<file>.prisma`.

| Model | Tenant-scoped | tenant FK | tenantId nullable / default | Unique constraints | RLS? | Issues |
|---|---|---|---|---|---|---|
| `Tenant` (`tenant.prisma:1-29`) | **Global (root)** | n/a | n/a | `@@unique([name,key])`, `key @unique` | No | No relation back from any child; soft-delete only |
| `Policy` (`rbac.prisma:61-110`) | Global | n/a | n/a | `name @unique` | No | OK |
| `Role` (`rbac.prisma:20-59`) | Global | n/a | n/a | `name @unique` | No | "Tenant-customisable" roles share a global name namespace; `isSystemRole` is the only soft separator |
| `RolePolicy` (`rbac.prisma:112-145`) | Global | n/a | n/a | `[roleId,policyId]` | No | OK |
| `UserRoleAssignment` (`user.prisma:8-47`) | Y | **No FK** | **nullable + `'50000000-…'` default** | `[userId,roleId,tenantId]` | No | Nullable + sentinel default → `null = global`; a duplicate global assignment can shadow a tenant-scoped one |
| `User` (`user.prisma:53-102`) | **N (global)** | n/a | n/a | `username @unique`, `externalId @unique` | No | Users live outside any tenant; cross-tenant identity by design |
| `UserProfile` (`user.prisma:145-176`) | N (via User) | n/a | n/a | `userId @unique`, `email` index | No | No tenant attribute on PII (email/phone/avatar) |
| `UserSettings` (`user.prisma:108-139`) | N | n/a | n/a | none | No | No `[userId,key]` uniqueness either |
| `UserMedia` (`user.prisma:182-215`) | N | n/a | n/a | `[userId,mediaId]` | No | Inherits tenancy only by traversing User+Media |
| `UserVoiceProfile` (`user.prisma:221-252`) | N | n/a | n/a | partial unique on `(userId)` where active | No | Voice biometric (HIPAA-sensitive) with no tenantId |
| `Consultation` (`consultation.prisma:4-55`) | Y | **No FK** | **NOT NULL, but `'50000000-…'` default** | none | No | PHI root; default sentinel will silently write to "fallback tenant" on any caller bug |
| `ContextItem` (`consultation.prisma:61-118`) | Y | **No FK** | NOT NULL, sentinel default | none | No | PHI body (transcripts, summaries) — denormalised tenantId never cross-checked against `Consultation.tenantId` |
| `AudioRecording` (`consultation.prisma:125-163`) | Y | **No FK** | NOT NULL, sentinel default | none | No | PHI audio metadata |
| `SummaryMeta` (`consultation.prisma:170-211`) | Y | **No FK** | NOT NULL, sentinel default | `contextItemId @unique` | No | AI-summary metadata for PHI |
| `NamedEntity` (`consultation.prisma:218-262`) | Y | **No FK** | NOT NULL, sentinel default | none | No | Extracted PHI entities (drugs, conditions) |
| `ContextItemVersion` (`consultation.prisma:269-313`) | Y | **No FK** | NOT NULL, sentinel default | `[contextItemId,versionNumber]` | No | Full PHI history snapshots |
| `Department` (`department.prisma:4-51`) | Y | **No FK** | NOT NULL, sentinel default | `[tenantId,code]` | No | Self-referential `parentDepartmentId` not tenant-checked |
| `DnaWritingStyleReport` (`dna-writing-style.prisma:6-44`) | Y | **No FK** | NOT NULL, sentinel default | none | No | Doctor-specific style profile (PII) |
| `DnaWritingStyleVersion` (`…:46-77`) | Y | **No FK** | NOT NULL, sentinel default | `[dnaReportId,versionNumber]` | No | Version snapshots |
| `DnaUsageRecord` (`…:84-109`) | Y | **No FK** | NOT NULL, sentinel default | none | No | Plain-IDs design — no FK to ANY referenced row |
| `PromptUsageRecord` (`…:111-135`) | Y | **No FK** | NOT NULL, sentinel default | none | No | Same |
| `PromptTemplate` (`prompt-template.prisma:23-77`) | Y | **No FK** | NOT NULL, sentinel default | `[tenantId,name]`, `[tenantId,departmentId,ownerUserId,name]` | No | OK constraints; FK to Department not tenant-validated |
| `PromptVersion` (`…:79-110`) | Y | **No FK** | NOT NULL, sentinel default | `[promptTemplateId,versionNumber]` | No | |
| `AsrPipeline` (`stt.prisma:12-50`) | Y | **No FK** | **nullable + sentinel default** | `[tenantId,slug]` | No | `null` allowed → "system pipeline" overlap with sentinel |
| `AiModel` (`stt.prisma:58-119`) | Y | **No FK** | **nullable + sentinel default** | `[tenantId,slug]` | No | Same |
| `TranscriptionJob` (`stt.prisma:126-182`) | Y | **No FK** | NOT NULL, sentinel default | none | No | `consultationId`, `contextItemId`, `mediaId` are plain strings — no FK, no tenant cross-check |
| `AuditLog` (`audit.prisma:1-75`) | Y | **No FK** | **nullable + sentinel default** | none | No | Tamper-evident log is mutable (`UPDATE`/`DELETE` allowed); nullable tenantId means cross-tenant queries on `AuditLog_resourceId_idx` can leak |
| `ApiKey` (`apikey.prisma:20-81`) | Y | **No FK** | **nullable + sentinel default** | `keyHash @unique` (global) | No | A platform-wide hash collision OR a bug that re-hashes per tenant can clash; rotation columns store cross-tenant keyIds |
| `Media` (`media.prisma:1-43`) | Y | **No FK** | **nullable + sentinel default** | none | No | `Media.bucketId` FK to `TenantBucket` not tenant-validated — Media in tenant A can point at TenantBucket in tenant B |
| `TenantBucket` (`tenant-bucket.prisma:4-47`) | Y | **No FK** | **NOT NULL, no default** ✓ | `[tenantId,slug]`, **`name @unique` (global)** | No | Two tenants cannot have the same physical bucket name — fine — but the **global unique on `name`** means tenant creation must coordinate on a global namespace |
| `StorageAccessKey` (`tenant-bucket.prisma:49-93`) | Y | **No FK** | NOT NULL ✓ | `accessKeyId @unique` (global), m:n to TenantBucket | No | `bucketIds String[]` is a denormalised text array with no per-element FK — a string in this array can refer to a bucket in a different tenant |
| `Notification` (`notification.prisma:1-41`) | Y | **No FK** | **nullable + sentinel default** | none | No | `targetUserId` FK with no tenantId cross-check |
| `ResourceSubscription` (`…:43-80`) | Y | **No FK** | **nullable + sentinel default** | none | No | |
| `GlobalSetting` (`globalSetting.prisma:1-47`) | Y | **No FK** | **nullable + sentinel default** | `[tenantId,name,key]` | No | Phase-4 vault encryption uses ciphertext, but ciphertext column is not bound to any per-tenant key id |
| `Webhook` (`webhook.prisma:1-38`) | Y | **No FK** | **nullable + sentinel default** | **`name @unique` (global)** | No | Two tenants cannot have a webhook of the same name |
| `WebhookRunHistory` (`…:40-68`) | **N** (no tenantId) | n/a | n/a | none | No | Child of Webhook but stores no tenantId — every query must join up to Webhook just to filter by tenant |
| `Tag` (`tag.prisma:1-36`) | Y | **No FK** | **nullable + sentinel default** | **none** | No | No unique/index on anything — uncontrolled growth |
| `FedlClient`/`Round`/`Update`/`ModelVersion` (`fedl.prisma`) | Global (ML system) | n/a | n/a | varies | No | OK as system tables |

### Summary count
- 30 tenant-scoped models, **0** with FK to `Tenant`, **0** with RLS.
- 13 of those have `tenantId` declared **nullable**.
- 27 of those have the `'50000000-0000-0000-0000-000000000000'` sentinel as the column default.
- 4 with global-unique constraints that should be tenant-scoped (`Webhook.name`, `TenantBucket.name`, `StorageAccessKey.accessKeyId`, `User.externalId`).

---

## B. Critical Findings (BLOCKER / HIGH)

### B1. No Row-Level Security exists in any migration — tenant isolation is purely application-level — **BLOCKER**

**File**: every migration under `packages/database/src/prisma/db_main/migrations/`
**Evidence**: searching `CREATE POLICY|ROW LEVEL SECURITY|FORCE ROW|BYPASSRLS|ENABLE ROW LEVEL` across the entire migrations tree returns **no matches** (only the validation test files in `tests/pgbouncer-validation/` mention the concept). The `vault-admin-bootstrap.sql` manual script grants:

```60:71:packages/database/src/prisma/db_main/manual/vault-admin-bootstrap.sql
GRANT CONNECT ON DATABASE hope_main TO vault_admin;
GRANT CONNECT ON DATABASE hope_main TO hope_app_template;
…
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA core, audit TO hope_app_template;
```

`hope_app_template` (and therefore every Vault-issued dynamic user) gets unrestricted DML across `core` and `audit`. There is no `ENABLE ROW LEVEL SECURITY`, no `FORCE ROW LEVEL SECURITY`, no `CREATE POLICY` for any table, and no separate role per tenant_user/tenant_admin/platform_admin.

**Impact**: a single missing `where: { tenantId }` clause anywhere in the application — controllers, repositories, raw queries, background jobs, ad-hoc psql sessions, BI dashboards — returns or mutates rows from every tenant. HIPAA §164.312(a)(1) (access controls), GDPR Art.32 (security of processing), and SOC2 CC6.1 all expect a database-enforced control, not an application-promise control. The prior research doc (`01-research-best-practices.md` §1.2) already classes pure application-layer filtering as the 2026 "control-failure risk".

**Recommended fix**:
- *Bare-minimum*: enable `ROW LEVEL SECURITY` + `FORCE ROW LEVEL SECURITY` on the top-5 PHI tables (`Consultation`, `ContextItem`, `AudioRecording`, `SummaryMeta`, `NamedEntity`, `ContextItemVersion`) with `USING (tenantId = current_setting('app.tenant_id', true)::text)` + matching `WITH CHECK` for INSERT/UPDATE/DELETE. Split `hope_app_template` into a non-BYPASSRLS app role.
- *Full*: same on all 30 tenant-scoped models, with a tenant-aware `$extends` (or `nestjs-cls`-driven `SET LOCAL`) that injects context at the start of every transaction. Document a separate `platform_admin` BYPASSRLS role used only by migrations and explicit cross-tenant tooling.

**Effort**: bare-minimum ≈ 1–2 days. Full programme ≈ TASK-302 Phase 2 (already on roadmap per `docs/implementation/TASK-302-System-Config-Implementation-Roadmap/`).

---

### B2. Zero foreign keys from any tenant-scoped table to `Tenant` — **BLOCKER**

**File**: `packages/database/src/prisma/db_main/migrations/20260320044312/migration.sql` lines 1456–1556 (the entire `AddForeignKey` section).
**Evidence**: searching every `ALTER TABLE … ADD CONSTRAINT … REFERENCES "core"."Tenant"` across the migrations tree yields **zero matches**. The schema does not declare a single `@relation` from a tenant-scoped model back to `Tenant`:

```10:11:packages/database/src/prisma/db_main/consultation.prisma
    // Multi-tenant
    tenantId String @default("50000000-0000-0000-0000-000000000000")
```

Nothing in the Consultation block (or any other tenant-scoped model) declares `Tenant Tenant @relation(fields: [tenantId], references: [id])`. The Prisma migration faithfully produces no FK.

**Impact**:
1. **Orphan rows**: deleting a tenant (whether soft or hard) leaves every tenant-owned row in place. GDPR right-to-erasure (`research/architecture/system-config-multi-tenancy/01-…` and `01-research-best-practices.md` §9) is structurally impossible without code that walks 30 tables.
2. **Referential integrity loss**: a row can be written with `tenantId = '<typo>'` and the DB will accept it. Combined with the `'50000000-…'` sentinel default, this is how silent cross-tenant pollution happens.
3. **No `ON DELETE CASCADE` policy decisions captured anywhere** — tenant deletion is undefined behaviour.

**Recommended fix**:
- *Bare-minimum*: for the high-PHI cluster, add `FOREIGN KEY (tenantId) REFERENCES core.Tenant(id) ON DELETE RESTRICT` and back-fill any `'50000000-…'` rows or accept them as the system tenant.
- *Full*: every tenant-scoped table gets an FK. Decide `RESTRICT` (the safe default — block tenant deletion until upstream code has crypto-shredded), or `CASCADE` (only if you commit to "tenant delete = full data wipe in primary DB").

**Effort**: bare-minimum (PHI cluster only) ≈ 1 day including back-fill; full ≈ 2–3 days.

---

### B3. `'50000000-0000-0000-0000-000000000000'` sentinel default on `tenantId` in 27 models — **BLOCKER**

**Files**: e.g.
```11:11:packages/database/src/prisma/db_main/consultation.prisma
    tenantId String @default("50000000-0000-0000-0000-000000000000")
```
```68:68:packages/database/src/prisma/db_main/consultation.prisma
    tenantId String @default("50000000-0000-0000-0000-000000000000")
```
```131:131:packages/database/src/prisma/db_main/consultation.prisma
    tenantId String @default("50000000-0000-0000-0000-000000000000")
```
(plus ApiKey, AsrPipeline, AiModel, TranscriptionJob, Department, DnaWritingStyleReport, DnaWritingStyleVersion, DnaUsageRecord, PromptUsageRecord, PromptTemplate, PromptVersion, GlobalSetting, Media, Notification, ResourceSubscription, SummaryMeta, NamedEntity, ContextItemVersion, AudioRecording, Tag, UserRoleAssignment, Webhook, AuditLog — same literal.)

**Impact**: any application code path that forgets to set `tenantId` on a write does **not** fail — Postgres fills in the system-tenant UUID. The data is now invisibly attributed to "tenant 5000…" and, because no FK constrains the value, even non-existent tenant IDs survive. Combined with B1 (no RLS), this is the most common way teams ship a cross-tenant leak.

**Recommended fix**:
- *Bare-minimum*: drop the `@default(…)` on all PHI-bearing tables (Consultation, ContextItem, AudioRecording, SummaryMeta, NamedEntity, ContextItemVersion, TranscriptionJob) and make tenantId NOT NULL. Force every insert path to pass it explicitly. Keep the seed `5000…` tenant only for the platform-default rows that genuinely belong to it.
- *Full*: drop the default on **all** tenant-scoped models; introduce an `Tenant("00000000-…")` row for genuinely cross-tenant system data and reference it via an explicit constant in seed scripts only.

**Effort**: bare-minimum ≈ 4 hours. Full ≈ 1 day including code-call-site updates.

---

### B4. `tenantId` is **nullable** on 13 models — null silently means "all tenants" — **HIGH**

**Files**:
- `user.prisma:17` — `UserRoleAssignment.tenantId String?` ("null = global assignment")
- `audit.prisma:8` — `AuditLog.tenantId String?`
- `apikey.prisma:27`, `media.prisma:8`, `notification.prisma:8`, `notification.prisma:50` (`ResourceSubscription`), `globalSetting.prisma:8`, `webhook.prisma:8`, `tag.prisma:8`, `stt.prisma:19` (`AsrPipeline`), `stt.prisma:65` (`AiModel`)

**Evidence**:
```14:18:packages/database/src/prisma/db_main/user.prisma
    // multi tenant fields
    // null = global assignment (applies to all tenants)
    // specific ID = tenant-scoped assignment
    tenantId String? @default("50000000-0000-0000-0000-000000000000")
```
The comment says null = global, but the column also has a sentinel default — so on bare INSERT it's neither null nor an explicit tenant; it is the sentinel. Worse, the unique constraint `[userId, roleId, tenantId]` treats NULLs as distinct in Postgres, so a user can hold both a `tenantId = NULL` (global) assignment AND a `tenantId = '<some-tenant>'` assignment for the same role — the global one effectively shadows tenant restrictions.

**Impact**:
1. A null tenantId in `Webhook`, `Notification`, `AuditLog`, etc. is interpreted by application code as "applies to all tenants" — but no future RLS policy can express that cleanly (`tenant_id = current_setting(...)` is false against NULL). You will either lose visibility on global webhooks or punch a hole.
2. The `Postgres-NULL is distinct` rule defeats the `[userId,roleId,tenantId]` uniqueness intent.
3. Auditors will flag any nullable tenant-discriminator on a multi-tenant table as a control gap.

**Recommended fix**:
- Decide per-model whether the row is "system-wide" or "tenant-scoped" and pick one. For genuinely global rows (system-default policies, system AI models), reserve a dedicated `system` Tenant row and reference it.
- Make `tenantId` NOT NULL everywhere. Replace nullable semantics with an explicit `scope String` enum where needed (e.g. `AsrPipeline.scope = SYSTEM | TENANT`).

**Effort**: ≈ 1 day, mostly migration sequencing and seed updates.

---

### B5. Global unique constraints that should be tenant-scoped — **HIGH**

**Evidence**:
```11:11:packages/database/src/prisma/db_main/webhook.prisma
    name                 String  @unique
```
```40:40:packages/database/src/prisma/db_main/tenant-bucket.prisma
    @@unique([name], name: "TenantBucket_name_unique")
```
```63:63:packages/database/src/prisma/db_main/tenant-bucket.prisma
    accessKeyId String @unique
```
```64:64:packages/database/src/prisma/db_main/user.prisma
    externalId       String?   @unique
```
And `User.username @unique` (`user.prisma:60`) — global on purpose? Healthcare SaaS commonly wants per-tenant usernames; ambiguous.

**Impact**: tenant A picks a webhook name `"daily-report"`; tenant B's onboarding fails with a confusing unique-violation error. Worse, the failure message leaks the existence of tenant A's resource. `TenantBucket.name` being a physical S3 bucket name is a defensible global; the other three are not.

**Recommended fix**:
- `Webhook.name`: change to `@@unique([tenantId, name])`.
- `StorageAccessKey.accessKeyId`: change to `@@unique([tenantId, accessKeyId])` if the key is supposed to be tenant-private.
- `User.externalId`: change to `@@unique([tenantId?, externalId])` — but resolve B6 first (Users are global today). One option: leave global and assert in the auth layer that the `externalId`-issuer is the tenant's IdP.
- `User.username`: confirm intent. If tenants are expected to manage their own user namespace, change to `@@unique([tenantId, username])`.

**Effort**: ≈ 4 hours per constraint including data audit + migration; total ≈ 1 day.

---

### B6. `User` model has no `tenantId` — users are global by design, with cross-tenant identity through `UserRoleAssignment` — **HIGH**

**File**:
```53:102:packages/database/src/prisma/db_main/user.prisma
model User {
    …
    id       String @id @default(uuid(7))

    // core fields
    username         String    @unique
    …
}
```
(No `tenantId` field anywhere.)

**Evidence**: confirmed by reading `user.prisma:53-102` and seed `91-user.ts`. The migration SQL likewise has no `tenantId` column on `core.User`.

**Impact**:
1. **Cross-tenant identity is a feature, not a bug** here — one human can hold roles in multiple tenants. But this design has consequences that are not captured in the schema:
   - `UserProfile`, `UserSettings`, `UserMedia`, `UserVoiceProfile` are 1:1/1:N off User and therefore also have **no tenantId**. A doctor's voice profile (biometric, HIPAA-sensitive) is global. If the doctor leaves tenant A but still works at tenant B, what happens to the profile?
   - Login (`username`/`password`) is global — a tenant cannot enforce its own SSO/MFA policy on a user shared with another tenant without complex `UserRoleAssignment`-driven logic.
2. `Consultation.doctorId` references `User.id` with no tenant cross-check. A doctor record that should belong to tenant A could be assigned consultations in tenant B with no DB-level objection.
3. The `Notification.targetUserId` FK has no tenantId pairing — sending tenant A's notification to a user shared with tenant B is plausibly a leak.

**Recommended fix**: this is an architectural decision, not a one-line fix. Three legitimate options:
- *Bare-minimum (preserve the model)*: enforce **at every Consultation/Notification/ApiKey insert** that the doctor/target has an active `UserRoleAssignment` in the target tenant. Encode this as a trigger or as a constraint on `Consultation` (e.g. `EXISTS (SELECT 1 FROM UserRoleAssignment WHERE userId = doctorId AND tenantId = consultations.tenantId)`).
- *Mid*: add a denormalised `tenantId` to `UserProfile`, `UserSettings`, `UserMedia`, `UserVoiceProfile` and create one row per user *per tenant* (so a doctor in two tenants has two profile rows). Aligns with the rest of the schema.
- *Full*: split into `User` (global identity) and `TenantUser` (tenant-scoped membership with all profile/settings/media off it). 2026 industry consensus (research doc §2.x) is this split.

**Effort**: bare-minimum 1–2 days; full split 1–2 sprints. Decision needed first.

---

### B7. No tenant-aware Prisma extension — only soft-delete — **HIGH**

**File**:
```180:221:packages/database/src/client.ts
export function applySoftDeleteExtension(prisma: PrismaClient) {
  return prisma.$extends({
    name: 'softDeleteFilter',
    query: {
      $allModels: {
        async findMany({ model, args, query }: any) {
          if (modelHasSoftDelete(model)) {
            applySoftDeleteFilter(args);
          }
          return query(args);
        },
        …
```

The only `$extends` in the database package is `softDeleteFilter`. There is no extension that:
- injects `where: { tenantId: <current> }` based on `AsyncLocalStorage`/`nestjs-cls`,
- rejects writes that omit `tenantId`,
- rejects writes whose `tenantId` doesn't match the request context,
- wraps every transaction with `SET LOCAL app.tenant_id = …`.

The Prisma 7 client extension API is mandatory for this (`$use` middleware was removed in 6.14 — see research doc §0). So today **every** repository in `packages/domains/` must remember to filter, and **every** raw query (`$queryRaw`, `$executeRaw`) is unscoped.

**Impact**: defence-in-depth layer is missing. Once RLS is in place this becomes redundant; until then it is the only software-level guard.

**Recommended fix**:
- *Bare-minimum*: add a `tenantScope` `$extends` that reads tenantId from `AsyncLocalStorage` and:
  1. For `findFirst/findMany/findUnique/count/aggregate/groupBy`: merges `tenantId` into `where` for every model in a tenant-scoped allow-list.
  2. For `create/createMany/upsert/update/updateMany/delete/deleteMany`: rejects calls where `args.data.tenantId` is missing or `args.data.tenantId !== ctx.tenantId`.
  3. Wraps `$transaction` to run `SELECT set_config('app.tenant_id', $1, true)` as the first statement.
- *Full*: same plus a development-only `$extends` that logs every query missing a `tenantId` predicate (catch repository bugs early).

**Effort**: bare-minimum ≈ 1 day; full ≈ 2 days. Best done together with B1.

---

### B8. Raw `getPrismaClient()` is exported and reachable from application code — **HIGH**

**File**:
```25:27:packages/database/src/index.ts
export {
  applySoftDeleteExtension, createNewExtendedPrismaClient, createNewPrismaClient, getExtendedPrismaClient, getPrismaClient, modelHasSoftDelete, MODELS_WITHOUT_SOFT_DELETE, Prisma, PrismaClientInitializationError, PrismaClientKnownRequestError, PrismaClientRustPanicError, PrismaClientUnknownRequestError, PrismaClientValidationError
} from './client.js';
```
Both `getPrismaClient` (unextended) and `getExtendedPrismaClient` (soft-delete) are public symbols. The cursor rule `02-database-prisma.mdc` says "Use Base only for Admin/system operations", but the convention is non-binding — any service that imports `@arcaai/database` can pick either.

Once a tenant-scoping extension exists (per B7), exporting the raw client effectively means "any developer can opt out of multi-tenancy with a one-line change". That is the same posture the cursor rule already forbids for soft-delete.

**Impact**: the tenant filter is opt-in rather than opt-out. Reviewing every call site for-ever is expensive.

**Recommended fix**:
- Rename `getPrismaClient` to `getPlatformAdminPrismaClient_DangerousBypass` (or similar) and move it behind a barrel that requires an explicit `import` path callers can be lint-gated on.
- Add an ESLint rule (or `dependency-cruiser`) that forbids importing the raw client from anywhere except a small allow-list (migrations, BI dashboards, platform-admin endpoints).

**Effort**: 2 hours for the rename, 1 hour for the lint rule.

---

### B9. `tenantId` on child rows is denormalised but never cross-checked against the parent — **HIGH**

**Evidence**: every child of `Consultation`/`ContextItem` (i.e. `AudioRecording`, `SummaryMeta`, `NamedEntity`, `ContextItemVersion`) carries its own `tenantId String @default("5000…")`. The migration's FK constraints (`migration.sql:1469-1481`) restrict only the parent ID — there is no `CHECK` or trigger that enforces `child.tenantId = parent.tenantId`. Same pattern in DNA and Prompt versions.

**Impact**: a buggy or malicious code path can write an `AudioRecording` row with `tenantId = 'B'` attached to a `ContextItem` belonging to tenant A. RLS policies that key on `current_setting('app.tenant_id')` will hide the row from tenant A's queries — but exposure happens through tenant B's queries instead. The denormalised tenantId becomes a poisoning vector rather than a defence layer.

**Recommended fix**:
- *Bare-minimum*: add a `CHECK` constraint or a trigger on child tables that compares `NEW.tenantId` with the parent. Example:
  ```sql
  CREATE OR REPLACE FUNCTION assert_audio_tenant_matches() RETURNS trigger AS $$
  BEGIN
    IF NEW."tenantId" <> (SELECT "tenantId" FROM core."ContextItem" WHERE id = NEW."contextItemId") THEN
      RAISE EXCEPTION 'AudioRecording.tenantId does not match ContextItem.tenantId';
    END IF;
    RETURN NEW;
  END $$ LANGUAGE plpgsql;
  CREATE TRIGGER trg_audio_tenant_match BEFORE INSERT OR UPDATE ON core."AudioRecording"
    FOR EACH ROW EXECUTE FUNCTION assert_audio_tenant_matches();
  ```
- *Full*: drop denormalised `tenantId` columns where they are not needed for performance (RLS policies can join up one level once an index exists). This eliminates the consistency problem at the cost of one join.

**Effort**: bare-minimum ≈ 4 hours for the PHI cluster.

---

### B10. `Consultation.doctorId` FK does not enforce that the doctor has access to the consultation's tenant — **HIGH**

**File**:
```17:19:packages/database/src/prisma/db_main/consultation.prisma
    // Doctor (FK to User)
    doctorId String
    Doctor   User   @relation("DoctorConsultations", fields: [doctorId], references: [id])
```

```1459:1460:packages/database/src/prisma/db_main/migrations/20260320044312/migration.sql
-- AddForeignKey
ALTER TABLE "core"."Consultation" ADD CONSTRAINT "Consultation_doctorId_fkey" FOREIGN KEY ("doctorId") REFERENCES "core"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
```

The FK only verifies that `doctorId` exists in `User`. Since `User` has no tenantId (B6), there is no DB-level check that the doctor is a member of the consultation's tenant.

**Impact**: a code path that joins doctor ↔ consultation could attribute PHI to a doctor who has never had an `UserRoleAssignment` for that tenant — including a doctor who left tenant A but still works at tenant B.

**Recommended fix**: trigger or constraint that on Consultation insert requires `EXISTS (SELECT 1 FROM UserRoleAssignment WHERE userId = NEW.doctorId AND tenantId = NEW.tenantId AND resourceStatus = 'ENABLED')`. Same for `DnaWritingStyleReport.doctorId`, `Notification.targetUserId`, `ApiKey.userId`, `PromptTemplate.ownerUserId`.

**Effort**: bare-minimum (just `Consultation`) ≈ 4 hours; full sweep ≈ 1 day.

---

### B11. PgBouncer config is wrong for the RLS roadmap and not deployed in dev — **HIGH (latent)**

**Evidence**:
- `packages/database/src/client.ts:43-78` configures `PrismaPg` with `max = 5` and notes that "When DATABASE_URL points at PgBouncer (port 6432 in production), migrations must use DIRECT_URL via prisma.config.ts to keep advisory locks intact".
- `.env.dev:37-43` points DATABASE_URL and DATABASE_URL_DIRECT at `localhost:5432` — direct PG, no pooler.
- Searching `pool_mode|server_reset_query|pgbouncer` under `infrastructure/docker/` returns no matches. The `infrastructure/grafana/dashboards/pgbouncer.json` exists but no pgbouncer service is wired into the compose.
- `research/architecture/system-config-multi-tenancy/03-pgbouncer-prisma.md:13-19` warns that the Patroni HA blueprint already ships PgBouncer in `POOL_MODE=transaction` — which is the **dangerous** mode for `SET` (vs `SET LOCAL`).

**Impact**: when RLS is finally enabled and production migrates traffic to PgBouncer in transaction mode, any code that uses `SET app.tenant_id = …` (non-LOCAL) leaks across requests. This is well-known; the validation tests in `packages/database/tests/pgbouncer-validation/__tests__/02-rls-guc-leak.test.ts` already encode it, but the production wiring is not yet built.

**Recommended fix**:
- Decide PgBouncer mode **before** RLS rollout (session vs transaction with `server_reset_query = DISCARD ALL` + `server_reset_query_always = 1`).
- Mandate `set_config('app.tenant_id', $1, true)` (the `true` arg = transaction-local) inside every `$transaction()` and forbid `SET` (non-LOCAL) via lint rule + the validation test suite.
- Append `?pgbouncer=true` to `DATABASE_URL` in production to disable Prisma's prepared-statement cache (per the research doc).

**Effort**: 1 day decision + 2 days implementation; covered by TASK-302 Phase 2.

---

### B12. Soft-delete extension's `findUnique` handler bypasses the soft-delete filter — **HIGH (data hygiene, not isolation)**

**File**:
```197:199:packages/database/src/client.ts
        async findUnique({ args, query }: any) {
          return query(args);
        },
```
But the docstring above (lines 158-170) claims:
```161:161:packages/database/src/client.ts
 * - findUnique: Excludes DELETED records (converts to findFirst internally)
```

The handler does NOT apply `applySoftDeleteFilter`. So `findUnique({ where: { id } })` returns the row even when `resourceStatus = 'DELETED'`. This is divergent from the stated behaviour and from every other operation in the extension.

**Impact**: not a multi-tenant issue per se, but a bug worth flagging in this audit because it shows the soft-delete contract is silently broken — and the "soft delete = GDPR erasure" assumption elsewhere in the codebase relies on the contract. Once RLS lands, this bug will only matter to platform-admin code paths.

**Recommended fix**: add `if (modelHasSoftDelete(model)) applySoftDeleteFilter(args);` to the findUnique branch — matches the documented behaviour. Or update the comment to say "findUnique is intentionally not filtered" and add a test pinning that contract.

**Effort**: 30 minutes including the test.

---

## C. Medium Findings

### C1. `Consultation`-level composite indexes do not lead with `tenantId` for the patient-by-date pattern — only `[tenantId, patientId, appointmentDate]` covers part of it
```46:53:packages/database/src/prisma/db_main/consultation.prisma
    @@index([tenantId], name: "Consultation_tenantId_idx")
    @@index([patientId], name: "Consultation_patientId_idx")
    @@index([appointmentDate], name: "Consultation_appointmentDate_idx")
    @@index([doctorId], name: "Consultation_doctorId_idx")
    @@index([departmentId], name: "Consultation_departmentId_idx")
    @@index([parentConsultationId], name: "Consultation_parentId_idx")
    // Composite for common query pattern
    @@index([tenantId, patientId, appointmentDate], name: "Consultation_tenant_patient_date_idx")
```
The `(doctorId)` and `(departmentId)` indexes are single-column; once RLS is on (B1), every query is implicitly `tenantId = X AND doctorId = Y`. Without a `[tenantId, doctorId]` composite, the planner will choose either `(tenantId)` or `(doctorId)` and filter. Fix: replace `@@index([doctorId])` and `@@index([departmentId])` with `[tenantId, doctorId]` and `[tenantId, departmentId]`. Same fix applies across `ContextItem`, `AudioRecording`, `NamedEntity`, `SummaryMeta`.

### C2. `AuditLog` is mutable — no append-only constraint
`audit.prisma:1-75` defines normal `updatedAt` and `resourceStatus` columns and no special restrictions. HIPAA §164.312(b) (audit controls) and SOC2 CC7.3 expect audit logs to be tamper-evident; in practice teams either lock the table to INSERT-only (revoke UPDATE/DELETE) or ship logs to an append-only sink. Recommend revoking UPDATE/DELETE on `core.AuditLog` for `hope_app_template` and reserving mutations for a `platform_audit_admin` role.

### C3. `StorageAccessKey.bucketIds String[]` is a plain text array, no FK per element
```68:68:packages/database/src/prisma/db_main/tenant-bucket.prisma
    bucketIds   String[] @default([])       // Empty = all tenant buckets
```
Any string can land in this array, including a TenantBucket id belonging to a different tenant. Recommend either (a) replacing with a join table `_StorageAccessKey_Bucket` (the schema already has `_BucketAccessKeys` via the `@relation("BucketAccessKeys")`), and drop `bucketIds`; or (b) keep the array but add a trigger that asserts every element exists in `TenantBucket` for the same tenantId.

### C4. `secret1`/`secret2` on `User` are plaintext-ish
```67:70:packages/database/src/prisma/db_main/user.prisma
    secret1          String?
    secret1Expiry    DateTime?
    secret2          String?
    secret2Expiry    DateTime?
```
Names suggest API/OTP secrets; column type is plain `String`. No `Bytes`, no `keyVersion`, no marker that the application layer encrypts. Likely encrypted upstream but the schema gives no documentation. Recommend explicit `encryptedValue Bytes? + keyVersion Int?` mirror of the `GlobalSetting` pattern.

### C5. `User.password` is a plain string — no policy that it is always a bcrypt/argon2 hash
Same risk surface as C4. Naming would benefit from `passwordHash` + `passwordAlgorithm` + `passwordSalt` (or a single argon2 self-describing string).

### C6. `Department.parentDepartmentId` self-reference is not tenant-checked
```27:29:packages/database/src/prisma/db_main/department.prisma
    parentDepartmentId String?
    ParentDepartment   Department?  @relation("DepartmentHierarchy", fields: [parentDepartmentId], references: [id])
    ChildDepartments   Department[] @relation("DepartmentHierarchy")
```
Department in tenant A could parent-link to a Department in tenant B. Add the cross-tenant check via trigger (same family as B9). Same applies to `Consultation.parentConsultationId` and `Role.parentRoleId`.

### C7. `UserVoiceProfile.embedding` is `vector(256)` — pgvector indexes are not declared
`user.prisma:228-232` defines a vector but no `USING ivfflat` / `hnsw` index. Voice-match queries today are full scans. Not a multi-tenancy issue per se, but worth pairing with `(tenantId, embedding vector_cosine_ops)` once tenantId is added — see B6.

### C8. `Tag` has no unique or index at all
`tag.prisma` declares only the PK. `tagKey + tagValue` is meant to be unique per resource per tenant. Recommend `@@unique([tenantId, resourceTypeName, resourceId, tagKey])` and `@@index([tenantId, resourceTypeName, resourceId])`.

### C9. `TranscriptionJob` references `consultationId`, `contextItemId`, `mediaId` as plain strings — no FK
```138:142:packages/database/src/prisma/db_main/stt.prisma
    // Related entities (external references, no FK to Consultation/ContextItem)
    consultationId String? // Target consultation
    contextItemId  String? // Created ContextItem (after completion)
    mediaId        String? // Source audio file (for batch)
```
This is consistent with `DnaUsageRecord`/`PromptUsageRecord`. The reasoning (in the comment) is acceptable for usage-audit tables, but `TranscriptionJob` is operational state — the lack of FK + tenant cross-check means an STT worker can mis-route a job to a contextItem in another tenant on retry. Recommend at minimum a CHECK trigger.

### C10. `Tenant` has only soft-delete; deactivation behaviour undefined
`tenant.prisma:13-15` carries `resourceStatus` but there is no cascade rule: setting `resourceStatus = 'DISABLED'` on a Tenant does nothing to its data. Need a documented "tenant disabled means…" decision (RLS row-block? application-level guard? both?).

### C11. `migration.sql` for the baseline migration creates everything in one shot; no `NOT VALID` constraints anywhere
This is fine for greenfield but means the first time you back-fill a `tenantId` on an existing row, you need to know the schema-evolution playbook (`ADD CONSTRAINT … NOT VALID; … VALIDATE CONSTRAINT;`). Worth documenting in the TASK-302 roadmap before B1/B2 land.

### C12. `prisma.config.ts` uses `DIRECT_URL` for migrations but the local dev `DIRECT_URL` equals `DATABASE_URL`
```37:43:.env.dev
DATABASE_URL=postgres://postgres:postgres@localhost:5432/hope
…
DATABASE_URL_DIRECT=postgres://postgres:postgres@localhost:5432/hope
```
Harmless in dev but worth highlighting that the rule "DIRECT_URL bypasses pooler" is invisibly violated when both URLs are identical. Production must keep them distinct, which the comment in `client.ts:50-56` already notes.

---

## D. Low / Hygiene Findings

- **D1.** `AuditAction` enum is missing `EXPORT` and `IMPERSONATED_ACTION` is added in a follow-up migration (`20260524100000_add_audit_action_impersonated/migration.sql`). Consider a single canonical enum source so adds stay grouped.
- **D2.** `ResourceType` enum (`audit.prisma:90-147`) lists 30+ subjects — kept in sync manually with the model list. A code-generation step would prevent drift.
- **D3.** `metaData` on every model is `Json?` with no schema constraint — anything can be stuffed in, including (accidentally) PHI. Consider a discriminator field or per-resource Zod validation in the app layer.
- **D4.** `ApiKey.usageCount Int` will overflow at ~2.1B requests. Use `BigInt`.
- **D5.** `Notification.tags` lacks `@default([])`, unlike every other `tags` field — minor inconsistency.
- **D6.** `WebhookRunHistory` (`webhook.prisma:40-68`) has no indexes at all (PK only) — `WHERE webhookId = X ORDER BY createdAt DESC` will scan.
- **D7.** Several models duplicate `id @default(uuid(7))` and `version`/`metaData` boilerplate — could be normalised via Prisma 7's `type` composition (preview feature).
- **D8.** `media.prisma:8` keeps `tenantId` nullable even though `Media.bucketId` FKs into a NOT NULL-tenant table; tighten Media's tenantId to NOT NULL.
- **D9.** `vault-admin-bootstrap.sql` does not explicitly set `NOBYPASSRLS` on the new roles. The PostgreSQL default is `NOBYPASSRLS`, but make it explicit so re-reads of the script don't have to verify the default.
- **D10.** `seed/01-policy.ts` rules reference `${context.tenantId}` template literals. There is no test that fails when a tenant-scoped policy forgets the `tenantId` condition (e.g. `consultation-shared-patient-read` *does* have `tenantId`, but `manage UserProfile` in `tenant-full-access` at line 79 does **not** — and UserProfile has no tenantId column, so the CASL rule cannot enforce anything).
- **D11.** `tag.prisma` `createdBy` lacks the standard `@default("60000000-…")` placeholder. Trivial inconsistency.
- **D12.** `User.lastLoginAt`/`lastActiveAt` updates on every request. With no tenantId, this is a global hot row that competes for vacuum; consider moving to a `UserActivity` table or pushing to Redis with periodic flush.

---

## E. Anti-patterns observed

1. **Sentinel UUID defaults** (B3) — every multi-tenant table treats `'5000…'` as "magic system tenant". Industry consensus (`01-research-best-practices.md` §3.3) is **explicit-or-fail**: omit the default, force the caller to pass tenantId.
2. **Denormalised tenantId without a cross-table consistency contract** (B9). The benefit of denormalisation (index leading column) is eaten by the cost of "now I have to maintain two sources of truth on every write".
3. **Soft-delete extension claiming a behaviour it does not implement** (B12) — `findUnique` bypasses the filter while the JSDoc says it doesn't.
4. **Nullable tenantId interpreted as "applies to all tenants"** (B4) — null is not a multi-tenancy primitive. Either reserve a system Tenant row, or carry a separate `scope` enum, or split tables.
5. **Plain-string FKs ("no FK relations" comment)** in `DnaUsageRecord`, `PromptUsageRecord`, `TranscriptionJob` (C9). Usage logs benefit from FK because tenancy is the join key; the comment "no FK" sacrifices integrity for negligible write throughput.
6. **Global unique constraints on tenant-named resources** (B5) — leaks the existence of one tenant's resource to another tenant via a unique-violation error.
7. **One singleton Prisma client + ambient tenant context expected from the caller** — Prisma 7 best practice (research doc §5.x) is a `$extends({ query: ... })` middleware that pulls tenantId from `AsyncLocalStorage`. The package ships only the soft-delete extension.
8. **Raw `getPrismaClient()` exported as a peer of `getExtendedPrismaClient()`** (B8) — opt-out by import.
9. **Default `createdBy = '60000000-…'`** silently attributes data to a seed user when the caller omits it (`apikey.prisma:67`, `consultation.prisma:37`, every other model). Same family of footgun as the tenantId sentinel.
10. **`User` model with global `username` and no tenantId** (B6) — a deliberate architectural choice that the schema does not explain, document, or guard.

---

## F. Bare-minimum quick wins (≤1 day each)

These each tighten the data-layer posture without committing to the full TASK-302 Phase 2 rollout.

1. **Drop the `'5000…'` `@default` on the six PHI tables** (`Consultation`, `ContextItem`, `AudioRecording`, `SummaryMeta`, `NamedEntity`, `ContextItemVersion`) and make `tenantId NOT NULL`. Forces the bug to surface as a write failure rather than a silent mis-attribution. (B3, ≈ 4 hours.)
2. **Fix the soft-delete `findUnique` divergence** in `packages/database/src/client.ts:197-199`. Add a unit test that pins the contract. (B12, ≈ 30 minutes.)
3. **Add a `CHECK`-trigger on the five Consultation children** that asserts `child.tenantId = parent.tenantId`. (B9, ≈ 4 hours.)
4. **Add FK from `Consultation.tenantId`, `ContextItem.tenantId`, `AuditLog.tenantId` to `Tenant.id` with `ON DELETE RESTRICT`.** (B2 partial, ≈ 4 hours; needs back-fill audit first.)
5. **Make `Webhook.name` unique per tenant** (`@@unique([tenantId, name])` instead of `name @unique`). (B5, ≈ 2 hours including data audit.)
6. **Rename `getPrismaClient` → `getPlatformAdminPrismaClient_Unscoped`** and add an ESLint rule restricting its import to a small allow-list. (B8, ≈ 2 hours.)
7. **Make `tenantId` NOT NULL on `Webhook`, `Notification`, `AuditLog`, `ApiKey`, `Media`, `GlobalSetting`** by reserving a `system` Tenant row and back-filling. (B4 partial, ≈ 6 hours.)
8. **Lock down `AuditLog`** — revoke UPDATE/DELETE on `core.AuditLog` from `hope_app_template`; create a `platform_audit_admin` role for compliance officers. (C2, ≈ 3 hours.)
9. **Add `[tenantId, doctorId]` and `[tenantId, departmentId]` composite indexes** on `Consultation` (and analogous indexes on `ContextItem`, `NamedEntity`). Drop the now-redundant single-column versions. (C1, ≈ 2 hours.)
10. **Document tenant deletion behaviour** in `packages/database/README.md` — either commit to RESTRICT (tenant deletion requires crypto-shred of all referenced rows) or CASCADE (tenant deletion wipes everything). Currently undefined. (C10, ≈ 2 hours of writing, no schema change.)

---

## G. Strategic improvements

1. **TASK-302 Phase 2 RLS rollout — accelerate.** The research and PgBouncer doc together prescribe the full plan; the schema today provides the substrate (tenantId everywhere) but none of the enforcement. Treat B1+B2+B3 as a single migration train: FK → drop defaults → enable+force RLS → split `hope_app_template` into `hope_tenant_user` and `hope_platform_admin` (only the latter `BYPASSRLS`).
2. **Tenant-aware Prisma extension** (B7) — write `tenantScope` `$extends` that reads `AsyncLocalStorage`, injects `where: { tenantId }` for read ops, and asserts `data.tenantId === ctx.tenantId` for writes. Pair with a transaction wrapper that runs `SELECT set_config('app.tenant_id', $1, true)` as the first statement of every `$transaction`. This is defence-in-depth alongside RLS.
3. **Decide the `User` model split** (B6). Pick one of: (a) keep global User + add a `TenantUserMembership` model + per-tenant profile/settings rows; (b) introduce per-tenant `TenantUser` and demote `User` to a global-identity anchor; (c) accept the cross-tenant-by-design semantics and explicitly forbid cross-tenant queries with triggers (B10).
4. **Crypto-shredding for GDPR right-to-erasure.** The research doc §9 calls this the 2026 answer. `GlobalSetting` already carries `encryptedValue/keyVersion` — extend the same pattern to PHI columns (`ContextItem.content`, `ContextItemVersion.content`, `Consultation.metadata`, `UserVoiceProfile.embedding`, `User.password`) with a per-tenant or per-subject key in Vault Transit. Deletion = destroy the key.
5. **Replace plain-string FKs with proper relations** where multi-tenancy isolation matters (C9). `TranscriptionJob` should at minimum FK to `Consultation`/`ContextItem`/`Media` with `ON DELETE SET NULL` and a child-tenant trigger (B9).
6. **Introduce a `system` Tenant row** (UUID `00000000-0000-0000-0000-000000000000` is already used in seed data; reserve it formally) for genuinely global rows: system policies, system AI models, system pipelines. Replace nullable `tenantId` everywhere (B4).
7. **Append-only audit log** (C2). Either move `AuditLog` to a partitioned table with monthly time partitions + retention drop policy, or stream to an external append-only sink (CloudWatch / S3 + Object Lock). The current shared table is a single point of forgery.
8. **PgBouncer config & rollout choice** (B11). Lock in `pool_mode = session` for the first RLS production window, then re-evaluate; if connection count rises, switch to `transaction` mode with `server_reset_query = DISCARD ALL` and the existing `02-rls-guc-leak.test.ts` as the CI gate.
9. **Per-tenant connection pool budgeting (later).** `client.ts:42-50` budget rule already references the formula. Once tenant population exceeds ~50, document a per-tenant max-connections allocation for noisy-neighbour control.
10. **Schema-codegen for `ResourceType` enum** — drift between Prisma models and the audit enum (D2) is a perennial bug source. Generate the enum from the schema.

---

## H. Positive observations

1. The schema **consistently puts `tenantId` near the top of every tenant-scoped model**, even when nullable — the convention is uniformly applied, which makes future RLS rollout much easier than a half-migrated codebase.
2. **Every tenant-scoped model has at least a `@@index([tenantId])`** (`audit.prisma:49`, `consultation.prisma:46`, etc.) — so RLS policies will not produce immediate seq-scan regressions.
3. The `client.ts` extension architecture (`applySoftDeleteExtension`) is the correct Prisma 7 pattern — adding a `tenantScope` extension is a copy-paste of the same shape (B7 fix).
4. **`prisma.config.ts` already uses `DIRECT_URL` for migrations** — covers the PgBouncer advisory-lock footgun that catches most teams during their first pooler rollout.
5. **`ContextItemVersion`/`PromptVersion`/`DnaWritingStyleVersion`** are properly modelled as immutable version-history tables and explicitly excluded from soft-delete (`MODELS_WITHOUT_SOFT_DELETE`, `client.ts:101-110`).
6. **Cascade choices on user-owned data are correct**: `UserSettings`, `UserProfile`, `UserVoiceProfile`, `UserMedia`, `UserRoleAssignment` all `ON DELETE CASCADE` from `User` — so when a user is hard-deleted, their per-user rows disappear. The only gap is that consultations/dna-reports use `RESTRICT`, which is also the right choice (PHI cannot disappear silently).
7. **Vault-backed dynamic credentials** (`vault-client.ts`) are the right direction — rotating short-lived DB users is much better than static long-lived passwords. Once paired with `NOBYPASSRLS`, this is industry-leading.
8. **TASK-302 Phase 4 envelope encryption on `GlobalSetting`** (`globalSetting.prisma:21-22`) demonstrates that the team already understands the field-level-encryption-with-key-version pattern — extending it to PHI is mechanical.
9. **PgBouncer validation tests already exist** (`tests/pgbouncer-validation/__tests__/02-rls-guc-leak.test.ts`) — the test suite is ahead of the production deployment. This is the right order: have the assertion before you build the thing.
10. The team's prior research (`01-research-best-practices.md`, `03-pgbouncer-prisma.md`) is **excellent and authoritative**. Most schools-of-thought disagreement is already resolved. This audit is essentially a "now go execute" pointer rather than a "you got the architecture wrong" critique.

---

*End of audit.*
