# TASK-658 — Consultation Context Schema: data model, validation, discovery

- **Status:** Review
- **Type:** feature
- **Wave:** W1 of [TASK-654](../TASK-654-Consultation-Context-Schema-And-Configurable-Loop/README.md) — **blocks every downstream ticket**
- **Baseline:** `dev-2.1` @ `b3d3fe590` (merge(TASK-657): vision content-parts support across SMR providers)
- **Branch:** `worktree-agent-ac8db98d7f8bb80a4` (worktree, `git reset --hard dev-2.1` performed — it spawned from `dev`)
- **Spec:** [execution-plan.md § TASK-658](../TASK-654-Consultation-Context-Schema-And-Configurable-Loop/execution-plan.md)

---

## 1. Requirement Analysis

**Objective.** A tenant admin declares the *kinds* of context a consultation carries; a client
discovers that declaration at runtime and builds its workflow from it; the server validates every
submitted payload against the **pinned** version of that declaration.

This is TASK-654 requirement **R1** (tenant-defined context schema) and the server half of **R2**
(client discovery). It carries decision **D2** — *fully tenant-defined kinds, resolved by each kind
declaring one of five platform primitives* — and **D4** — *runtime discovery is the wire contract*.

| # | Acceptance criterion |
|---|---|
| AC-1 | Two new models — `ConsultationContextSchema` (mutable head) and `ConsultationContextSchemaVersion` (immutable snapshot) — following the house `resource → immutable version → movable pinned default` shape (TASK-654 C6) |
| AC-2 | `ContextItem` gains `kindKey` and `contextSchemaVersionId`; `ContextItemType` gains `STRUCTURED` |
| AC-3 | A kind declaring a primitive outside the closed five-value set is **rejected at publish** |
| AC-4 | A payload is validated against the **pinned** version, never the latest |
| AC-5 | A cross-tenant schema id answers **404, never 403** (TASK-654 C5) |
| AC-6 | An additive change (new optional field) publishes unacknowledged; a rename requires an explicit breaking-change acknowledgement |
| AC-7 | The discovery bundle carries a strong `ETag` that changes **only** when the served version changes |
| AC-8 | Authorable JSON Schema is a constrained subset: no `if`/`then`/`else`, `oneOf` only with an explicit discriminator |
| AC-9 | **Regression:** an existing context write with no `kindKey` behaves exactly as it does today |

### 1.1 Design constraints inherited from the parent

| # | Constraint | How this ticket honors it |
|---|---|---|
| C3 | PHI is encrypted at rest, fail-closed on egress | A `STRUCTURED` payload is serialised into the existing `ContextItem.content` field and rides the **unchanged** `encryptContent` → Vault-Transit `hope-phi` path. No new plaintext PHI column is introduced. |
| C5 | Cross-tenant access returns 404 | `findOwnedOrThrow` on every by-id path (the `TenantAllowedOriginService` precedent) |
| C6 | resource → immutable version → movable pinned default | `ConsultationContextSchema.pinnedVersionNumber` → `ConsultationContextSchemaVersion` |
| C7 | Global `whitelist + forbidNonWhitelisted + forbidUnknownValues` | `kindKey` and `payload` are **declared** `@IsOptional()` fields on `AddContextRequest` / `UpdateContextRequest`; the tenant-defined shape rides the single declared `payload` envelope and is validated in the service layer |

### 1.2 Out of scope (belongs to a later wave)

Loop/agent wiring (TASK-659/660/662), full compatibility & lifecycle guarantees beyond AC-6
(TASK-661), the SDK surface (TASK-665) and the admin-console editor (TASK-666).

---

## 2. Current State Evaluation

Verified against `dev-2.1` @ `b3d3fe590`.

