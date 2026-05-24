# System Configuration — Migration Plan: `__GLOBAL__` Clone → Layered Read-Time Resolution

| Field | Value |
|---|---|
| **Status** | Planning / Knowledge Base (not scheduled) |
| **Audience** | Senior backend / platform engineers scoping work |
| **Owners** | TBD — assign at scheduling time |
| **Predecessors** | TASK-258 (Tenant Config Provisioning), TASK-297 (SDK 4-tier ConfigManager), TASK-301 (System Config & Multi-Tenancy Assessment) |
| **Companion ticket** | TBD (`TASK-3XX-Layered-Config-Resolution`) |
| **Created** | 2026-05-24 |

> **Scope of this document**. This is a *future-work* knowledge base, not an executable plan. It captures the design intent so that when the work is prioritised, an engineer can scope it in a single planning session and start a TASK ticket with the README pre-populated. **No code change should result from reading this document alone.**

---

## 1. Why migrate — concrete benefits and costs

### 1.1 What the current `__GLOBAL__` clone-on-create pattern looks like

HOPE today persists every runtime configuration row in a single `core.GlobalSetting` table keyed by `(tenantId, name, key)`. A *sentinel tenant* with UUID `50000000-0000-0000-0000-000000000000` (the `__GLOBAL__` tenant) holds the master defaults. When a real tenant is provisioned, `TenantService.provisionTenantConfigs()` walks the sentinel's rows in a sequential `for` loop and emits ~17 `INSERT` statements that **deep-copy each default** into a tenant-owned row, freezing the value at provisioning time. The cache (`AppSettingsService`) reads every row in the database on a 45 s cron and stores them in a process-local `Map<key, entity>` — keyed by `setting.key` alone, which compounds the design's brittleness.

### 1.2 Concrete defects of clone-on-create

| Defect | Consequence |
|---|---|
| **Default drift** — updating `__GLOBAL__.<key>` does not touch the tenant-owned copies. | Every legacy tenant remains stuck on the old default; new STT model = bespoke backfill *every time*. |
| **Write amplification** — 17 inserts per tenant create, growing linearly with the catalog. | Storage and write cost both proportional to `tenants × keys`, not to actual change. |
| **Schema rigidity** — new setting = hand-written `UPSERT` into every tenant. | Easy to forget; produces silent gaps where some tenants lack the key. |
| **Audit complexity** — same value in N rows. | Auditors cannot answer "did this tenant change this, or was it cloned?" without forensic SQL. |
| **Cross-tenant cache collisions** — TASK-301 P0-1. | JWT-secret / S3-key leak; documented. |
| **No "inherit" semantic** — the copy *is* the value. | Reverting to default = manual lookup of sentinel value + write. |

### 1.3 Benefits of layered read-time resolution

| Benefit | Mechanism |
|---|---|
| **Default propagation is instant** | A single `UPDATE SettingDefinition SET defaultValue = ...` reaches every tenant that has not overridden. |
| **Storage proportional to *change*, not *existence*** | Only divergent rows persist. Marin's writeup confirms this scales to thousands of tenants. |
| **No write on tenant create** | Provisioning emits zero `INSERT` against config tables; first `GET /tenant/me/config` resolves layer-by-layer. |
| **Cleaner audit** | A row in `TenantSettingOverride` *is* the audit signal — "tenant deliberately changed this key". |
| **Department / user tiers are additive** | New tier = one table + one resolver branch, not a 4-place schema change. |
| **SDK alignment** | `@arcaai/vox` `ConfigManager` already does `SYSTEM → tenant → department → user` (TASK-297). The backend currently lies about layers — every value comes back tier-1. Migration fixes the asymmetry. |

### 1.4 Costs and risks

