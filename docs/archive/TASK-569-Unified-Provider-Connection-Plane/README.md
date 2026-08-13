# TASK-569 — Unified Provider-Connection Plane (Foundation)

- **Status**: Review
- **Type**: refactor / feature (foundation)
- **Program**: [Unified Provider-Connection Plane](../SOTA-Track/2026-07-28-unified-provider-plane-program.md) — Wave 0, the foundation every adoption lane builds on
- **Branch of record**: `thuynh/2607`
- **Size**: L · **Wave**: 0 (must merge before Wave-1 lanes rebase)
- **Blocks**: TASK-570, TASK-571, TASK-572 (they consume contracts C1–C5 this ticket freezes)
- **Depends on**: nothing

> **Read the [program doc](../SOTA-Track/2026-07-28-unified-provider-plane-program.md) first.** It holds the frozen contracts (§4 C1–C5), the invariants (§5), and the file-ownership matrix (§6). This ticket **owns and publishes** those contracts; do not diverge from them without updating the program doc and notifying every downstream lane.

## Agent execution

| Phase | Tier | Goal |
|---|---|---|
| Discovery | **claude-sonnet-5-low** | Re-verify §"Current State" file:line anchors against live HEAD; confirm the exact current column list of `AiProviderConnection`, the current `IAiProviderConnectionService` signatures, and every current call-site of the service (should be only `smr-proxy.controller.ts:237`). Produce a delta note if anything drifted from this README. **Do not edit code.** |
| Implementation | **claude-opus-4-8-high** | Execute the plan below. This lane alters a table three shipped features read and migrates live credential rows — highest reasoning + adversarial self-review required. |
| Review/close | **claude-sonnet-5-xhigh** | Verify every gate in §Verification produced real green output; run the program regression gate (all LLM/TTS/STT BYOK suites); confirm the migration is additive and reversible; sign off contracts C1–C5 as published. |

**Ownership (exclusive — see program §6):** `packages/database/src/prisma/db_main/ai-provider-connection.prisma` + its new migration; `packages/domains/src/*/generated/core/AiProviderConnection*`; `packages/applications/src/services/ai-provider-connection/**`. **Do NOT touch** any gateway controller, any `tenant-*-config` service, or any console file — those belong to TASK-570/571/572.

---

## 1. Requirement Analysis

Unify the three separate BYO credential stores (LLM `AiProviderConnection`; STT `TenantSttProviderCredential`; TTS `TenantTtsProviderCredential`) into **one** provider-connection plane keyed by `(tenantId, service, provider)`, so a tenant admin's key for a provider is stored once, in one governed, Vault-encrypted, masked-read table, regardless of capability — **without changing what the Python services receive** (wire shape frozen, C4) and **without regressing** any shipped BYOK behavior.

Verifiable outcomes:
1. `AiProviderConnection` carries a `service` discriminator (`llm|stt|tts`), unique on `(tenantId, service, provider)`; all existing rows are backfilled `service='llm'` losslessly.
2. Live rows from `TenantTtsProviderCredential` and `TenantSttProviderCredential` are **copied** (not moved) into `AiProviderConnection` with the correct `service`, preserving ciphertext + `keyVersion` + `enabled` + endpoint/region.
3. `IProviderConnectionService` exposes the service-first C2 interface; `resolveConnection` / `resolveTenantCloudOverrides` take `service` first; `CLOUD_BYO_PROVIDERS` is the per-service C5 map.
4. Every existing LLM BYOK unit + e2e stays green (this ticket does not repoint the LLM gateway — TASK-572 does — but must keep the service usable by the current `smr-proxy` call until then; see §3.5).
5. Contracts C1–C5 are published and frozen for the downstream lanes.

Out of scope (explicitly): repointing TTS/STT/LLM gateways or services (TASK-570/571/572); dropping the legacy tables (TASK-576); the new LLM provider adapters (TASK-572); any console change.

## 2. Current State Evaluation (code-verified 2026-07-28, `thuynh/2607`)