| Area | Finding |
|---|---|
| Context model | `ContextItem` (`consultation.prisma:73`) is the single container, discriminated by the **closed** `ContextItemType` enum (`enums.prisma:224`). A repo-wide search for `ContextSchema` / `FieldDefinition` / `CustomField` returns zero matches — adding a context kind today is a Prisma migration. |
| Write funnel | `ContextService.addContext` (`context.service.ts:149`) is the single funnel for all context writes. The only kind-aware validation today is the imperative `isMediaType` content check at `:165-168`. `updateContext` (`:247`) is the second write path. |
| PHI encryption | `encryptContent` (`:123`) → `encryptPhiFields` → Vault-Transit `hope-phi`. The plaintext `content` column was dropped; ciphertext is the system of record. |
| Governance shape | `PromptTemplate`/`PromptVersion` (`prompt-template.prisma`) is the exact precedent: mutable head with `currentVersionNumber` + `approvedVersionNumber` pin, immutable `PromptVersion` rows with `changeReason`, and a `DRAFT | PUBLISHED | APPROVED` status enum. `PromptVersion` carries **no** `resourceStatus` and is listed in `MODELS_WITHOUT_SOFT_DELETE`. |
| Discovery seam | `GET /tenant/me/config` (`my-tenant.controller.ts:53`) returns a flat `{key,value,namespace}[]` of `GlobalSetting` rows — a nested schema bundle does not fit. Every structured tenant config in this repo (`tenant-stt-config`, `tenant-tts-config`, `tenant-storage-config`, `tenant-allowed-origin`) has its **own controller**. → new sibling controller. |
| ETag | `ETagInterceptor` (`apps/api/src/interceptors/etag.interceptor.ts`) only sets an ETag from a top-level integer `version` — i.e. it is the **OCC** validator, not a representation validator. A discovery bundle needs a representation ETag, so it is set explicitly by the discovery controller from a service-computed value. |
| Validators | No JSON Schema library is a dependency of `@arcaai/applications` (no ajv, no zod). The subset validator is therefore hand-written — which is also what makes the "closed subset" enforceable rather than aspirational. |
| Domain layer | Only `pnpm gen:model` scaffolds. `gen:entity`/`gen:factory` reconcile barrels + prove schema coverage; `gen:mapper` is destructive; `gen:repository` is broken. Exemplars for hand-authoring: `AiTaskDefault*`, `TenantAllowedOrigin*`. |

---

## 3. Implementation Plan

### 3.1 The `definition` document

Each tenant-invented kind declares exactly one of **five platform primitives**; the primitive is
what the engine reasons about, and rejecting an unknown primitive is the enforcement point that
makes the whole design safe (TASK-654 §4.1).

```jsonc
{
  "schemaVersion": "1.0",
  "kinds": [{
    "key": "referral_letter",                 // [a-z0-9_]{2,48}, unique within the schema
    "label": "Referral Letter",
    "primitive": "STREAM_AUDIO|TEXT|DOCUMENT|IMAGE|STRUCTURED",   // CLOSED set
    "phiClass": "PHI|NON_PHI",
    "cardinality": "ONE|MANY",
    "lifecycle": "PRE|DURING|POST|ANY",
    "producedBy": ["CLIENT"|"AGENT"|"SYSTEM"],
    "required": false,
    "fields": { /* JSON Schema draft 2020-12 subset — REQUIRED for STRUCTURED */ },
    "constraints": { "mimeTypes": ["application/pdf"], "maxBytes": 20971520 }
  }],
  "outputs": [{ "key": "soap_note", "primitive": "STRUCTURED", "fields": { } }]
}
```

**Authorable JSON Schema subset** (`assertAuthorableJsonSchema`), rejected at publish:

| Rejected | Why |
|---|---|
| `if` / `then` / `else` at any depth | No clean TypeScript equivalent for downstream codegen (TASK-668) |
| `oneOf` without a sibling `discriminator: { propertyName }` | Generators otherwise emit merged property soup |
| Nesting deeper than 12 levels / more than 512 schema nodes | Bounded traversal — an unbounded authored document is a DoS surface in a PHI system |
| Unknown top-level / per-kind keys in the *definition* envelope | Fail-closed, mirroring the gateway's `forbidNonWhitelisted` posture |