| Cost | Mitigation |
|---|---|
| **Read path is more complex** — up to 4 lookups vs 1 today. | Bulk-resolve per tenant with a single composite query (`SELECT key, value, layer FROM ... UNION ALL ...`), cache the projection in Redis. Sub-millisecond hits even at p99 — same envelope as today. |
| **Potential N+1 on bare reads** | Forbid per-key reads in tight loops; force callers through `resolveAllForTenant(tenantId)` which fetches the whole projection in one pass. |
| **Migration surgery touches every consumer** | Dual-write/dual-read phase contains blast radius (see §5). |
| **`null` semantics need care** | `null` in `TenantSettingOverride.value` means *"explicitly set to null"*; **absence of row** means *"inherit from parent"*. Document this contract; reject ambiguous payloads at the DTO layer. |
| **Backfill correctness** | A bad SQL transform corrupts every tenant's defaults. Phase A is additive only; cutover (Phase B) is reversible by flag flip. |

### 1.5 When does the cost-benefit clearly tip positive?

Two thresholds. Either one is sufficient.

1. **Write amplification ≥ 25× current**. Today: 17 inserts per tenant. We hit the threshold when the catalog grows past ~40 keys *or* tenant count crosses ~125 (whichever first). At HOPE's stated growth (≤ 50 tenants by 2027, key count drifting up as features ship), this is **2026 H2 territory**.
2. **Any business-driven default rollout** that needs to reach all existing tenants without per-tenant backfill (e.g. new STT model, regional model routing, updated prompt template defaults). The next such rollout pays for the entire migration once over.

**Verdict**: schedule for **Q4 2026**, immediately after the TASK-301 Phase 0/1 security hotfixes land. Don't combine with the security hotfixes — the security work needs to ship in days; this needs weeks.

---

## 2. Reference architectures (2024–2026)

The pattern below is mainstream, not novel. Each citation is the strongest one I could find on the public web.

### 2.1 Shopify / Stripe-shape settings systems

