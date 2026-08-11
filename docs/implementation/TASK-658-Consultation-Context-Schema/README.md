# TASK-658 — Consultation Context Schema: data model, validation, discovery

- **Status:** In Progress
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

_Completed at the end of the ticket — see §5._

## 5. Verification Evidence

_Gate output pasted here._

## Change History

- 2026-08-11 — Ticket opened from the TASK-654 execution-plan spec. Worktree reset from `dev` to `dev-2.1` @ `b3d3fe590`; plan authored before any code.