### 3.2 Publish semantics (AC-6)

`classifyDefinitionChange(prev, next) → IDENTICAL | ADDITIVE | BREAKING`

- **IDENTICAL** (checksums equal) → **no new version row, pin unchanged** ⇒ the discovery ETag does not move (AC-7).
- **ADDITIVE** (new kind, new *optional* property, relaxed constraint) → new version, pin advances. No acknowledgement.
- **BREAKING** (kind/property removed or renamed, `primitive`/`phiClass`/`cardinality`/`type` changed, `required` widened) → refused with `400` listing the breaking diffs unless the caller passes `allowBreakingChange: true`.

Every definition change still writes an immutable version row — that is the audit trail and is
non-negotiable. "Does not require a version bump" is expressed as *does not require the admin to
acknowledge a break*, which is the client-visible meaning.

### 3.3 File plan

| # | Layer | Files |
|---|---|---|
| 1 | Prisma | new `consultation-context-schema.prisma`; `enums.prisma` (+`STRUCTURED`, + 2 new enums); `consultation.prisma` (`ContextItem.kindKey`, `.contextSchemaVersionId`); `audit.prisma` (`ResourceType.ConsultationContextSchema`) |
| 2 | Migration | `<ts>_task_658_consultation_context_schema` — `CREATE TYPE` ×2, `ALTER TYPE … ADD VALUE IF NOT EXISTS` ×2, `CREATE TABLE` ×2, `ALTER TABLE "ContextItem" ADD COLUMN` ×2, indexes |
| 3 | DB allow-lists | `TENANT_SCOPED_MODELS` (both models); `MODELS_WITHOUT_SOFT_DELETE` (the version table only) |
| 4 | Domain | `gen:model`; hand-authored entity/factory/mapper/repository ×2; `ContextItemEntity`/`Factory` gain the two columns; barrels ×4; `CoreDatabaseModule`; `ResourceType.ts` |
| 5 | Applications | `services/consultation-context-schema/**` — pure validators (`context-schema-definition.ts`, `json-schema-subset.ts`, `definition-diff.ts`), service, DTOs, module, DTO mapper |
| 6 | Validation hook | `ContextService.addContext` after the metadata merge and **before** `encryptContent`; same validator from `updateContext`; `AddContextRequest`/`UpdateContextRequest` gain declared `kindKey`/`payload` |
| 7 | API | `apps/api/src/modules/consultation-context-schema/` — admin controller + discovery controller + module; registered in `app.module.ts` |
| 8 | Seed | `01-policy.ts` — `manage:ConsultationContextSchema` for `tenant-full-access` |

### 3.4 TDD list (RED first)

| # | Test | Where |
|---|---|---|
| T0 | **Regression** — `addContext` with no `kindKey` is byte-identical in behaviour to today | `context.service.task658.test.ts` |
| T1 | A kind declaring an unknown primitive is rejected at publish | `context-schema-definition.test.ts` + service test |
| T2 | A payload validates against the **pinned** version, not the latest | `consultation-context-schema.service.test.ts` |
| T3 | Cross-tenant schema id → 404 | service test |
| T4 | Additive change publishes unacknowledged; a rename is refused without `allowBreakingChange` | `definition-diff.test.ts` + service test |
| T5 | ETag changes only when the served version changes (idempotent republish moves nothing) | service test |
| T6 | `if`/`then`/`else` rejected; `oneOf` without discriminator rejected | `json-schema-subset.test.ts` |
| T7 | `ResourceType` enum parity holds | existing `resourceType.enum-parity.test.ts` |

---

## 4. Implementation Summary

**Status: Review.** All eight acceptance criteria implemented and covered by tests; every gate green.

