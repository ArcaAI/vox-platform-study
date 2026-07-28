# TASK-576 — Legacy Credential-Table Cleanup

- **Status**: Pending
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
_(fill on completion.)_

## 6. Change History
| Date | Author | Change |
|---|---|---|
| 2026-07-28 | platform review | Ticket authored (Wave 2 cleanup — runs last, destructive). |