- `AiProviderConnection` model: `packages/database/src/prisma/db_main/ai-provider-connection.prisma` — `@@unique([tenantId, provider], name: "AiProviderConnection_tenant_provider_unique")`, `@@index([tenantId])`, `@@index([provider])`. Columns: `metaData, version, id, tenantId, provider, baseUrl, region, apiVersion, deploymentName, encryptedApiKey, keyVersion, enabled, extraJson`, + status/audit.
- Allow-lists: `'AiProviderConnection'` in both `TENANT_SCOPED_MODELS` and `SYSTEM_SHARED_READ_MODELS` (`packages/database/src/extensions/tenant-scope.ts`). Soft-delete: NOT in `MODELS_WITHOUT_SOFT_DELETE` (it soft-deletes; asserted by `seed/__tests__/config-plane-seed.test.ts`).
- Seed: `packages/database/src/prisma/db_main/seed/17-ai-provider-connection.ts` — 8 SYSTEM rows (`ollama, lm-studio, azure, bedrock, built-in, sarvam, vllm, llama-cpp`), all `enabled:false`, no key. A compile-time `_providerCoverage` assertion forces one row per `AI_MODEL_PROVIDERS`.
- Service: `packages/applications/src/services/ai-provider-connection/` — `constants.ts:19 CLOUD_BYO_PROVIDERS=['azure','bedrock']`; `ai-provider-connection.service.ts` (`resolveConnection`, `resolveTenantCloudOverrides`, CRUD+OCC, `assertWriteAllowed`); `IAiProviderConnectionService.ts`; `dto/`.
- **Only external call-site** of the resolver: `apps/api/src/modules/streaming/smr-proxy.controller.ts:237` → `resolveTenantCloudOverrides(tenantId)`. (Discovery must re-confirm no others appeared.)
- Legacy credential tables to migrate in: `TenantTtsProviderCredential` (`tenant-tts-config.prisma:62`, `provider ∈ azure|sarvam`, `endpoint`) and `TenantSttProviderCredential` (`tenant-stt-config.prisma:62`, `provider ∈ azure-speech|sarvam|openai`). Both are `(tenantId, provider)` unique with `encryptedApiKey Bytes? / keyVersion / enabled`.

## 3. Implementation Plan (TDD: RED → GREEN → REFACTOR)

Follow the layer order Database → Domain → Application. Write the failing test first at each step.

### 3.1 Database (schema + migration)
1. Edit `ai-provider-connection.prisma`: add `service String @default("llm")`; change `@@unique` → `([tenantId, service, provider], name: "AiProviderConnection_tenant_service_provider_unique")`; change `@@index([tenantId])` → `@@index([tenantId, service])`; add `@@index([service, provider])`. Update the header comment to describe the discriminator.
2. `pnpm db:migrate:create` → name `task_569_provider_connection_service_discriminator`. Review every statement. The migration must:
   - `ALTER TABLE ... ADD COLUMN "service" text NOT NULL DEFAULT 'llm';` (backfills existing LLM rows — R5).
   - Drop the old unique, add the new `(tenantId, service, provider)` unique; rebuild indexes.
   - **Data-migrate (copy, not move)** every `TenantTtsProviderCredential` row → `AiProviderConnection` with `service='tts'` and every `TenantSttProviderCredential` row → `service='stt'`, mapping `endpoint`→`baseUrl`, preserving `encryptedApiKey, keyVersion, enabled, tenantId, resourceStatus`, generating fresh `id` (uuid7) and `_version=1`. Use `INSERT ... SELECT ... ON CONFLICT DO NOTHING` so re-runs are idempotent and an already-present SYSTEM/tenant row is never clobbered.
   - Leave `TenantTtsProviderCredential` / `TenantSttProviderCredential` tables intact (TASK-576 drops them).
3. Update `seed/17-ai-provider-connection.ts`: every seeded row sets `service:'llm'`; extend the `_providerCoverage` assertion to `(service, provider)` and add SYSTEM rows for the new STT/TTS services **only for cloud providers** (so the resolver has SYSTEM catalog entries): `('stt','azure-speech'|'sarvam'|'openai')`, `('tts','azure'|'sarvam')`, plus the three new `('llm','openai'|'anthropic'|'vertex')` catalog rows (all `enabled:false`, no key). Update `config-plane-seed.test.ts` counts.
4. `pnpm db:migrate` (dev) → `pnpm db:generate`.

### 3.2 Domain
5. Update `AiProviderConnectionEntity`/`Model`/`Factory` to include `service` (hand-edit; the mapper keeps `FIELDS_NOT_WRITABLE=['version']` — **never run `pnpm gen:mapper`**). Repository helpers become service-aware: `findByTenantServiceProvider(service, provider, tenantId, tx?)`, `findByTenantIdAndService(service, tenantId, tx?)` (keep the old names as thin deprecated wrappers defaulting `service='llm'` for one release so nothing breaks mid-migration).
6. `pnpm gen:entity` + `pnpm gen:factory` (`:check`) to reconcile barrels + prove schema coverage (must report "no drift" + "schema coverage OK").