### 4.1 Files changed

**Database (`packages/database/`)**

| File | Change |
|---|---|
| `src/prisma/db_main/consultation-context-schema.prisma` | **NEW** — `ConsultationContextSchema` (mutable head) + `ConsultationContextSchemaVersion` (immutable snapshot) |
| `src/prisma/db_main/enums.prisma` | `ContextItemType.STRUCTURED`; new `ConsultationContextSchemaScope`, `ConsultationContextSchemaStatus` |
| `src/prisma/db_main/consultation.prisma` | `ContextItem.kindKey`, `.contextSchemaVersionId` + 2 indexes |
| `src/prisma/db_main/department.prisma` | back-relation `ConsultationContextSchemas` |
| `src/prisma/db_main/audit.prisma` | `ResourceType.ConsultationContextSchema` |
| `src/prisma/db_main/migrations/20260811000000_task_658_consultation_context_schema/migration.sql` | **NEW** |
| `src/extensions/tenant-scope.ts` | both models → `TENANT_SCOPED_MODELS` (72 → 74) |
| `src/client.ts` | version table → `MODELS_WITHOUT_SOFT_DELETE` |
| `src/prisma/db_main/seed/01-policy.ts` | `manage:ConsultationContextSchema` on `tenant-full-access` |
| `src/__tests__/soft-delete-extension.test.ts`, `src/extensions/__tests__/tenant-scope.test.ts` | inventory tripwires updated |

**Domain (`packages/domains/`)** — `ConsultationContextSchema{Entity,Factory,EntityMapper,Repository}` and `ConsultationContextSchemaVersion{Entity,Factory,EntityMapper,Repository}` (all **hand-authored**), `ResourceType.ts`, `ContextItemEntity`/`ContextItemFactory`, four `generated/core/index.ts` barrels, `core.database.module.ts`. Model layer + the two new enums produced by `pnpm gen:model`.

**Applications (`packages/applications/src/services/`)** — new `consultation-context-schema/` (3 pure validator modules, service, interface, DTO mapper, DTOs, module, 4 test files); `consultation/context/context.service.ts` + its module + `add-context.request.ts` + `update-context.request.ts` + 1 new test file; `services/index.ts`.

**API (`apps/api/src/`)** — new `modules/consultation-context-schema/` (2 controllers + module); `app.module.ts`.

### 4.2 The migration

`20260811000000_task_658_consultation_context_schema` — additive only:

- `CREATE TYPE` ×2 (`ConsultationContextSchemaScope`, `ConsultationContextSchemaStatus`)
- `ALTER TYPE … ADD VALUE IF NOT EXISTS` ×2 (`ContextItemType.STRUCTURED`, `ResourceType.ConsultationContextSchema`) — safe in the migration transaction because neither value is *used* in it
- `ALTER TABLE "ContextItem" ADD COLUMN "kindKey" TEXT, ADD COLUMN "contextSchemaVersionId" TEXT` — both **nullable, no default**, which is the AC-9 regression guarantee at the storage layer
- `CREATE TABLE` ×2, 8 indexes (incl. 2 unique), 2 foreign keys

**How it was produced and verified.** `pnpm db:migrate:create` could not be used — `prisma migrate dev` demands a reset because the local dev DB is `db push`-managed and carries no `_prisma_migrations` ledger. The SQL was therefore generated with `prisma migrate diff --from-migrations … --to-schema …` against a throwaway shadow database, which **replays every committed migration plus this one**; re-running that diff afterwards returns only pre-existing TASK-648 index-rename drift, proving this migration closes its own diff exactly. The dev DB was then synced with `pnpm db:push` (its normal management path) and the result inspected directly (`\d core."ConsultationContextSchemaVersion"`, `enum_range(ContextItemType)`).

### 4.3 The enforced JSON Schema subset

`authorableJsonSchemaProblems` walks the authored document and rejects:

| Rejected | Enforcement |
|---|---|
| `if` / `then` / `else` **at any depth** | keyword presence check on every visited node, path-reported |
| `oneOf` without a sibling `discriminator` whose `propertyName` is a non-empty string | checked wherever `oneOf` appears |
| unsupported `type` values | closed list `object array string number integer boolean null` |
| nesting deeper than **12** levels, or more than **512** nodes | bounded traversal; an authored document is untrusted input walked on every payload write |

`contextSchemaDefinitionProblems` wraps that with the envelope rules: closed `schemaVersion`, closed `primitive` set (**the enforcement point** — an unknown primitive is refused at publish), closed `phiClass`/`cardinality`/`lifecycle`/`producedBy`, `[a-z0-9_]{2,48}` keys unique per schema, `fields` mandatory on `STRUCTURED`, unknown top-level and per-kind keys rejected, ≤ 64 declarations. Every problem is returned at once rather than throwing on the first.

Payload validation (`jsonSchemaValueProblems`) supports `type`, `properties`, `required`, `additionalProperties`, `items`, `enum`, `const`, `min/maxLength`, `pattern`, `minimum`, `maximum`, `min/maxItems`, `anyOf`, `allOf` and **discriminated** `oneOf` (routed to the single matching branch, so the caller gets the error the author meant). Hand-written on purpose: a general-purpose library would accept the banned keywords, making the "subset" documentation rather than enforcement — and no JSON Schema library is a dependency of this package.

### 4.4 Decisions worth reviewing

| # | Decision | Reasoning |
|---|---|---|
| D-1 | A `STRUCTURED` payload is canonicalised and stored in the **existing encrypted `content` column** | Constraint C3. A new JSONB column would be a new plaintext PHI column; this way the Vault-Transit `hope-phi` path is entirely unchanged. |
| D-2 | "Additive needs no version bump; a rename does" is implemented as **IDENTICAL / ADDITIVE / BREAKING** | Every change still writes an immutable version row (the audit trail is not negotiable), so the real question is whether an existing client keeps working. IDENTICAL writes nothing and moves nothing (which is what makes AC-7 true); ADDITIVE publishes silently; BREAKING is refused without `allowBreakingChange`. |
| D-3 | `publish` always advances the pin; a separate `POST :id/pin` moves it | That is the "movable pinned default" of C6, gives the rollback path, and makes AC-4 genuinely testable (pinned ≠ latest). |
| D-4 | The discovery ETag is computed by the **service** and set by the controller, not by the global `ETagInterceptor` | That interceptor derives its validator from a row's `_version` — it is the OCC validator for a mutable row. A bundle is a resolved representation; using `_version` would invalidate every client's cache when a schema is merely renamed. |
| D-5 | An unconfigured tenant gets **200 with null fields and `ETag: "none"`**, never 404 | A client cannot distinguish 404-the-resource from 404-the-route, so it could not decide whether to fall back to its built-in flow. |
| D-6 | The validation call in `addContext` sits slightly **earlier** than the spec's "after the metadata merge" | A `STRUCTURED` payload *becomes* the item's content, so the content-required guard and the factory both have to see it. The operative half — before `encryptContent` — holds strictly. Nothing in validation reads `metadata`. |
| D-7 | Naming a kind with the schema plane unwired **fails closed** | An unvalidated clinical payload must never reach the database because a module was mis-assembled. |
| D-8 | `ConsultationContextSchemaVersion` is **not** a `ResourceType` | An immutable snapshot written as part of its parent's publish has no lifecycle of its own — the `PromptVersion` / `AsrPipelineVersion` / `DnaWritingStyleVersion` precedent. |
| D-9 | RBAC seed grant added | Without `manage:ConsultationContextSchema` on `tenant-full-access` the feature is unreachable by the audience TASK-654 R1 names. |

### 4.5 Observations for other tickets (not fixed here)

