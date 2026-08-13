# TASK-576 — Legacy Credential-Table Cleanup

- **Status**: Review
- **Type**: refactor (cleanup)
- **Program**: [Unified Provider-Connection Plane](../SOTA-Track/2026-07-28-unified-provider-plane-program.md) — Wave 2 (runs LAST)
- **Branch of record**: `thuynh/2607`
- **Size**: M · **Wave**: 2 · **Depends on**: TASK-570 + TASK-571 (both must have cut TTS/STT credential reads/writes over to the unified plane) and ideally one release of soak.

> **Destructive migration — runs last.** Drops `TenantTtsProviderCredential` + `TenantSttProviderCredential` and removes their now-dead domain trios, only after every reader/writer has moved to `AiProviderConnection`. Requires explicit owner approval to apply (rule 02: never `DROP` without approval).

## Agent execution

| Phase | Tier | Goal |
|---|---|---|
| Discovery | **claude-sonnet-5-low** | Prove **zero** remaining references to `TenantTtsProviderCredential` / `TenantSttProviderCredential` in source (grep app + service + api + console + seed); confirm the 569 migration copied all rows and the adoption lanes read from the unified plane. Produce a reference-count report — the gate for proceeding. |
| Implementation | **claude-sonnet-5-xhigh** | Author the drop migration + remove dead domain trios + allow-list/`ResourceType` entries + seed rows; keep it reversible-by-restore-from-copy documentation. |
| Review/close | **claude-sonnet-5-xhigh** | Confirm drift checks green, no dangling imports, all suites green; get owner approval recorded before the drop is applied to any shared DB. |

**Ownership (exclusive):** the drop-table migration under `packages/database/src/prisma/db_main/migrations/**`, the `tenant-tts-config.prisma` / `tenant-stt-config.prisma` model deletions (credential models only — keep the spec models), the dead `TenantTtsProviderCredential*` / `TenantSttProviderCredential*` domain trios, and their seed/allow-list/`ResourceType` entries. **Do NOT** start until the discovery reference-count is zero.

## 1. Requirement Analysis
Remove the two now-redundant credential tables and all their dead code, after the adoption lanes (570/571) have proven the unified plane serves TTS/STT credentials. Keep `TenantSttConfig` + `TenantTtsConfig` (non-credential spec) intact.

Verifiable outcomes:
1. Grep proves zero source references to either credential model.
2. A reviewed drop migration removes both tables; drift checks + enum-parity green.
3. Domain trios, seed rows, `TENANT_SCOPED_MODELS`/`SYSTEM_SHARED_READ_MODELS` entries, and `ResourceType` members for the two credential models are removed cleanly; all suites green.

## 2. Current State Evaluation
- `TenantTtsProviderCredential` (`tenant-tts-config.prisma:62`) + `TenantSttProviderCredential` (`tenant-stt-config.prisma:62`) still present post-569 (569 copies rows but does not drop). Their rows are duplicated into `AiProviderConnection(service='tts'|'stt')`.
- Readers/writers move to the unified service in TASK-570/571 — this ticket only fires once those merged and the reference count is zero.

## 3. Implementation Plan
1. Discovery gate: `grep -r "TenantTtsProviderCredential\|TenantSttProviderCredential" packages apps` → must be empty (excluding generated client + these two prisma models + this doc).
2. Edit the two prisma files: delete the credential models (keep the spec models). `pnpm db:migrate:create` → `task_576_drop_legacy_provider_credentials`; review the `DROP TABLE` statements; document the restore path (rows still exist in `AiProviderConnection`).
3. Remove domain trios (`packages/domains/src/*/generated/core/TenantTtsProviderCredential*`, `TenantSttProviderCredential*`) + barrel lines; drop from `CoreDatabaseModule`; remove the two `ResourceType` members from the domain enum + `audit.prisma` (+ migration `ALTER TYPE ... ` note — Postgres cannot easily remove enum values; document leaving them as harmless-unused if removal is unsafe).
4. Remove seed rows + allow-list entries.
5. `pnpm gen:entity`/`gen:factory` (`:check`) reconcile barrels + coverage.
6. **Owner approval** recorded before applying the drop to any shared/test DB.

## 4. Verification
- Reference-count report empty; `pnpm --filter @arcaai/database test`, `@arcaai/domains`, `@arcaai/applications` green; `generate-*-check` + enum-parity green; migration SQL reviewed + owner-approved.

## 5. Implementation Summary