### 3.3 Application service (publishes C2/C5)
7. Rename the token/interface `IAiProviderConnectionService` → `IProviderConnectionService` (export the old symbol as a `@deprecated` alias). Add `type ProviderService = 'llm'|'stt'|'tts'`.
8. Make every method `service`-first per C2. `constants.ts`: `CLOUD_BYO_PROVIDERS` → the C5 per-service map; `isCloudByoProvider(service, provider)`.
9. `resolveConnection(service, provider, tenantId)` + `resolveTenantCloudOverrides(service, tenantId)` filter by `service`; cascade tenant→SYSTEM→null unchanged; per-credential fail-open warn now includes `service`.
10. `assertWriteAllowed(service, provider, tenantId, isSuperAdmin)` uses the per-service allow-list.
11. DTOs: add `service` to the response + a `service` path/param on requests (validated `@IsIn(['llm','stt','tts'])`).

### 3.4 TDD test list (write first, watch RED)
- `service` column persists + round-trips; unique `(tenantId, service, provider)` allows `(llm,azure)` and `(stt,azure)` to coexist, rejects a duplicate triple.
- Backfill: a pre-existing LLM row reads back `service='llm'`.
- Data-migrate: a seeded `TenantTtsProviderCredential(azure)` and `TenantSttProviderCredential(sarvam)` appear as `AiProviderConnection(tts,azure)` / `(stt,sarvam)` with identical ciphertext/keyVersion/enabled; re-running the migration inserts no duplicates.
- `resolveTenantCloudOverrides('llm', t)` returns only `llm` rows; `('stt', t)` only `stt` rows.
- `assertWriteAllowed('stt','azure-speech',...)` allowed; `('stt','ollama',...)` → 403; SYSTEM write w/o superadmin → 403.
- Masked DTO never contains `encryptedApiKey`; carries `service` + `hasKey`.
- **Regression**: the existing LLM service tests (`ai-provider-connection.service.test.ts`, `ai-provider-connection.tenant-lane.test.ts`) pass unchanged after the signature migration (update call-sites in-test to pass `service='llm'`).

### 3.5 Keep LLM live during the transition
Do **not** edit `smr-proxy.controller.ts` (owned by TASK-572). To keep it compiling+working until 572 lands, retain a **1-arg deprecated overload** `resolveTenantCloudOverrides(tenantId)` that delegates to `resolveTenantCloudOverrides('llm', tenantId)`. TASK-572 removes the overload when it repoints the call-site. Note this shim explicitly in the code comment + Change History.