- **`pnpm db:migrate` is broken on `dev-2.1`.** The script is `prisma migrate dev --skip-generate`, and Prisma 7 removed `--skip-generate`; the command exits 1 on the flag before doing anything. `pnpm db:migrate:create` additionally cannot run against the local dev DB (no migration ledger → demands a reset). Neither is caused by this ticket, and neither is fixed by it.
- **Pre-existing migration/schema drift from TASK-648.** Four indexes are named differently in the ledger than Prisma derives from the schema (`ChangelogEntry_platformVersion_unique`, `ServiceInstance_service_env_instance_unique`, `ServiceRelease_service_commit_tag_unique`, `UserChangelogAck_user_entry_unique`). Deliberately left alone — another ticket's territory.
- A fresh worktree needs `@arcaai/room`, `noise-filter`, `vad`, `stt`, `med-ner`, `vox` and `ui` built before `pnpm test:unit` is meaningful; without them ~31 files fail on unresolved workspace entries with nothing to do with the change under test.

---

## 5. Verification Evidence

All commands run from the worktree at `dev-2.1` @ `b3d3fe590`.

### `pnpm db:generate`

```
✔ Generated Prisma Client (7.8.0) to ./src/generated/core-prisma-client in 275ms
✅ Index file generated successfully!
```

### Migration application

`pnpm db:migrate` fails on `dev-2.1` for a reason unrelated to this ticket (§4.5):

```
> prisma migrate dev --skip-generate
! unknown or unexpected option: --skip-generate
Exit status 1
```

The migration was verified instead by replaying the whole ledger into a shadow database — after adding it, the only remaining diff is the pre-existing TASK-648 index-rename drift:

```
$ prisma migrate diff --from-migrations ./src/prisma/db_main/migrations --to-schema ./src/prisma/db_main --script
-- RenameIndex
ALTER INDEX "core"."ChangelogEntry_platformVersion_unique" RENAME TO "ChangelogEntry_platformVersion_key";
-- RenameIndex
ALTER INDEX "core"."ServiceInstance_service_env_instance_unique" RENAME TO "ServiceInstance_serviceName_environment_instanceId_key";
-- RenameIndex
ALTER INDEX "core"."ServiceRelease_service_commit_tag_unique" RENAME TO "ServiceRelease_serviceName_gitCommitSha_releaseTag_key";
-- RenameIndex
ALTER INDEX "core"."UserChangelogAck_user_entry_unique" RENAME TO "UserChangelogAcknowledgement_userId_changelogEntryId_key";
```

and the dev DB synced through its normal path, then inspected:

```
$ pnpm db:push
🚀  Your database is now in sync with your Prisma schema. Done in 220ms

$ psql -d hope -c '\d core."ConsultationContextSchemaVersion"'
Indexes:
    "ConsultationContextSchemaVersion_pkey" PRIMARY KEY, btree (id)
    "ConsultationContextSchemaVersion_schemaId_idx" btree ("schemaId")
    "ConsultationContextSchemaVersion_schemaId_versionNumber_key" UNIQUE, btree ("schemaId", "versionNumber")
    "ConsultationContextSchemaVersion_tenantId_idx" btree ("tenantId")

$ psql -d hope -c 'select unnest(enum_range(NULL::core."ContextItemType"))'
 AUDIO_RECORDING WORKNOTE RAW_SUMMARY MODIFIED_SUMMARY PRE_SUMMARY NAMED_ENTITY
 TRANSCRIPT CASE_NOTE ATTACHMENT SIGNED_NOTE STRUCTURED        (11 rows)
```

### Package gates

