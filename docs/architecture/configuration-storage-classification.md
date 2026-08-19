# Configuration Storage Classification — where an admin-controllable variable lives

|                   |                                                                                                                                            |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| **Owner**         | Platform Engineering                                                                                                                       |
| **Introduced**    | 2026-08-19                                                                                                                                 |
| **Last verified** | 2026-08-19, against `packages/applications/src/services/settings-registry/**` and `packages/applications/src/services/baseServices/_meta/` |

The normative answer to one question: **given a variable an administrator can change, where does it live, who may edit it, and what happens when nothing supplies a value?**

This document is the framework. The _model/inference_ side of the same control plane — which model runs a task, where its provider lives, how long weights stay resident — is [model-and-config-plane.md](./model-and-config-plane.md). The seven-tier operational view (what belongs in env at all, config caches, `failMode`) is `.claude/rules/09-infrastructure-devops.md` §Configuration Tiers. The per-variable env reference is [environment-configuration-reference.md](./environment-configuration-reference.md).

> **Source of truth.** Every rule below is derived from the code cited beside it — the settings registry, the write service, the secret-field helpers and the AppSettings cache. It cites no implementation tickets: if the code changes, this document is wrong and the code is right.

---

## 1. The normative rule

> **The database is the control plane. Vault is the crypto substrate — never the control plane.**

Everything follows from that split:

- **Admin-editable non-secrets go in Postgres.** Postgres has optimistic concurrency, an audit trail, cascade/scope semantics, and a UI that can render them. Vault has none of those. A settings value in Vault is a value nobody can review, diff, or roll back.
- **Secrets go in Vault** — shared platform secrets natively in kv-v2; per-tenant admin-set secrets as **Vault-Transit ciphertext stored in a DB column**, never plaintext, and never as a kv-v2 path per tenant.
- **Env is the bootstrap floor only** — what a process needs to reach the database or authenticate to Vault. Anything that must change without a restart is not an env var.

## 2. The six data classes and their storage tiers

`StorageTier` (`settings-registry/registry.types.ts`) is the enum that encodes this classification in code. Seven tier values cover six data classes — class 4 has two physical homes.

| #   | Data class                     | Tier value                 | Physical home                                                                  | Encryption    | Who edits                                      |
| --- | ------------------------------ | -------------------------- | ------------------------------------------------------------------------------ | ------------- | ---------------------------------------------- |
| 1   | Platform infra secret (shared) | `vault-kv`                 | Vault kv-v2, at `<VAULT_KV_MOUNT>/data/<VAULT_KV_PREFIX>/<NAME>`               | Vault-native  | operator / IaC only — no admin UI              |
| 2   | Tenant BYO secret              | `db-secret`                | DB column holding Vault-Transit ciphertext (`encrypted* Bytes` + `keyVersion`) | Vault Transit | tenant admin + super admin                     |
| 3   | Cascading behavioural config   | `db-config`                | dedicated table + `ConfigResolver` cascade + OCC                               | none          | tiered by `maxScope`                           |
| 4   | Global KV / kill-switch        | `global-kv` · `redis-flag` | `GlobalSetting` + the AppSettings cache · Redis for instant fan-out            | optional      | super admin                                    |
| 5   | Plan capability / quota        | `entitlement`              | entitlements matrix (`PlanEntitlement` / `TenantEntitlement`)                  | none          | super admin                                    |
| 6   | Deploy/runtime env             | `env`                      | env file or host env → `turbo.json#globalEnv` → `IConfigService`               | none          | operator only (`editableBy: EDITABLE_BY_NONE`) |

For `env` and `vault-kv` descriptors, the variable NAME is mechanical, never hand-copied: `toEnvVarName()` maps the dotted key to SCREAMING_SNAKE (`storage.minio.endpoint` → `STORAGE_MINIO_ENDPOINT`), and for `vault-kv` that same name is the Vault secret name `SecretsService.getSecret` is keyed by. `global-kv` / `db-config` keys are DB-addressed and exempt (several predate the convention).

**Classification does not migrate anything.** `tier` is always the honest present-tense answer — where the value lives _today_. A key still read from `process.env` is `tier: 'env'` even when its intended home is `global-kv`; the destination is recorded in the optional `targetTier` field so a pending migration is queryable rather than buried in prose.

## 3. The descriptor — metadata, never the value

`SettingDescriptor` (`registry.types.ts`) is pure policy metadata. It does not hold the value; it declares where the value lives, who may edit it, how deep the scope may go, and what absence means.