**Discovery gate (before any change):** `grep -rln "TenantSttProviderCredential\|TenantTtsProviderCredential" packages apps` returned 40 files. Every hit was one of: the two generated domain trios (deleted below), their barrels/`CoreDatabaseModule` registration, the `tenant-scope.ts` allow-lists, the `ResourceType` enum (both TS + prisma), historical migration SQL (never edited — rule 02), seed provenance comments, or plain code comments. `grep -rn` against `packages/applications` and `apps/api` for the repository/factory/entity class names specifically returned **zero** matches — confirmed no live read/write of either credential repository. Proceeded with the drop.

**Files deleted** (the two dead domain trios, 11 files):
- `packages/domains/src/{entities,factories,mappers,models,repositories}/generated/core/TenantSttProviderCredential{Entity,Factory,EntityMapper,Model,Repository}.ts`
- `packages/domains/src/{entities,factories,mappers,models,repositories}/generated/core/TenantTtsProviderCredential{Entity,Factory,EntityMapper,Model,Repository}.ts`
- `packages/domains/src/mappers/generated/core/__tests__/TenantSttProviderCredentialEntityMapper.test.ts`

**Files edited:**
- `packages/database/src/prisma/db_main/tenant-stt-config.prisma` / `tenant-tts-config.prisma` — removed the `TenantSttProviderCredential` / `TenantTtsProviderCredential` models; kept `TenantSttConfig` / `TenantTtsConfig`; reworded header comments.
- `packages/database/src/prisma/db_main/audit.prisma` + `packages/domains/src/enums/generated/ResourceType.ts` — kept `TenantSttProviderCredential` as a documented harmless-unused member in both (see decision below); `TenantTtsProviderCredential` was never a `ResourceType` member (TTS credential mutations broadcast under `ResourceType.TenantTtsConfig`), so nothing to keep there.
- `packages/database/src/extensions/tenant-scope.ts` — removed both models from `TENANT_SCOPED_MODELS`; reworded the `SYSTEM_SHARED_READ_MODELS` explanatory comments that named the now-deleted models.
- `packages/database/src/extensions/__tests__/tenant-scope.test.ts` — reworded the two stale explanatory comments; updated the hardcoded `TENANT_SCOPED_MODELS.size` tripwire `59 → 57`. The schema-derived drift-guard test needed no change (it reads `db_main/*.prisma` at runtime).
- `packages/domains/src/common/databaseServices/core/core.database.module.ts` — removed the two repository imports + provider/export entries.
- Five barrels (`entities`/`factories`/`mappers`/`models`/`repositories` → `generated/core/index.ts`) — removed the `export *` lines for both trios.
- `packages/domains/src/entities/generated/core/__tests__/TenantSttConfigEntity.test.ts` — removed the `TenantSttProviderCredentialEntity` describe block + its factory import; kept `TenantSttConfigEntity` coverage.
- `packages/domains/src/mappers/generated/core/AiProviderConnectionEntityMapper.ts` — removed a comment cross-reference to the now-deleted `TenantTtsProviderCredentialEntityMapper`.
- Stale-comment rewording in the 3 files named in the ticket brief: `packages/applications/src/services/tenant-stt-config/tenant-stt-config.service.ts:58`, `apps/api/src/modules/tenant-tts-config/tenant-tts-config-admin.controller.ts:22`, `packages/applications/src/services/baseServices/_meta/secrets/secret-field.util.ts:5` — wording only, no logic changed.
- `packages/database/src/prisma/db_main/seed/ai-models/tts.ts` — updated a user-facing `AiModel.description` string that named the dropped table.

**Drop migration (authored, NOT applied):** `packages/database/src/prisma/db_main/migrations/20260728130000_task_576_drop_legacy_provider_credentials/migration.sql` — two `DROP TABLE IF EXISTS "core"."TenantTtsProviderCredential"` / `"TenantSttProviderCredential"` statements (neither table carries an FK, so no dependent-constraint cleanup is needed). Hand-authored (no reachable DB in this worktree to run `prisma migrate dev --create-only`), following the same header-comment convention as existing migrations. The header documents the restore path: TASK-569 (`20260728120000_task_569_provider_connection_service_discriminator`) already **copied** (never moved) every row from both legacy tables into `AiProviderConnection` (`service='tts'|'stt'`), so no data is at risk — only the legacy table SHAPE would need re-creating from the 496/567 migrations if ever needed, then re-populating from `AiProviderConnection`.