```
$ pnpm --filter @arcaai/database build
> tsc                                                    (clean)

$ pnpm --filter @arcaai/database test
 Test Files  47 passed (47)
      Tests  1165 passed (1165)

$ pnpm --filter @arcaai/domains build
> tsc                                                    (clean)

$ pnpm --filter @arcaai/domains test
 Test Files  137 passed | 2 skipped (139)
      Tests  1564 passed | 2 skipped | 9 todo (1575)

$ pnpm --filter @arcaai/applications build
> rimraf dist tsconfig.tsbuildinfo && tsc                 (clean)

$ pnpm --filter @arcaai/applications test
 Test Files  459 passed | 1 skipped (460)
      Tests  8685 passed | 4 skipped (8689)

$ pnpm api:build
 Tasks:    9 successful, 9 total
  Time:    15.43s
```

**Baseline comparison** (same worktree, before this ticket): applications **454 files / 8,608 passed** → **459 / 8,685** (+5 files, +77 tests, all new). Database **47 files / 1,164** (2 of them the inventory tripwires this ticket must update) → **47 / 1,165**. Domains unchanged at **137 / 1,564** — the `ResourceType` parity guard is inside that run and passes.

### `pnpm test:unit` (whole monorepo, exit 0)

```
 Test Files  964 passed | 2 skipped (966)
      Tests  16452 passed | 4 skipped | 9 todo (16465)
packages/ui test:              Test Files  242 passed (242)   Tests   656 passed
packages/agentic-sdk-v2 test:  Test Files  255 passed (255)   Tests  4131 passed
apps/compat-playground test:   Test Files   21 passed  (21)   Tests   223 passed
apps/admin-console test:       Test Files  172 passed (172)   Tests  1339 passed
```

### `pnpm lint` (exit 0)

```
 Tasks:    32 successful, 32 total
  Time:    28.096s
```

No warnings on any file added by this ticket. The `eslint-comments/require-description` warnings remaining on `context.service.ts` are pre-existing: `dev-2.1` has 8 `eslint-disable` comments in that file and so does this branch — none were added.

### Generator drift (`pnpm gen:check`, exit 0)

```
[Generate Data Model]  check: no drift — 154 generated file(s) match the committed files.
[Generate Data Entity] check: no drift — 89 generated file(s) match the committed files.
[Generate Data Entity] Schema coverage OK: 87 entity artifact(s) cover every persisted column of 91 Prisma model(s)
[generate-factory]     check: no drift — 89 generated file(s) match the committed files.
[generate-factory]     Schema coverage OK: 87 factory artifact(s) cover every persisted column of 91 Prisma model(s)
```

`pnpm gen:mapper` was **never run** (destructive — it strips the `_version` OCC guard). Both new mappers carry that guard by hand.

### AC → test map

| AC | Test | File |
|---|---|---|
| AC-3 | unknown primitive rejected at publish | `context-schema-definition.test.ts`, `consultation-context-schema.service.test.ts` |
| AC-4 | payload validates against the pinned version, not the latest | `consultation-context-schema.service.test.ts` |
| AC-5 | cross-tenant id → 404 (incl. before definition validation on `publish`) | `consultation-context-schema.service.test.ts` |
| AC-6 | additive publishes unacknowledged; rename refused, then accepted with `allowBreakingChange` | `definition-diff.test.ts`, `consultation-context-schema.service.test.ts` |
| AC-7 | ETag stable across a head-row rename, moves when the pin moves | `consultation-context-schema.service.test.ts` |
| AC-8 | `if`/`then`/`else` rejected at any depth; `oneOf` needs a discriminator | `json-schema-subset.test.ts` |
| AC-9 | **regression** — a write with no `kindKey` consults nothing and behaves identically | `context.service.context-schema.task658.test.ts` |
| — | `ResourceType` enum parity | `resourceType.enum-parity.test.ts` (domains) |

## Change History

- 2026-08-11 — Ticket opened from the TASK-654 execution-plan spec. Worktree reset from `dev` to `dev-2.1` @ `b3d3fe590`; plan authored before any code.
- 2026-08-11 — Implemented in five commits (schema+migration / domain layer / validators / service / ContextService hook / API+seed). All gates green; status **Review**. Not merged, not pushed.