## 4. Verification (paste actual output into the Implementation Summary)
- `pnpm --filter @arcaai/database test` · migration SQL reviewed · `generate-data-model-check` / `generate-data-entity-check` / `generate-factory-check` green.
- `pnpm --filter @arcaai/domains build test`.
- `pnpm --filter @arcaai/applications build test lint typecheck`.
- **Program regression gate**: existing LLM BYOK e2e (`apps/api/tests/e2e/ai-provider-connections*.spec.ts`) still green (via TASK-574's harness if a live stack is needed; otherwise unit-level).
- Migration evidence: row counts before/after + one decrypt round-trip proving a migrated ciphertext still decrypts.
- Contracts C1–C5 marked "published" in the program doc.

## 5. Implementation Summary

**Status: Implemented (Review). Migration authored, NOT applied** — the worktree has no `.env.dev`/DB credentials, so the DB is unreachable; applying via `prisma migrate dev` against the shared dev DB would also be unsafe during concurrent work. Row-count + decrypt round-trip evidence is deferred to a live-stack run (TASK-574 harness). All static + unit gates are green.

### Files changed (worktree-relative)
- **DB**: `packages/database/src/prisma/db_main/ai-provider-connection.prisma` (add `service`, re-key, rebuild indexes); `.../seed/17-ai-provider-connection.ts` (service on every row, +anthropic/vertex llm, +stt/tts cloud rows, llm-scoped coverage guard); `.../seed/__tests__/config-plane-seed.test.ts` (per-service shape tests).
- **Migration (new)**: `packages/database/src/prisma/db_main/migrations/20260728120000_task_569_provider_connection_service_discriminator/migration.sql`.
- **Domain**: `AiProviderConnection{Entity,Factory,Model,Repository}.ts` under `packages/domains/src/*/generated/core/` (Model via `gen:model`; entity/factory/repository hand-authored; mapper unchanged — OCC strip intact, `gen:mapper` NOT run).
- **App service**: `packages/applications/src/services/ai-provider-connection/**` — new `IProviderConnectionService.ts` (interface + token; old `IAiProviderConnectionService.ts` now a re-export shim, symbol aliased), service made service-first, `constants.ts` (C5 map + per-service `isCloudByoProvider` with a deprecated 1-arg shim), DTOs (+`service`), dto-mapper, module, index; tests migrated + new `ai-provider-connection.service-discriminator.test.ts`.

### Migration statements (additive + reversible, idempotent)
1. `ALTER TABLE ... ADD COLUMN "service" TEXT NOT NULL DEFAULT 'llm'` — backfills existing rows (R5).
2. Drop `AiProviderConnection_tenant_provider_unique`; create `AiProviderConnection_tenant_service_provider_unique` on `(tenantId, service, provider)`.
3. Drop `AiProviderConnection_tenantId_idx`; create `AiProviderConnection_tenantId_service_idx` + `AiProviderConnection_service_provider_idx` (keeps `_provider_idx`).
4a/4b. `INSERT ... SELECT ... ON CONFLICT (tenantId, service, provider) DO NOTHING` COPYING `TenantTtsProviderCredential`→`service='tts'` (endpoint→baseUrl) and `TenantSttProviderCredential`→`service='stt'` (endpoint→baseUrl, region, extraJson), preserving ciphertext/keyVersion/enabled/status/audit, fresh `uuidv7()` id + `_version=1`. Legacy tables left intact (TASK-576 drops them).

### Interface diff (C2 published)
Token/interface renamed `IAiProviderConnectionService` → `IProviderConnectionService` (old symbol kept as a `@deprecated` alias to the SAME value → smr-proxy `@Inject` still resolves). `type ProviderService = 'llm'|'stt'|'tts'`. Every method is service-first: `list(service, tenantId?)`, `getRow(service, provider, tenantId?)`, `upsertRow(service, provider, dto, tenantId?, expectedVersion?)`, `deleteRow(service, provider, tenantId?, expectedVersion?)`, `resolveConnection(service, provider, tenantId)`, `findRow(service, provider, tenantId)`, `resolveTenantCloudOverrides(service, tenantId)`. Transition shims kept for one release (TASK-572 removes): 1-arg `resolveTenantCloudOverrides(tenantId)` and 1-arg `isCloudByoProvider(provider)` both assume `service='llm'`. `expectedVersion` prefers the explicit param, falling back to `dto.expectedVersion`.

### `CLOUD_BYO_PROVIDERS` shipped (C5)
```ts
export const CLOUD_BYO_PROVIDERS: Record<ProviderService, readonly string[]> = {
  llm: ['azure', 'bedrock', 'openai', 'anthropic', 'vertex'],
  stt: ['azure-speech', 'sarvam', 'openai'],
  tts: ['azure', 'sarvam'],
};
```

### Gate evidence (run with `NODE_ENV=test`, inside the worktree)
- `gen:model:check` — no drift (125 files); `gen:entity:check` — no drift (74) + Schema coverage OK; `gen:factory:check` — no drift (74) + Schema coverage OK.
- `@arcaai/database test` — **873 passed**.
- `@arcaai/domains build` — Done; `test` — **1408 passed, 2 skipped, 9 todo**.
- `@arcaai/applications build` — Done; `test` — **7139 passed, 4 skipped**; `typecheck` — clean; `lint` — 0 errors (owned files 0 warnings; ~331 pre-existing warnings elsewhere unchanged).
- Existing LLM BYOK unit suites (`ai-provider-connection.service.test.ts`, `.tenant-lane.test.ts`) pass after the signature migration (call-sites updated to pass `service='llm'`). E2E deferred to a live stack (TASK-574 harness).

## 6. Change History
| Date | Author | Change |
|---|---|---|
| 2026-07-28 | platform review | Ticket authored (program Wave 0 foundation). |
| 2026-07-28 | opus-4-8 (impl) | Implemented: `service` discriminator + additive/reversible migration (backfill `llm`, copy TTS/STT creds idempotently), hand-authored domain updates, service-first `IProviderConnectionService` publishing C2/C5, deprecated 1-arg shims for smr-proxy. All static + unit gates green; migration authored-not-applied (no DB creds in worktree). |