| Field         | Meaning                                                                                                    |
| ------------- | ---------------------------------------------------------------------------------------------------------- |
| `key`         | canonical dotted key (`pipeline.autoSummaryEnabled`)                                                       |
| `tier`        | the data class above · `targetTier` records an intended future home                                        |
| `dataType`    | `boolean · number · string · string[] · enum · json · secret`                                              |
| `sensitivity` | `public · internal · secret`                                                                               |
| `maxScope`    | deepest scope a tenant admin may set it at, over `system < tenant < department < doctor` (`SCOPE_DEPTH`)   |
| `editableBy`  | the CASL subject that gates edits; `EDITABLE_BY_NONE` for `env`                                            |
| `globalOnly`  | super-admin-only surface (platform defaults, plan matrix, platform kill-switches)                          |
| `category`    | server-side taxonomy bucket — replaces client-side keyword guessing                                        |
| `killSwitch`  | marks an enforcing kill-switch                                                                             |
| `failMode`    | **required** — see below                                                                                   |
| `default`     | the code default, last fallback in the cascade · `sampleValue` is generator-only and never read at runtime |

Feature modules contribute descriptor arrays under `settings-registry/descriptors/` (pipeline, storage, tts, model defaults, guardrail policy, harness loop, metering, entitlements, service runtime, platform secrets, feature flags, …); `registry.ts` assembles them once at module load into `HOPE_SETTINGS_REGISTRY`. **Registering a descriptor is the only step needed to make a key governed and writable** — there is no per-key allow-list anywhere.

### `failMode` is declared, never decided at the call site