The closest prior art is Marin, *"Your JSON Column Is Not a Settings System"* ([Medium, Mar 2026](https://medium.com/@igmarin/your-json-column-is-not-a-settings-system-4b7dc46e747f)): a `setting_definitions` catalog table is the source of truth for *what settings exist*; a polymorphic `(owner_type, owner_id, definition_id)` override table holds only rows where the owner diverged. Resolution order: `request-time override → stored preference → source relation → default`. Key quote: *"Defaults live in code, not in the database. The DB only stores rows when a value differs from the default."*

Shopify implements this declaratively: `config/settings_schema.json` is the catalog with defaults, `settings_data.json` per merchant holds only changes ([writeup, 2026](https://dev.to/sapotacorp/shopify-theme-editor-design-tokens-merchants-can-edit-377i)). Stripe Connect surfaces the same shape externally — account-level defaults with per-customer overrides.

### 2.2 Azure App Configuration — labels as orthogonal dimension

Microsoft's [App Configuration multitenancy guidance](https://learn.microsoft.com/en-us/azure/architecture/guide/multitenant/service/app-configuration) (2025) recommends *keys* (not labels) for the tenant hierarchy — `tenant1/LogLevel`, `tenant2/LogLevel` — leaving labels for orthogonal dimensions (environment, version). [Best practices](https://learn.microsoft.com/en-us/azure/azure-app-configuration/howto-best-practices) explicitly call out **configuration stacking**: load unlabelled defaults, then the labelled overrides; later loads overwrite earlier ones. The service *does not* infer hierarchy — the application owns the merge. Validates our plan to put resolution in the application layer.

### 2.3 AWS — AppConfig + Parameter Store

AWS's [tagged-storage multi-tenant config blog](https://aws.amazon.com/blogs/architecture/build-a-multi-tenant-configuration-system-with-tagged-storage-patterns/) (2024) lays out the **in-memory cache + EventBridge invalidation** pattern we propose in §4: shared params in Parameter Store, tenant overrides in DynamoDB, in-memory cache refreshed by event rather than time-based polling. The reference [`aws-samples/sample-config-management-service`](https://github.com/aws-samples/sample-config-management-service) is worth code-reading before scoping. AppConfig's [templates-and-tenants pattern](https://aws.amazon.com/blogs/devops/deploying-and-managing-application-configurations-using-aws-appconfig/) shows the "catalog + selective overrides" idea expressed as a file tree.

[Parameter Store hierarchies](https://docs.aws.amazon.com/systems-manager/latest/userguide/sysman-paramstore-hierarchies.html) (up to 15 levels) plus `GetParametersByPath --recursive` let consumers grab a whole subtree in one call; the [oneuptime writeup](https://oneuptime.com/blog/post/2026-02-12-parameter-store-hierarchies-paths/view) (Feb 2026) recommends a shared-path + app-path merge with app taking precedence — the same algorithm we propose.

### 2.4 Vercel, Linear, OpenFeature

- **Vercel** environment variables ([docs, 2025](https://vercel.com/docs/environment-variables)) — team-level vars available to all projects, project-level vars override, branch-specific preview vars override branch-agnostic. Real, customer-facing two-layer override at hyperscaler scale. Structurally identical to `tenant → department → user`.
- **Linear** sub-teams ([docs, 2025](https://linear.app/docs/sub-teams)) — *some* settings inherit (cycles, members, estimates), others do not (statuses, views). The lesson: **inheritance is per-key**, not all-or-nothing. Encode it in `SettingDefinition.inheritance` (§3).
- **OpenFeature** evaluation context ([spec, 2025](https://openfeature.dev/specification/sections/evaluation-context/)) — `API → transaction → client → invocation` merge order is the canonical N-tier algorithm in modern SaaS. Adopt the *vocabulary* (targeting key, evaluation context) even if we don't adopt a flag vendor. `mt3o/config-layers` ([GitHub](https://github.com/mt3o/config-layers)) is a small TS implementation worth referencing for resolver test cases.

---

## 3. Target data model

### 3.1 Concrete Prisma sketch

```prisma
enum ValueType {
  String
  Number
  Boolean
  Json
  Url
}

enum SettingType {
  USER_OVERRIDABLE   // tenant admins + users can edit
  ADMIN_LOCKED       // super-admin only
  SYSTEM_INTERNAL    // never shown in UI, read-only at runtime
  SECRET             // encrypted, never logged, never serialized to non-SUPER_ADMIN responses
}

enum InheritanceScope {
  GLOBAL         // catalog default only; no override layer allowed
  TENANT         // catalog → tenant
  DEPARTMENT     // catalog → tenant → department
  USER           // catalog → tenant → department → user
}

model SettingDefinition {
  metaData      Json?            @map("_metadata") @db.JsonB
  version       Int              @default(1) @map("_version")
  id            String           @id @default(uuid(7))

  key           String           @unique
  namespace     String?
  name          String
  description   String?
  dataType      ValueType
  defaultValue  Json?            @db.JsonB
  schema        Json?            @db.JsonB                 // JSON Schema for write-time validation
  settingType   SettingType      @default(USER_OVERRIDABLE)
  inheritance   InheritanceScope @default(TENANT)
  tags          String[]         @default([])

  // audit (no tenantId — this is platform-scoped)
  createdBy     String?
  updatedBy     String?
  createdAt     DateTime         @default(now())
  updatedAt     DateTime         @updatedAt
  resourceStatus           ResourceStatusType @default(ENABLED)
  resourceStatusUpdatedAt  DateTime?
  resourceStatusUpdatedBy  String?

  tenantOverrides     TenantSettingOverride[]
  departmentOverrides DepartmentSettingOverride[]
  userOverrides       UserSettingOverride[]

  @@index([namespace])
  @@schema("core")
}

model TenantSettingOverride {
  metaData      Json?    @map("_metadata") @db.JsonB
  version       Int      @default(1) @map("_version")
  id            String   @id @default(uuid(7))

  tenantId      String
  key           String                                   // FK target = SettingDefinition.key
  value         Json?    @db.JsonB                       // null = "explicit null"; row absent = "inherit"

  // audit
  createdBy     String?
  updatedBy     String?
  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt
  resourceStatus           ResourceStatusType @default(ENABLED)
  resourceStatusUpdatedAt  DateTime?
  resourceStatusUpdatedBy  String?

  tenant     Tenant            @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  definition SettingDefinition @relation(fields: [key],      references: [key], onDelete: Restrict)

  @@unique([tenantId, key])
  @@index([tenantId])
  @@schema("core")
}

model DepartmentSettingOverride { /* same shape, FK departmentId, @@unique([departmentId, key]) */ }
model UserSettingOverride       { /* same shape, FK userId,       @@unique([userId, key]) */ }
```

### 3.2 Schema decisions and rationale

| Decision | Rationale |
|---|---|
| **Three override tables, not one polymorphic** | Cleaner FK + cascade story per scope; simpler composite uniques. Polymorphic (Marin's choice) is fine but trades clarity for one table fewer — not the right trade in HOPE's Prisma codebase. |
| **FK by `key` (string), not `definitionId` (uuid)** | `key` is the stable contract with SDK and admin UI; already used as cache key. String FK is slightly larger but kills a join on every override insert. |
| **`value: Json @db.JsonB` instead of `value: String + dataType`** | Drops the double `stringify`/`parse`, enables GIN indexing, allows write-time schema validation via Ajv/Zod. `dataType` lives on the definition for UI form generation. |
| **`onDelete: Cascade` for tenant/department/user overrides** | Tenant hard-delete (rare) sweeps overrides automatically. Soft-delete uses the existing `resourceStatus` field. |
| **`onDelete: Restrict` from override → definition** | Force operators to handle dangling overrides before deleting a definition. No silent orphans. |
| **No `tenantId` on `SettingDefinition`** | The deliberate killer of `__GLOBAL__`. The catalog is platform-scoped by construction; the sentinel uuid goes away. |
| **`inheritance: InheritanceScope` per key** | A per-key inheritance contract — matches Linear's behaviour. `GLOBAL`-scope keys refuse override writes at the DTO layer; department/user tiers stay opt-in per key. |

### 3.3 What about `SettingDefinitionHistory`?

Yes — add it. Mirror of `PromptVersion` / `ContextItemVersion` in HOPE today. Triggered by a Prisma extension on every `SettingDefinition.update`. The override tables get an analogous `OverrideHistory` so we can answer "what was the effective value for tenant X at timestamp T". This is non-blocking for Phase A but should land in Phase C so SOC2 evidence is continuous.

---

## 4. Resolution algorithm

### 4.1 Pseudocode

```
resolveSetting(key, ctx):
  for layer in [userOverride(ctx.userId, key),
                deptOverride(ctx.departmentId, key),
                tenantOverride(ctx.tenantId, key)]:
    if layer.exists and layer.value !== UNSET_SENTINEL:
      return layer.value
  return settingDefinition(key).defaultValue ?? null
```

### 4.2 TypeScript sketch (intent only — do not merge)

```ts
type ResolveCtx = { tenantId?: string; departmentId?: string; userId?: string };

async resolveSetting<T = unknown>(key: string, ctx: ResolveCtx): Promise<T | null> {
  const cacheKey = cacheKeyFor(key, ctx);
  const hit = await this.cache.get<T>(cacheKey);
  if (hit !== undefined) return hit;

  const def = await this.definitionRepo.findByKey(key);
  if (!def) return null;

  const value =
    (def.inheritance === 'USER'       && ctx.userId       ? await this.userRepo.find(ctx.userId, key)       : null)?.value ??
    (def.inheritance !== 'GLOBAL'     && ctx.departmentId ? await this.deptRepo.find(ctx.departmentId, key) : null)?.value ??
    (def.inheritance !== 'GLOBAL'     && ctx.tenantId     ? await this.tenantRepo.find(ctx.tenantId, key)   : null)?.value ??
    def.defaultValue ?? null;

  await this.cache.set(cacheKey, value, { ttl: 300, tags: [`tenant:${ctx.tenantId}`, `key:${key}`] });
  return value as T;
}
```

### 4.3 Bulk resolution — the hot path

`GET /tenant/me/config` and SDK bootstrap call `resolveAllForTenant(tenantId, [departmentId?], [userId?])`. The naive implementation is one query per layer per key — N+1 territory. The right implementation is **one query that returns the projection**:

```sql
WITH definitions AS (
  SELECT key, "defaultValue", inheritance FROM "core"."SettingDefinition" WHERE "resourceStatus" = 'ENABLED'
)
SELECT
  d.key,
  COALESCE(u.value, dpt.value, t.value, d."defaultValue") AS value,
  CASE WHEN u.value IS NOT NULL THEN 'USER'
       WHEN dpt.value IS NOT NULL THEN 'DEPARTMENT'
       WHEN t.value IS NOT NULL THEN 'TENANT'
       ELSE 'SYSTEM' END AS "effectiveLayer"
FROM definitions d
LEFT JOIN "core"."TenantSettingOverride"     t   ON t.key = d.key  AND t."tenantId"     = $1 AND t."resourceStatus" = 'ENABLED'
LEFT JOIN "core"."DepartmentSettingOverride" dpt ON dpt.key = d.key AND dpt."departmentId" = $2 AND dpt."resourceStatus" = 'ENABLED'
LEFT JOIN "core"."UserSettingOverride"       u   ON u.key = d.key  AND u."userId"       = $3 AND u."resourceStatus" = 'ENABLED'
WHERE d.inheritance != 'GLOBAL' OR (u.value IS NULL AND dpt.value IS NULL AND t.value IS NULL);
```

One query, one cache entry per `(tenantId, departmentId, userId)`. Sub-millisecond p99 once warm.

### 4.4 Cache strategy

- **Process cache**: per-`(tenantId, departmentId, userId)` `Map`, max 10k entries, 5-minute TTL. Stale-while-revalidate.
- **Distributed cache (Redis)**: optional second tier for cold pods. Same key shape. TTL longer (1 hour) because invalidation is reliable.
- **Invalidation**: on every write to a definition or override, publish `config:invalidate:{tenantId}` (or `config:invalidate:*` when the definition itself changes — a single setting catalog change can affect every tenant who has not overridden, so we evict all). Use Postgres `LISTEN/NOTIFY` if we want zero extra infra, Redis Pub/Sub if we keep the existing Redis client (HOPE already uses `ioredis`).

This is exactly the [AWS tagged-storage in-memory pattern](https://aws.amazon.com/blogs/architecture/build-a-multi-tenant-configuration-system-with-tagged-storage-patterns/) — event-driven invalidation replaces the existing 45 s cron entirely (closes TASK-301 P1-3).

### 4.5 Type safety

Generate TypeScript types from `SettingDefinition.schema` at build time via Zod's `z.toJSONSchema()` (Zod v4) or `json-schema-to-typescript`. The resolver returns `T` where `T` is the type registered for `key`. Mismatch is a compile error, not a runtime cast.

### 4.6 Null vs "inherit" semantics — the contract

| Wire shape | Meaning |
|---|---|
| Override row absent | Inherit from the next layer up. |
| Override row present, `value: null` | This layer **explicitly clears** the parent value to null. |
| Override row present, `value: <X>` | This layer overrides with `X`. |
| `PATCH .../overrides/key` with body `{ value: null }` | Caller wants the explicit null. |
| `DELETE .../overrides/key` | Caller wants to revert to inheritance. |

This is the [OpenFeature merge contract](https://openfeature.dev/specification/sections/evaluation-context/) applied to settings. **The DTO must reject `undefined` because the JSON wire cannot distinguish `undefined` from absent**; the caller must use `DELETE` to express "inherit".

---

## 5. Migration steps — phased and reversible

Four phases. Each is independently shippable and rollback-safe.

### Phase A — Additive (1.5 weeks, 1 engineer)

1. Create `SettingDefinition`, `TenantSettingOverride`, `DepartmentSettingOverride`, `UserSettingOverride` tables and their migrations.
2. Backfill `SettingDefinition` from current `__GLOBAL__` rows (§6).
3. Backfill `TenantSettingOverride` from rows where the tenant value diverges from the `__GLOBAL__` value (§6).
4. Add a **dual-write path** in `TenantService.updateTenantConfigs`: every write goes to both old `GlobalSetting` and new `TenantSettingOverride`. Same for `GlobalSettingService` writes → `SettingDefinition`.
5. Add a structured-log diff job (one query per hour): for each `(tenantId, key)`, compare the value resolved from the new model with the value resolved from the old model. Alert on any mismatch.

**Rollback**: drop the new tables. Application unaffected (still reads from old path).

**Verification**: zero mismatches in the diff job for ≥ 48 h before Phase B.

### Phase B — Read-flip (2 weeks)

1. Switch `appSettingsService.getValueFromCache` to call the new resolver.
2. Switch `TenantService.fetchTenantConfigs` to project from the new model.
3. Keep dual-write on the *write* side. Dual-read goes away.
4. SDK and admin UI remain unchanged (the API contract has not changed; see §7).

**Rollback**: feature-flag the read path. Flipping back is one config change; the dual-write means the old table is still authoritative shape-wise.

**Verification**: error rate on `/tenant/me/config` unchanged; cache hit rate on the new resolver ≥ 99 %.

### Phase C — Cleanup (1 week)

1. Remove dual-write. Writes flow only to the new tables.
2. Mark `GlobalSetting` table read-only at the application layer.
3. After two weeks of clean operation, drop the `GlobalSetting` table in a separate migration. **Requires explicit confirmation per the user's data-safety rule.**
4. Delete the `__GLOBAL__` sentinel tenant. (After Phase C ends, no code references it.)

**Rollback**: rolling back this phase is destructive — we no longer dual-write. Don't enter Phase C until Phase B has been stable for 30 days.

### Phase D — Optional, when business pulls it (1–3 weeks each)

- `DepartmentSettingOverride` admin UI and SDK plumbing.
- `UserSettingOverride` admin UI and SDK plumbing.
- `SettingDefinitionHistory` / override audit tables.
- Envelope-encrypted `SECRET`-type values (closes TASK-301 P0-7).

---

## 6. Data migration SQL (sketch — not production)

```sql
-- 1. Backfill the catalog from the __GLOBAL__ rows.
INSERT INTO "core"."SettingDefinition"
  (id, key, namespace, name, description, "dataType", "defaultValue", "settingType", "inheritance", "createdBy", "createdAt")
SELECT
  gen_random_uuid(),
  gs.key,
  gs.namespace,
  gs.name,
  gs.description,
  gs."dataType"::text::"ValueType",
  CASE
    WHEN gs."dataType" = 'Json' THEN gs."defaultValue"::jsonb
    ELSE to_jsonb(gs."defaultValue")
  END,
  CASE WHEN gs.locked THEN 'ADMIN_LOCKED'::"SettingType" ELSE 'USER_OVERRIDABLE'::"SettingType" END,
  'TENANT'::"InheritanceScope",
  gs."createdBy",
  gs."createdAt"
FROM "core"."GlobalSetting" gs
WHERE gs."tenantId" = '50000000-0000-0000-0000-000000000000'
  AND gs."resourceStatus" = 'ENABLED'
ON CONFLICT (key) DO NOTHING;

-- 2. Backfill tenant overrides ONLY where the tenant value diverges from the default.
INSERT INTO "core"."TenantSettingOverride"
  (id, "tenantId", key, value, "createdBy", "createdAt", "updatedAt")
SELECT
  gen_random_uuid(),
  gs."tenantId",
  gs.key,
  CASE
    WHEN gs."dataType" = 'Json' THEN gs."value"::jsonb
    ELSE to_jsonb(gs."value")
  END,
  gs."createdBy",
  gs."createdAt",
  gs."updatedAt"
FROM "core"."GlobalSetting" gs
WHERE gs."tenantId" != '50000000-0000-0000-0000-000000000000'
  AND gs."resourceStatus" = 'ENABLED'
  AND gs.value IS DISTINCT FROM gs."defaultValue"
ON CONFLICT ("tenantId", key) DO NOTHING;
```

Note: this is intentionally `ON CONFLICT DO NOTHING` so the migration is idempotent and safe to re-run during Phase A drift recovery. Production version must add CHECK constraints on `value` shape vs `dataType`.

---

## 7. API and contract changes

### 7.1 `GET /tenant/me/config` response

Should not change shape. The backend can still return:

```json
{ "data": [ { "key": "default-stt-model", "value": "whisper-large-v3", "locked": false, ... } ] }
```

…by projecting the resolved layer at response time. The SDK keeps its current parser. The only addition is an optional `effectiveLayer: "SYSTEM" | "TENANT" | "DEPARTMENT" | "USER"` field so the admin UI can render *"this is a default"* vs *"your tenant has customised this"* badges.

### 7.2 `PATCH /tenant/me/config` — semantics tightening

| Wire | Meaning under layered model |
|---|---|
| `[{ key, value }]` | Upsert `TenantSettingOverride` row. |
| `[{ key, value: null }]` | Explicit null (overrides parent with null). |
| New endpoint: `DELETE /tenant/me/config/:key` | Remove the override → revert to inheritance. |

This is mostly additive. The `DELETE` endpoint is the only new surface and lands cleanly behind the existing CASL `@CanManage('Tenant')` guard.

### 7.3 SDK `ConfigManager` alignment

The SDK already has the 4-tier `SYSTEM_DEFAULTS → tenant → department → user` resolver (TASK-297 DEF-C5). Today the backend hides this from it — every setting comes back as a single tenant blob. With the new model the backend can finally return **per-layer projections** so the SDK can render which tier is contributing each value. The `useGlobalSettings` SDK hook (dormant per TASK-301 P1-1) can be retired entirely in favour of `useTenantSettings` + `useDepartmentSettings` + `useUserSettings`, each backed by an override table.

---

## 8. Risks and open questions

| Concern | Note / action |
|---|---|
| **Read performance** | Bulk resolver is one query; per-key reads forbidden in tight loops. Benchmark goal: p99 < 1 ms warm, < 5 ms cold, at 100 concurrent tenants × 40 keys. |
| **Audit lineage** | Definition changes in `SettingDefinitionHistory`, override changes in `OverrideHistory`. "Who set X for tenant Y at T" → join `OverrideHistory` on `updatedBy`. |
| **Department-level config — does HOPE have it today?** | No `DepartmentSetting` table exists. SDK has the Tier 2 hook (TASK-297) but the backend doesn't feed it. **Defer the department table to Phase D**; ship A/B/C with catalog + tenant only. |
| **Soft delete on overrides** | Use existing `resourceStatus`; resolver filters `ENABLED`. Restore = status update, not a new row. |
| **Cross-tenant leak during migration** | Phase A/B writes use `where: { tenantId }` even in the diff job. Add a property-based test that randomises tenant ids and asserts the resolver never returns another tenant's value. |
| **Default change scope** | An update to `SettingDefinition.defaultValue` reaches every tenant that has not overridden. Build an admin tool: "show me every tenant affected by this default change" before flipping a default in production. |
| **Secrets (TASK-301 P0-7)** | This migration does **not** encrypt secrets. The `SECRET` enum reserves the seat; schedule envelope encryption in parallel (Phase D) or post-migration. |
| **Tooling consistency** | Override + history write is multi-entity → must use `CoreUnitOfWorkService` per `.cursor/rules/04-application-services.mdc`. Schema follows the model-template rule (meta → tenant → core → audit → status → tags → indexes). |

---

## 9. Effort estimate

| Phase | Sequential effort | Parallelisable? | Notes |
|---|---|---|---|
| Phase A — additive | 1.5 weeks | Schema migration + service stubs can be parallel; backfill SQL must follow. | Backfill SQL is the single longest deliverable. |
| Phase B — read-flip | 2 weeks | Read-path refactor can run in parallel with admin UI `effectiveLayer` updates. | Largest blast radius — review carefully. |
| Phase C — cleanup | 1 week | Mostly serial. | Final table drop requires explicit user approval per data-safety rule. |
| Phase D — extensions | 1–3 weeks each | Each extension is independent. | Schedule as business pulls each one. |

**Total dev effort for Phases A–C**: **~4.5 weeks single engineer**, **~3 weeks with two engineers** sharing the read-path and backfill work. Add ~30 % buffer for testing, code review, and dual-read soak time. Realistic calendar: **6–8 weeks elapsed** including bake-in.

Items that *cannot* be parallelised:

- Phase A backfill → Phase B read-flip (need verified dual-write correctness before flipping reads).
- Phase B soak (30 d) → Phase C cleanup (cannot drop the old table on day 1 of read-flip).

Items that *can* be parallelised:

- New tables + factories + mappers (Phase A) || backfill SQL design.
- Read-path refactor (Phase B) || `effectiveLayer` admin UI badges.
- Phase D extensions (envelope encryption, department tier, user tier, history tables) all independent.

---

## 10. Knowledge cross-references

**External sources** (year-tagged, sorted by relevance):

- Marin, *"Your JSON Column Is Not a Settings System"* — [Medium, Mar 2026](https://medium.com/@igmarin/your-json-column-is-not-a-settings-system-4b7dc46e747f). Direct prior art for the catalog + override pattern.
- Microsoft, *App Configuration multitenancy* — [Architecture Center, 2025](https://learn.microsoft.com/en-us/azure/architecture/guide/multitenant/service/app-configuration); *best practices* — [Microsoft Learn, 2025](https://learn.microsoft.com/en-us/azure/azure-app-configuration/howto-best-practices).
- AWS, *Multi-tenant config with tagged storage* — [AWS Architecture Blog, 2024](https://aws.amazon.com/blogs/architecture/build-a-multi-tenant-configuration-system-with-tagged-storage-patterns/); [`aws-samples/sample-config-management-service`](https://github.com/aws-samples/sample-config-management-service); [AppConfig DevOps blog](https://aws.amazon.com/blogs/devops/deploying-and-managing-application-configurations-using-aws-appconfig/); [Parameter Store hierarchies](https://docs.aws.amazon.com/systems-manager/latest/userguide/sysman-paramstore-hierarchies.html); [oneuptime path-merge writeup, 2026](https://oneuptime.com/blog/post/2026-02-12-parameter-store-hierarchies-paths/view).
- Vercel, *Environment variables* — [Vercel docs, 2025](https://vercel.com/docs/environment-variables).
- Linear, *Sub-teams* — [Linear docs, 2025](https://linear.app/docs/sub-teams).
- OpenFeature, *Evaluation Context* — [spec, 2025](https://openfeature.dev/specification/sections/evaluation-context/).
- Shopify theme editor — [dev.to, 2026](https://dev.to/sapotacorp/shopify-theme-editor-design-tokens-merchants-can-edit-377i).
- Prisma + Postgres RLS — [Labuschagne, Medium, 2025](https://medium.com/@francolabuschagne90/securing-multi-tenant-applications-using-row-level-security-in-postgresql-with-prisma-orm-4237f4d4bd35).
- [`mt3o/config-layers`](https://github.com/mt3o/config-layers) — TS layered-config reference implementation.

**Internal cross-references** (HOPE repo):

- `docs/implementation/TASK-301-System-Config-Multi-Tenancy-Assessment/README.md` — the audit that motivated this plan; all P0/P1 findings flagged in §1 and §8 trace back here.
- `docs/implementation/TASK-258-*` (Tenant Config Provisioning) — predecessor; the clone-on-create implementation that this plan retires.
- `docs/implementation/TASK-297-*` (SDK 4-tier ConfigManager) — predecessor; the *client* side already has the model the backend is migrating to.
- `packages/database/src/prisma/db_main/globalSetting.prisma` — current schema.
- `packages/applications/src/services/tenant/tenant.service.ts` (`provisionTenantConfigs`, `updateTenantConfigs`) — current write surface.
- `packages/applications/src/services/baseServices/_meta/appSettings/appSettings.service.ts` — current cache; replace with per-tenant cache + event-driven invalidation in Phase B.
- `packages/agentic-sdk-v2/src/core/ConfigManager.ts` — SDK resolver; will gain `effectiveLayer` awareness in Phase B.
- `.cursor/rules/02-database-prisma.mdc` — model-template rule, followed by the schema sketch in §3.
- `.cursor/rules/04-application-services.mdc` — service rule; mandates `CoreUnitOfWorkService` for multi-entity writes.

---

## Change history

- **2026-05-24** — Initial draft authored under the researcher subagent at the parent orchestrator's request. Document is planning-only; no source code modified. To be reviewed alongside TASK-301 before scheduling.