**`ResourceType` decision:** left `TenantSttProviderCredential` as a documented harmless-unused member in both `audit.prisma`'s `ResourceType` enum and the domains `ResourceType.ts` TS enum, per the ticket's recommendation — Postgres cannot cheaply `DROP VALUE` from an in-use enum type, and `resourceType.enum-parity.test.ts` requires the two enums to match. No enum-drop migration was authored. `TenantTtsProviderCredential` required no such treatment — it was never a `ResourceType` member in the first place (TTS credential mutations always broadcast under `ResourceType.TenantTtsConfig`, confirmed by reading `tenant-tts-config.service.ts`).

**Gates — all green, real output:**
- `NODE_ENV=test pnpm db:generate` — regenerated the Prisma client + index from the edited schema (no DB connection needed for `prisma generate`).
- `NODE_ENV=test pnpm --filter @arcaai/database test` — **873/873 tests passed** (26 test files), including the `tenant-scope` allow-list + schema-derived drift guard.
- `NODE_ENV=test pnpm gen:model` — regenerated `models/generated/core` + enums from the DMMF; `ResourceType.ts` came out byte-identical to the hand-edit (the generator reproduces schema-file comments), `models/generated/core/index.ts` lost the same 2 lines already removed by hand — zero unexpected drift.
- `NODE_ENV=test pnpm --filter @arcaai/tools generate-data-model:check` — **no drift — 123 generated file(s) match the committed files.**
- `NODE_ENV=test pnpm --filter @arcaai/tools generate-data-entity:check` — **no drift — 72 generated file(s) match**; **schema coverage OK: 70 entity artifact(s) cover every persisted column of 74 Prisma model(s).**
- `NODE_ENV=test pnpm --filter @arcaai/tools generate-factory:check` — **no drift — 72 generated file(s) match**; **schema coverage OK: 70 factory artifact(s) cover every persisted column of 74 Prisma model(s).**
- `NODE_ENV=test pnpm --filter @arcaai/domains build` — clean (after also building the previously-unbuilt `@arcaai/exceptions` and `@arcaai/database` dependencies in this fresh worktree).
- `NODE_ENV=test pnpm --filter @arcaai/domains test` — **1401/1412 tests passed, 2 skipped, 9 todo, 0 failed** (120/122 files), including `resourceType.enum-parity.test.ts` and the trimmed `TenantSttConfigEntity.test.ts`.
- `NODE_ENV=test pnpm --filter @arcaai/applications build` — clean (after also building the previously-unbuilt `@arcaai/types` dependency).
- `NODE_ENV=test pnpm --filter @arcaai/applications typecheck` — clean, 0 errors — proves nothing in `packages/applications` still imports the removed trios.
- `NODE_ENV=test pnpm --filter @arcaai/applications test` — **7131/7135 tests passed, 4 skipped, 0 failed** (367/368 files) — full-suite regression check, not just the two touched services.

**Environment note:** this worktree had no `.env.dev`; `NODE_ENV=test` (which loads `.env.test`, pointing at the isolated test-infra Postgres on :5433) was used purely to give Prisma a syntactically valid `DATABASE_URL` for schema-only operations (`prisma generate`, the generator `:check` commands) — no database was ever connected to or written to. `@arcaai/exceptions`, `@arcaai/database`, and `@arcaai/types` had no prior `dist/` in this fresh worktree and were built as a prerequisite for downstream `tsc`; this is a worktree-freshness artifact, not related to this ticket's changes.

**Owner tail (not done here, per the ticket's own gate):** apply the drop migration to a real (test, then shared) DB only after explicit owner approval, verify the drop against a DB that has actually run the TASK-569 copy migration, and drop this ticket's `Status` to `Completed` once that runs clean.

## 6. Change History
| Date | Author | Change |
|---|---|---|
| 2026-07-28 | platform review | Ticket authored (Wave 2 cleanup — runs last, destructive). |
| 2026-07-28 | claude-sonnet-5 (agent) | Discovery gate (zero live references) → deleted the two dead domain trios + barrels + `CoreDatabaseModule` registration → removed the two credential models from `tenant-stt-config.prisma`/`tenant-tts-config.prisma` → updated `tenant-scope.ts` allow-lists + drift-guard test → left `ResourceType.TenantSttProviderCredential` as documented harmless-unused (parity-safe, no enum-drop migration) → authored (not applied) the `task_576_drop_legacy_provider_credentials` drop migration → reworded stale comments in the 3 named files + 2 more discovered in the same sweep. All static gates green (database 873/873, domains 1401/1401 + drift/coverage checks, applications build+typecheck clean + 7131/7131 full suite). Status → Review; the DB-apply owner tail remains open. |