- **`closed`** — throw; never substitute a default. Mandatory for secrets and for provider/model **selection**, so an unresolved selection can never silently become a global (or another tenant's) value.
- **`open-to-default`** — fall back to `descriptor.default`. Correct for tuning knobs and feature flags, where a missing row should degrade to today's behaviour rather than an outage.

There is deliberately **no default value** for this field: defaulting to `open-to-default` would make every new secret fail open unless its author remembered to opt in; defaulting to `closed` would turn every forgotten tuning knob into an outage. Both mistakes are silent, so the author must state the intent.

**Scope:** `failMode` governs an **absent value** only. A backend or transport error is not a failure mode — it propagates unchanged, so a fail-open knob can never disguise an unreachable control plane as "the default". Bounded staleness and negative caching on backend errors are read-path concerns, handled separately.

## 4. Invariants the registry enforces mechanically

These fail at **assembly time** (module load) or in a governance test, not in review:

1. **Duplicate key** → `register` throws, so assembly fails loudly rather than silently shadowing.
2. **A `secret` descriptor must be `failMode: 'closed'`** → throws at assembly. A secret that falls back to a default silently substitutes the wrong credential.
3. **A `secret` descriptor must not declare `sampleValue`** → throws. A sample value is exactly what a secret must never carry.
4. **An enforcing kill-switch must default OFF.** `SettingsRegistry.killSwitches()` throws at call time if any `killSwitch: true` descriptor defaults truthy; a governance test calls it, so an accidental default-ON flip fails CI. Fail-safe rollout is the rule — a kill-switch that ships ON is enforcement nobody opted into.
5. **`assertWithinMaxScope`** raises `ArgumentInvalidException` (→ 400) when a write targets a scope deeper than the descriptor's `maxScope`.

The governance suite lives in `settings-registry/__tests__/` (`settings-registry.test.ts`, `fail-mode.governance.test.ts`, `tenant-clamp.test.ts`, `scope-cascade.test.ts`, the seed-parity and per-descriptor tests).

## 5. The write lane

`SettingsRegistryWriteService` (`settings-registry/settings-registry-write.service.ts`) is the single enforcement point for `global-kv` keys. Its guards run in order, and the order is the contract:

| #   | Guard                                                | Outcome                                                                                                                         |
| --- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| 1   | unknown key                                          | `ArgumentInvalidException` → **400**                                                                                            |
| 2   | `sensitivity === 'secret'`                           | **400** — secrets never traverse this lane                                                                                      |
| 3   | `globalOnly && !isSuperAdmin`                        | **403** — a privilege boundary, not the 404-over-403 cross-tenant posture (the caller can already READ the key via the catalog) |
| 4   | `assertWithinMaxScope(key, scope)`                   | **400** when the requested scope is deeper than `maxScope`                                                                      |
| 5   | `tier !== 'global-kv'`                               | **400** — dedicated services still own `db-config` / `db-secret` keys                                                           |
| 6   | `system` scope by a non-super-admin                  | **403** — a system-scope write changes the value platform-wide                                                                  |
| 7   | serialize by `dataType`, then compare-and-set upsert | writes the backing `GlobalSetting` row under the reserved `registry` namespace, then `appSettings.refreshCache()`               |

The write is `If-Match`-gated end to end: an existing row written with no `expectedVersion` → **428**; a version mismatch → **412**. The assembled catalog is served RBAC-filtered at `GET /api/v1/admin/settings/catalog`.

## 6. Anti-patterns (review-enforced)

| Anti-pattern                               | Why it is wrong                           | Do instead                                                                       |
| ------------------------------------------ | ----------------------------------------- | -------------------------------------------------------------------------------- |
| Admin-editable non-secret in Vault         | no OCC, no audit, no cascade, no UI       | `db-config` or `global-kv`                                                       |
| Secret as a plaintext DB column            | a database dump is a credential dump      | Vault-Transit ciphertext; **reject the write** when `SECRETS_PROVIDER ≠ vault`   |
| A secret echoed in a read DTO              | write-only is the only safe shape         | write-only DTO + masked read (`hasKey`); reveal only behind step-up auth + audit |
| A config write with no OCC or no SysEvent  | silent last-writer-wins; nothing to audit | `If-Match` → 428/412, and `broadcastSysEvent` on every mutation                  |
| An enforcing kill-switch defaulting ON     | enforcement nobody opted into             | default OFF (assembly-enforced, §4.4)                                            |
| A "default tenant" fallback in a resolver  | serves one customer's config to everyone  | resolve request tenant → SYSTEM, two tiers only                                  |
| A config cache keyed by setting name alone | serves one tenant's value to another      | include `tenantId` in the cache key                                              |

On that last pair: the runtime cascade is exactly **request tenant → SYSTEM**. The "Global" tenant (`50000000-…`) is a _customer_ tenant used as a platform-admin playground, never a resolution tier. `AppSettingsService`'s name-only cache key is sound _only_ because it admits platform-reserved tenants exclusively — do not widen that filter.

## 7. Reusable primitives

| Primitive                                                                         | Path                                              | Purpose                                                                                                                                                               |
| --------------------------------------------------------------------------------- | ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `encryptSecretField` / `decryptSecretField` / `parseKeyVersionFromCiphertext`     | `baseServices/_meta/secrets/secret-field.util.ts` | the one audited Vault-Transit path for every class-2 field. Ciphertext is `vault:vN:<base64>`; a malformed shape falls back to key version 1 rather than yielding NaN |
| `HOPE_SETTINGS_REGISTRY`, `assertWithinMaxScope`, `walkCascade`                   | `services/settings-registry/`                     | the typed catalog, the uniform scope clamp, the cascade primitive                                                                                                     |
| `resolveScopedTenantId` / `resolveScopedTenantIdOptional` / `assertTenantInScope` | `apps/api/src/shared/tenant-scope.ts`             | the one home for cross-tenant admin resolution (super-admin `?tenantId=`; tenant-bound callers pinned; 404-over-403)                                                  |

⚠️ `parseKeyVersionFromCiphertext` has a **deliberate byte-identical twin** in the domains layer (`packages/domains/src/repositories/generated/core/GlobalSettingRepository.encryption.ts`). Domains cannot import applications without creating a package cycle, so the duplication is intentional — a change to either must be made in both.

## 8. Global-KV convergence contract

Every `GlobalSetting` write broadcasts `SysEventType.ResourceUpdated`. Three layers converge readers, cheapest first (`baseServices/_meta/appSettings/appSettings.service.ts`):

1. **Same-instance, in-process** — an `@OnEvent` handler filtered to `ResourceType.GlobalSetting` calls `refreshCache()` immediately (~ms). `@nestjs/event-emitter` is in-process only, so this converges just the writing instance.
2. **Cross-instance, Redis pub/sub** — after that refresh succeeds, the handler publishes `{ instanceId }` on `app-settings:invalidate`; every instance subscribes on `onModuleInit` through a dedicated subscriber connection and refreshes on receipt. A self-published message is a no-op.
3. **Cron backstop** — the `updateCacheAppSettings` cron (`45 * * * * *`, worst case ~60 s) covers a writer that never broadcast (direct-Prisma writers) and any deployment without Redis.

Both publish and subscribe degrade to a no-op + WARN rather than throwing when Redis is unavailable — the module still boots, it just converges at cron speed. **Invalidation is the propagation mechanism; TTL is a bounded-staleness safety net, not the design.** `SecretsService` has its own equivalent channel for rotations.

---

## Related

- [model-and-config-plane.md](./model-and-config-plane.md) — model selection, provider/BYO credentials, runtime profiles, retention
- [environment-configuration-reference.md](./environment-configuration-reference.md) — the per-variable env reference
- [data-and-domain-model.md](./data-and-domain-model.md) — the persisted models behind these tiers
- [../development-patterns-and-standards.md](../development-patterns-and-standards.md) §1.8, §6.10 — the code-level patterns
- `.claude/rules/09-infrastructure-devops.md` §Configuration Tiers — the operational rules, incl. tenant-first resolution and BYO
