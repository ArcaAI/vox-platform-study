# TASK-356 — Phase 5 (Realtime cascade — Pillar B) — TDD Implementation Plan

| Field | Value |
|---|---|
| **Ticket** | TASK-356 — Admin-Managed Models & Workflows |
| **Phase** | Phase 5 — Realtime cascade (Pillar B: harness realtime config) |
| **Status** | **Plan — awaiting approval** |
| **Date** | 2026-06-15 (planned) |
| **Author** | Planner (subagent) |
| **Scope of this doc** | Plan only — NO code written. Mirrors [`phase-2-defaults-wiring-plan.md`](./phase-2-defaults-wiring-plan.md). Resolves the open design questions in §12 before any RED test is written. |

---

## 1. Purpose

Implement the **documented-but-missing realtime configuration cascade** for Pillar B (the harness/realtime
documentation pipeline). Per ticket [`README.md`](./README.md) §4.6 + §6 (Phase 5) + §7 (D-9), the realtime
toggles and the harness-vs-legacy routing flag are supposed to resolve through a single layered cascade
(`platform → tenant → department → doctor`), but today they resolve at **consultation scope only** (G-10), and
the doctor-preferred prompt id is dropped on the asynchronous generation paths (G-11 partial). Concretely:

1. **(a) `ConfigResolver` generalization** — extract the layering logic that already lives (separately) in
   `HarnessPolicyService.getEffectivePolicy()` (tenant → global → code-default) and `PromptResolutionService`
   (doctor → department → default) into a reusable resolver that returns the effective value for
   `(setting, tenant, department?, doctor?)` **with a resolution trace**, and that enforces a **per-setting max
   scope** (safety/gating stop at tenant — cascade decision `safety_tenant`).
2. **(b) `PipelinePolicy` + dept/doctor overrides for summary/NER** — back the realtime toggles
   (`autoSummaryEnabled`, `autoNerEnabled`, `harnessEnabled`) with persisted policy rows (tenant default mirroring
   `HarnessPolicy`, plus department + doctor overrides), and make `resolvePipelineConfig()` consume the cascade
   instead of reading only the consultation's own `metadata.pipelineConfig`.
3. **(c) Replace hard-coded `harnessEnabled`** — remove the UI launch-panel hard-code
   (`HARNESS_PIPELINE_METADATA = { pipelineConfig: { harnessEnabled: true } }`) and resolve `harnessEnabled`
   server-side from the cascade, preserving the clinical-workspace demo behaviour via a seeded tenant policy.
4. **(d) Legacy-path doctor-preferred prompt threading** — thread
   `UserProfile.preferredPromptTemplateId` into the asynchronous generation paths that currently drop it
   (legacy auto/BullMQ + — see the §3.4 finding — the harness assemble callback), so the doctor-preferred tier of
   `PromptResolutionService` actually fires off the realtime path, matching the synchronous REST path that already
   threads it.

**This phase is a backend cascade + one additive table.** It does **not** add doctor-facing prompt CRUD
routes/UI or DNA self-service (that is Phase 6 — §10), does **not** change the SMR gateway model resolution (that
is Phase 3 — §10), and does **not** touch `apps/harness/**`, sensors, PHI, or gating thresholds
(TASK-355/357/358/359 — §10).

---

## 2. Scope & decisions

### In scope
- **DB (additive only):** one new `PipelinePolicy` table (tenant default + dept/doctor overrides via a scope
  discriminator) + a WORM `PipelinePolicyChange` companion, mirroring `HarnessPolicy`/`HarnessPolicyChange`
  (`harness.prisma:257-338`). New enum `PipelinePolicyScope { TENANT, DEPARTMENT, DOCTOR }`. **No column changes
  to existing tables** (`Department`, `UserProfile`, `Consultation` untouched) — pending §12 Q2.
- **Domain (generated):** full regeneration for the two new models (entity/factory/model/mapper/repository ×2) +
  the new enum + barrels + `CoreDatabaseModule` registration.
- **Applications:**
  - new `ConfigResolver` service (generic layered resolver + per-setting max-scope registry + trace);
  - new `PipelinePolicyService` (CRUD + OCC + WORM change log + clone-on-tenant-create), mirroring
    `HarnessPolicyService`;
  - rewire `ConsultationEventHandler.resolvePipelineConfig()` to resolve via the cascade (consultation metadata
    stays the top per-consultation override for back-compat);
  - thread `preferredPromptTemplateId` into the legacy auto path (`summary.processor.ts`,
    `consultation-event.handler.ts` legacy resolve) and (pending §12 Q4) the harness assemble
    (`harness-internal.service.ts`).
- **API:** a tenant/admin `PipelinePolicy` console controller (`admin/harness/pipeline-policy` or folded into the
  existing harness-policy surface — §12 Q5) with OCC (`@RequiresIfMatch()`), class-level
  `@Authorize(['manage','HarnessPolicy'])` (or a new subject — §12 Q6). Department/doctor override write routes
  are **read+write for tenant-admin/dept-head**; the doctor's *own* toggles route is deferred to Phase 6 unless
  §12 Q3 says otherwise.
- **UI:** extend the existing harness console (admin) with the realtime-toggle cascade editor. **No doctor-facing
  UI** (Phase 6).
- **Seed + clone:** seed a SYSTEM-tenant `PipelinePolicy` global-default row; seed the demo tenant's row with
  `harnessEnabled=true` to preserve the clinical-workspace demo; extend `provisionTenantModelCatalog` (or the
  tenant-create clone path) to clone the tenant policy row.

### Out of scope (hard boundaries — see §10)
- **SMR gateway model resolution / "no SMR default"** (Phase 3, D-7). Phase 5 *provides* the resolver; Phase 3
  *consumes* it for the SMR model. Sequencing in §10.
- **Doctor prompt CRUD routes + doctor UI + per-doctor DNA toggle + DNA edit-capture** (Phase 6, G-11/G-12).
  Phase 5 only *reads* the existing `UserProfile.preferredPromptTemplateId`; it adds no doctor-prompt write
  surface.
- **Gating / sensor thresholds / regen / safety / PHI** (`HarnessPolicy`, TASK-355/357/358/359). Untouched;
  Phase 5 must not let dept/doctor weaken these (max-scope = tenant).
- **`apps/harness/**`, `apps/smr/**`, sensors, the deterministic workflow body.** Threading the preferred id is
  resolved **API-side** (in `packages/applications`), with no harness DTO/contract or Python change (§3.4, §12 Q4).
- **`prompt-assembly.service.ts` / `prompt-resolution.service.ts` signature changes.** Both already accept
  `preferredPromptTemplateId` (§3.4); Phase 5 threads at the *call sites* only.

### Decisions applied (from README §7)
- **D-9 — Cascade depth:** `tenant → dept → doctor` for prompts + realtime summary/NER; `tenant (+global) only`
  for gating + safety. Phase 5 implements the realtime-summary/NER half.
- **AC-4 / cascade = `safety_tenant`:** each setting registers a max scope; safety/gating never weakened below
  tenant. The `ConfigResolver` enforces this centrally.
- **D-5 — Clone-per-tenant:** the new tenant policy row is cloned on tenant creation (+ backfill), like the rest
  of the catalog.

### Gaps addressed
- **G-10** — realtime toggles don't cascade; `harnessEnabled` hard-coded in UI. → §4 (cascade) + §4 (UI
  hard-code removal).
- **G-11 (partial)** — the legacy path doesn't thread the doctor-preferred id. → §4 (threading). *(The
  doctor-prompt **authoring** half of G-11 stays in Phase 6.)*

---

## 3. Current state (grounded — every claim cited `path:line`)

### 3.1 `resolvePipelineConfig()` reads consultation metadata ONLY (no cascade)
- `ConsultationEventHandler.resolvePipelineConfig()` is the single resolution point for the realtime toggles
  (`packages/applications/src/services/consultation/events/consultation-event.handler.ts:400-434`). Its own
  docstring states the precedence is **(1) consultation `metadata.pipelineConfig` → (2) `DEFAULT_PIPELINE_CONFIG`**
  (`consultation-event.handler.ts:393-396`) — there is **no tenant/department/doctor lookup**.
- It reads the consultation, pulls `metadata.pipelineConfig` (`:412-413`), and field-by-field falls back to
  `DEFAULT_PIPELINE_CONFIG` (`:415-420`); `harnessEnabled` is only carried through when explicitly present on the
  consultation metadata (`:423`). On a read miss / error it returns `{ ...DEFAULT_PIPELINE_CONFIG }`
  (`:408, :427, :434`).
- The interface + default themselves advertise a cascade that does not exist: `ConsultationPipelineConfig`'s
  comment says "per-consultation, per-department, or per-tenant control"
  (`consultation.events.ts:257-264`), and `DEFAULT_PIPELINE_CONFIG`'s comment says "Applied when no
  consultation/department/tenant override exists" (`consultation.events.ts:295`), but only the consultation tier is
  implemented. Defaults: `autoSummaryEnabled: true`, `autoNerEnabled: true` (`consultation.events.ts:297-301`);
  `harnessEnabled?: boolean` is optional with no default (`consultation.events.ts:290`).
- Consumers of the resolved config:
  - auto-summary gate — `if (!config.autoSummaryEnabled) return` (`consultation-event.handler.ts:108-110`);
  - harness-vs-legacy route — `if (config.harnessEnabled) { …harnessGatewayService.start… return }`
    (`consultation-event.handler.ts:123-159`, gateway call `:142-149`);
  - auto-NER gate — `if (!config.autoNerEnabled) return` (`consultation-event.handler.ts:266-268`);
  - summary-generated fan-out resolves with a fail-safe `.catch(() => DEFAULT_PIPELINE_CONFIG)`
    (`consultation-event.handler.ts:298`).

### 3.2 `harnessEnabled` is hard-coded `true` in the UI launch panel
- `apps/ui-playground/src/features/clinical-workspace/constants.ts:20-21` —
  `export const HARNESS_PIPELINE_METADATA = { pipelineConfig: { harnessEnabled: true } };`.
- Consumed when the clinical workspace opens a consultation:
  `apps/ui-playground/src/features/clinical-workspace/components/launch-panel.tsx:45` —
  `metadata: { ...HARNESS_PIPELINE_METADATA }` posted to `POST /consultations/open` (documented at
  `launch-panel.tsx:5`).
- Server side, that metadata is stored verbatim: `ConsultationController.open()`
  (`apps/api/src/modules/consultation/consultation.controller.ts:334-336`) →
  `ConsultationService.getOrCreate()` (`consultation/consultation.service.ts:98-153`), which passes
  `metadata: request.metadata` straight into `ConsultationFactory.CreateNewVisit(...)`
  (`consultation.service.ts:134`). So `harnessEnabled` is **entirely client-driven** today, and any consultation
  opened outside the clinical-workspace (no `HARNESS_PIPELINE_METADATA`) silently runs the **legacy** path.
- README confirms this is the intended gap to close: G-10 (`README.md:151`), §2.5 (`README.md:115`).

### 3.3 No persisted tenant/department/doctor realtime-toggle storage exists
- **Tenant realtime policy:** none. `HarnessPolicy` (`packages/database/src/prisma/db_main/harness.prisma:257-311`)
  holds gating thresholds, safety/PHI toggles, `smrModel/smrProvider`, gate SLAs, `maxRegen`, `toolAllowlist` — but
  **no** `autoSummaryEnabled` / `autoNerEnabled` / `harnessEnabled`.
- **Department:** `Department` (`packages/database/src/prisma/db_main/department.prisma`) has prompt-config fields
  (`defaultSummaryTemplate`, `preSummaryPromptId`, `newPatientPromptId`, `revisitPromptId`, `promptConfig` JSONB) —
  but **no** realtime toggle columns.
- **Doctor:** `UserProfile.preferredPromptTemplateId` exists (`user.prisma`) for the prompt tier; `UserSettings`
  is a generic key/value store — but there is **no** per-doctor realtime toggle.

### 3.4 Doctor-preferred prompt threading — actual state (⚠ contradicts README §2.5)
`PromptResolutionService` implements the 3-tier chain **doctor-preferred (`UserProfile.preferredPromptTemplateId`)
→ department → system default** (`prompt-resolution.service.ts:5-13`), accepts `preferredPromptTemplateId`
(`:82-85`), resolves it Tier-0 (`:119-191`, override at `:180-182`), and reports the tier on `resolvedFrom`
(`:48-56`). `PromptAssemblyService.assemble()` forwards `preferredPromptTemplateId` into it. The id is threaded on
some paths and dropped on others:

| Path | Threads `preferredPromptTemplateId`? | Evidence |
|---|---|---|
| **Synchronous REST** `SummaryService.generateSummary` / `generatePreSummary` | ✅ **Yes** | `summary.service.ts:106-112` + `:197-205` call `resolvePreferredPromptTemplateId(consultation.doctorId)`, which reads `UserProfile.preferredPromptTemplateId` (`summary.service.ts:741-746`) |
| **Legacy auto / realtime cascade** `ConsultationEventHandler` (resolve-for-job) | ❌ **No** | `consultation-event.handler.ts:164-167` calls `promptResolutionService.resolve({ departmentId, explicitTemplate })` — no preferred id |
| **Legacy auto / BullMQ worker** `SummaryProcessor` | ❌ **No** | `summary.processor.ts:84-86` (resolve) and `:127-134` (assemble) pass `departmentId` + `explicitTemplate` only |
| **Harness assemble callback** `HarnessInternalService.assemble` | ❌ **No** | `harness-internal.service.ts:198-210` passes `departmentId`, `explicitTemplate`, etc. — **no** `preferredPromptTemplateId`; the DTO has no such field (`harness/dto/harness-internal.dto.ts` `HarnessAssembleRequest`) |
| **Manual async** `PreSummaryProcessor` / `ComprehensiveSummaryProcessor` / `ChainSummaryService` | ❌ **No** | `pre-summary.processor.ts:106-112`, `comprehensive-summary.processor.ts:280-287`, `chain-summary.service.ts:446-453` |

> **⚠ Finding:** README §2.5 (`README.md:116`) states *"PromptTemplate resolution works (doctor-preferred id → …)
> on the harness path; the legacy BullMQ path doesn't thread the doctor-preferred id."* The code shows the
> **harness path ALSO drops the doctor-preferred id** (`harness-internal.service.ts:198-210`). The only place it is
> threaded is the **synchronous REST** path. This changes the scope of "(d) legacy-path threading" — see §12 Q4.

### 3.5 The cascade primitives already exist (to be generalized into `ConfigResolver`)
- **`HarnessPolicyService.getEffectivePolicy()`** — tenant own-row → SYSTEM-tenant default → code-default
  (`packages/applications/src/services/harness-policy/harness-policy.service.ts:127-138`). Gold-standard 2-level
  layering with WORM change log + OCC; README calls it "the only proper global-default → tenant-override resolver"
  (`README.md:97`).
- **`PromptResolutionService.resolve()`** — doctor-preferred → department → default
  (`prompt-resolution.service.ts:119-191`).
- **`UserPreferencesService`** — the Phase-4 precedent for a per-user server-side cascade
  (admin override → tenant default → global setting), e.g. `resolveEffectiveTranscriptionMode` /
  `resolveRemoteConfig` (`packages/applications/src/services/user/userPreferences/userPreferences.service.ts`).
- README §4.1 (`README.md:192`) explicitly frames the work as *generalizing* `getEffectivePolicy()` +
  `PromptResolutionService` into a `ConfigResolver` with a resolution trace + per-setting max scope.

### 3.6 `HarnessPolicy` shape to mirror for `PipelinePolicy`
- `HarnessPolicy` model (`harness.prisma:257-311`): meta (`_metadata`, `_version`, `id uuid(7)`), `tenantId`,
  business columns, standard resource-status + audit fields, `@@unique([tenantId])` (the system tenant's row is the
  global default), `@@schema("core")`.
- `HarnessPolicyChange` WORM companion (`harness.prisma:313-338`): identity-only (no `_version`/`_metadata`/
  `updatedAt`/`resourceStatus`), `tenantId`, `changedBy`, `policyVersion`, `beforeJson`/`afterJson`/`reason`,
  `createdAt`; migration REVOKEs UPDATE/DELETE on the application role; indexed on `tenantId` and
  `(tenantId, createdAt)`.
- Generated domain footprint per model (confirmed for HarnessPolicy):
  `entities/factories/models/mappers/repositories/generated/core/HarnessPolicy{,Change}*.ts` (10 files) + enum +
  barrels + `CoreDatabaseModule` registration. `HarnessPolicyFactory` seeds code-defaults
  (`HARNESS_POLICY_DEFAULTS`, `factories/generated/core/HarnessPolicyFactory.ts:18-35`).

### 3.7 Git / in-flight state (overlap inputs)
- `git status` working-tree modifications are all **Phase 2** (defaults wiring): `tenant.service.ts` + its tests,
  seed files (`06-stt.ts`, `11-global-setting.ts`, `91-user.ts`, `index.ts`, new `13-harness-policy.ts`),
  `seed.test.ts`, README, `.env.dev`. **None are Phase 5 files.**
- `prompt-assembly.service.ts` is **not** in the working-tree diff but is actively **co-owned by TASK-355**
  (live warm-start / `warmStartEnabled`, mirrored in `harness-internal.service.ts:191-196`). Phase 5 needs **no
  edit** to `prompt-assembly.service.ts` — the `preferredPromptTemplateId` param already exists; we thread it at
  call sites.
- `consultation.controller.ts` is **not** in the working-tree diff; it is heavily annotated for
  TASK-330/344/345/355 (`consultation.controller.ts:144-176`). Phase 5 should **not** need to touch it
  (`harnessEnabled` resolution moves server-side; the `open` route is unchanged).
- Consultation UI: `launch-panel.tsx` carries the `harnessEnabled` hard-code (§3.2); the broader clinical-workspace
  (`capture-panel.tsx`) is in Phase 4's UI scope — coordinate (§10).

---

## 4. File-by-file change plan (layer order: DB → Domain → Applications → API → UI → Seed)

> Order follows the layer dependency chain (`01-development-workflow.mdc`). Each step is RED-first (§8).

### 4.A — DB (additive; pending §12 Q1/Q2 sign-off)
1. **`packages/database/src/prisma/db_main/enums.prisma`** — add
   `enum PipelinePolicyScope { TENANT DEPARTMENT DOCTOR }` (`@@schema("core")`).
2. **`packages/database/src/prisma/db_main/harness.prisma`** (or a new `pipeline-policy.prisma`) — add
   `model PipelinePolicy` + `model PipelinePolicyChange` per the §5 schema. Standard field ordering
   (`02-database-prisma.mdc`), `@@schema("core")`, `@@unique([tenantId, scope, scopeId])`, indexes.
3. **Migration** — `npx prisma migrate dev --name create_pipeline_policy`; review SQL; add the WORM
   `REVOKE UPDATE, DELETE ... ON "core"."PipelinePolicyChange"` grant (copy the `HarnessPolicyChange` migration
   pattern). **No `DROP`/`DELETE`/`TRUNCATE`.**

### 4.B — Domain (generated; mirror `HarnessPolicy{,Change}`)
4. `entities/generated/core/PipelinePolicy{,Change}Entity.ts` — extend `BaseTenantEntity`; `validate()` enforces
   `scopeId` null⇔`scope=TENANT`, non-null otherwise.
5. `factories/generated/core/PipelinePolicy{,Change}Factory.ts` — `CreatePipelinePolicy()` with
   `PIPELINE_POLICY_DEFAULTS` (`autoSummaryEnabled: true`, `autoNerEnabled: true`, `harnessEnabled: false` —
   pending §12 Q7) mirroring `HARNESS_POLICY_DEFAULTS`.
6. `models/generated/core/PipelinePolicy{,Change}Model.ts`, `mappers/.../PipelinePolicy{,Change}EntityMapper.ts`,
   `repositories/.../PipelinePolicy{,Change}Repository.ts`.
7. `enums/generated/PipelinePolicyScope.ts` (+ `enums/index.ts`).
8. Barrels (`entities/factories/models/mappers/repositories/index.ts`) + register both repositories in
   **`CoreDatabaseModule`** providers + exports.

### 4.C — Applications (new resolver + service; rewire one method; thread preferred id)
9. **`packages/applications/src/services/config-resolver/config-resolver.service.ts`** (new) — generic
   `ConfigResolver`:
   - `resolve<T>(setting: SettingKey, ctx: { tenantId, departmentId?, doctorId? }): Promise<{ value: T; trace }>`;
   - walks `doctor → department → tenant → SYSTEM-tenant → code-default`, short-circuiting at the first defined
     value; clamps to the setting's **max scope** (a `SETTING_DESCRIPTORS` registry: `autoSummaryEnabled`/
     `autoNerEnabled` → `DOCTOR`; `harnessEnabled` → `TENANT` or `DEPARTMENT` per §12 Q7; gating/safety entries
     reserved for Phase 3 → `TENANT`);
   - returns a `resolutionTrace` (which tier supplied the value) for audit, matching the README §4.1 contract.
   - **Design note (Karpathy / no over-abstraction):** the resolver is backed initially by `PipelinePolicyService`
     for the three realtime settings; the descriptor registry is the seam Phase 3 plugs SMR-model resolution into
     later (§10). It is **not** a generic settings engine beyond the registered descriptors.
10. **`packages/applications/src/services/pipeline-policy/pipeline-policy.service.ts`** (new) — mirrors
    `HarnessPolicyService`: `getEffectivePolicy(ctx)` (delegates to `ConfigResolver`), `getRow(scope, scopeId)`,
    `upsert(...)` with OCC (`updateWithVersion`) + WORM `PipelinePolicyChange` append + `broadcastSysEvent`,
    `clonePolicyForTenant(...)`. Module `pipeline-policy.service.module.ts` + barrel + `IPipelinePolicyService`.
11. **`packages/applications/src/services/consultation/events/consultation-event.handler.ts`** — rewire
    `resolvePipelineConfig()` (`:400-434`): resolve the base config from `ConfigResolver`/`PipelinePolicyService`
    using `consultation.tenantId` + `consultation.departmentId` + `consultation.doctorId`, then **overlay** any
    explicit `metadata.pipelineConfig` values on top (per-consultation override preserved for back-compat — §12 Q7).
    Keep the fail-closed `.catch` behaviour. **No signature change**; consumers (`:110, :123, :268, :298`)
    unchanged.
12. **`consultation-event.handler.ts:163-167`** — pass `preferredPromptTemplateId` (loaded from the consultation's
    `doctorId` via `UserProfileRepository`, mirroring `summary.service.ts:741-746`) into
    `promptResolutionService.resolve(...)`.
13. **`packages/applications/src/services/consultation/jobs/processors/summary.processor.ts`** — load the
    consultation's doctor preferred id (the processor already has `consultation` at `:73`) and pass it to both
    `promptResolutionService.resolve(...)` (`:84-86`) and `promptAssemblyService.assemble(...)` (`:127-134`).
14. **(pending §12 Q4) `harness-internal.service.ts:198-210`** — load the doctor's preferred id (from
    `consultation.doctorId`) and add `preferredPromptTemplateId` to the `assemble(...)` call. **API-side only — no
    harness DTO / `apps/harness` change.**
15. **(pending §12 Q4) consistency follow-ups** — `pre-summary.processor.ts:106`,
    `comprehensive-summary.processor.ts:280`, `chain-summary.service.ts:446`. Recommend including
    `pre-summary.processor.ts` (single-doctor); `comprehensive`/`chain` are multi-consultation so "doctor-preferred"
    is ambiguous → default OUT unless Q4 says otherwise.

### 4.D — API (new admin console controller)
16. **`apps/api/src/modules/.../pipeline-policy-admin.controller.ts`** (new, or fold into the existing harness-policy
    controller — §12 Q5) — tenant/admin GET + PUT for the tenant row and dept/doctor override rows; OCC via
    `@RequiresIfMatch()`; class-level `@Authorize(['manage', <subject>])` (§12 Q6). Register the module in
    `app.module.ts`.

### 4.E — UI (admin console only — NO doctor UI)
17. Extend the existing **admin harness console** (`admin/harness/policy` surface referenced at `README.md:91`)
    with the realtime-toggle cascade editor (tenant defaults + dept/doctor override table). Reuse the admin OCC /
    If-Match patterns. *(Exact files to be enumerated against the admin-console feature folder during
    implementation; no doctor-workspace component is touched.)*
18. **`apps/ui-playground/src/features/clinical-workspace/constants.ts:20-21`** + **`launch-panel.tsx:45`** —
    remove the `HARNESS_PIPELINE_METADATA` hard-code so the open request no longer forces `harnessEnabled`; the
    server now resolves it (§4.C-11). *(Coordinate with Phase 4 / TASK-355 — §10.)*

### 4.F — Seed + clone
19. **`packages/database/src/prisma/db_main/seed/`** — new `NN-pipeline-policy.ts` (phase-1 alongside the new
    `13-harness-policy.ts`): SYSTEM-tenant `PipelinePolicy` global-default row + the **demo tenant**
    (`50000000-…`) tenant-scope row with `harnessEnabled=true` (preserves the clinical-workspace demo after the UI
    hard-code is removed — §3.2). Register in `seed/index.ts`; extend `seed.test.ts`.
20. **Clone-on-tenant-create** — extend the Phase-2 `provisionTenantModelCatalog` clone path (`tenant.service.ts`)
    or the tenant-create flow to clone the SYSTEM `PipelinePolicy` into the new tenant (D-5). Coordinate with the
    in-flight Phase-2 edits to `tenant.service.ts` (§10).

---

## 5. Schema / migration assessment — **one additive migration**

**Recommended design (single polymorphic table — §12 Q1/Q2):** mirror `HarnessPolicy`'s tenant-default pattern but
add a `scope`/`scopeId` discriminator so one table covers tenant + department + doctor overrides. Toggle columns
are **nullable** so a row overrides only what it sets (null ⇒ inherit from the next tier up).

```prisma
enum PipelinePolicyScope {
  TENANT
  DEPARTMENT
  DOCTOR

  @@schema("core")
}

model PipelinePolicy {
  // Meta fields (BaseEntity pattern) — `_version` is the OCC token.
  metaData Json?  @map("_metadata") @db.JsonB
  version  Int    @default(1) @map("_version")
  id       String @id @default(uuid(7))

  // Multi-tenant — system tenant owns the global-default (TENANT-scope) row.
  tenantId String

  // Scope discriminator: TENANT (scopeId null) | DEPARTMENT (departmentId) | DOCTOR (userId).
  scope   PipelinePolicyScope @default(TENANT)
  scopeId String?

  // Realtime toggles — NULLABLE so each row overrides only what it sets
  // (null => inherit from the next tier up; resolution lives in ConfigResolver).
  autoSummaryEnabled Boolean?
  autoNerEnabled     Boolean?
  harnessEnabled     Boolean?

  // Resource status + Audit (standard fields)
  resourceStatus          ResourceStatusType @default(ENABLED)
  resourceStatusUpdatedAt DateTime?
  resourceStatusUpdatedBy String?
  createdBy               String?  @default("60000000-0000-0000-0000-000000000000")
  updatedBy               String?
  createdAt               DateTime @default(now())
  updatedAt               DateTime @updatedAt

  // One row per (tenant, scope, scopeId). The (tenantId, TENANT, null) row is the
  // tenant default; the SYSTEM tenant's TENANT row is the platform default.
  @@unique([tenantId, scope, scopeId], name: "PipelinePolicy_tenant_scope_key")
  @@index([tenantId, scope], name: "PipelinePolicy_tenant_scope_idx")
  @@schema("core")
}

model PipelinePolicyChange {
  // Identity only — immutable (append-only). Migration REVOKEs UPDATE/DELETE.
  id String @id @default(uuid(7))

  tenantId String

  changedBy     String?
  policyVersion Int?

  beforeJson Json? @db.JsonB
  afterJson  Json  @db.JsonB
  reason     String? @db.Text

  createdAt DateTime @default(now())

  @@index([tenantId], name: "PipelinePolicyChange_tenantId_idx")
  @@index([tenantId, createdAt], name: "PipelinePolicyChange_tenant_createdAt_idx")
  @@schema("core")
}
```

- **Additive-only:** new enum + two new tables; **no changes** to `Department`/`UserProfile`/`Consultation`.
  Existing consultations keep working (the resolver returns code-defaults when no rows exist; per-consultation
  metadata still overlays on top).
- **Migration safety:** create-only DDL + a `REVOKE` on the WORM table; no destructive statements. Both `.prisma`
  + the generated `.sql` committed together (`02-database-prisma.mdc`).
- **Downstream regeneration (required):** the full domain stack for both models + the enum + barrels +
  `CoreDatabaseModule` (§4.B), per `02-database-prisma.mdc` "After Schema Changes."
- **Alternative considered (§12 Q1/Q2):** (B) nullable toggle columns on `Department` + per-doctor `UserSettings`
  rows + a tenant-only `PipelinePolicy` — fewer new tables but spreads the cascade across three storages and is not
  additive on `Department`. The single polymorphic table is recommended for a uniform resolver + one WORM audit.

---

## 6. Clone-per-tenant propagation design

- **New tenants (D-5):** on tenant creation, clone the SYSTEM-tenant `PipelinePolicy` (TENANT scope) into the new
  tenant — extend the Phase-2 `provisionTenantModelCatalog` clone path (`tenant.service.ts`). Department/doctor
  override rows are **not** cloned (they are created on demand when an admin sets an override).
- **Existing tenants (backfill):** none required at the DB level — `ConfigResolver` falls through a missing tenant
  row to the SYSTEM default → code-default, so existing tenants resolve to the platform default immediately. The
  seed creates the SYSTEM row; the demo tenant gets an explicit `harnessEnabled=true` row to preserve current
  behaviour (§3.2).
- **`HarnessPolicy` parallel:** this mirrors the Phase-2 `HarnessPolicy` SYSTEM-row + clone approach exactly, so
  the two policy tables propagate identically.

---

## 7. Authorization / safety posture
- **Max-scope enforcement (AC-4, R-3, `safety_tenant`):** the `ConfigResolver` clamps every setting to its
  registered max scope. `autoSummaryEnabled`/`autoNerEnabled` allow up to DOCTOR; `harnessEnabled` allows up to
  TENANT/DEPARTMENT (§12 Q7) — **never doctor-weakened**; gating/safety descriptors (reserved for Phase 3) are
  TENANT-only. A dept/doctor row attempting an out-of-scope setting is ignored by the resolver (and rejected at the
  write route).
- **Admin writes:** tenant-policy + dept/doctor-override writes are tenant-admin/dept-head only, OCC-guarded
  (`@RequiresIfMatch()`), audited via WORM `PipelinePolicyChange` + `broadcastSysEvent` (AC-2), mirroring
  `HarnessPolicyService`.
- **No PHI:** `PipelinePolicy` rows are pure config (booleans + ids); no PHI enters the table, the change log, or
  the SSE/audit events.
- **Fail-closed:** `resolvePipelineConfig()` keeps its `.catch(() => DEFAULT_PIPELINE_CONFIG)`
  (`consultation-event.handler.ts:298`) so a resolver/DB error degrades to safe code-defaults, never throwing on the
  realtime path.
- **Replay safety (R-2):** Phase 5 changes only *selection/policy*, not the deterministic harness workflow body;
  `harnessEnabled` is resolved at consultation-open/event time, upstream of the durable workflow.

---

## 8. TDD test list (RED-first), per layer

### Domain (Vitest) — `pnpm test:unit --filter @arcaai/domains`
- `PipelinePolicyFactory.CreatePipelinePolicy` applies `PIPELINE_POLICY_DEFAULTS` when knobs omitted; generates
  uuid(7); sets timestamps.
- `PipelinePolicyEntity.validate()` — TENANT scope ⇒ `scopeId` null; DEPARTMENT/DOCTOR ⇒ `scopeId` required (throws
  otherwise).
- Mapper round-trips nullable toggles (null preserved, not coerced to false).

### Applications (Vitest) — `pnpm test:unit --filter @arcaai/applications`
- **`ConfigResolver`:**
  - returns code-default when no rows exist; trace = `default`.
  - tenant row overrides default; dept row overrides tenant; doctor row overrides dept (trace reports the winning
    tier).
  - **max-scope clamp:** a DOCTOR row for a TENANT-max setting (e.g. `harnessEnabled` if Q7 = tenant-only) is
    ignored; resolution stops at tenant.
  - SYSTEM-tenant row acts as platform default below an absent tenant row.
- **`PipelinePolicyService`:** upsert bumps `_version` (OCC); stale `expectedVersion` throws; a
  `PipelinePolicyChange` row is appended with before/after; `broadcastSysEvent` fired.
- **`resolvePipelineConfig()` (rewired):**
  - with no policy rows + no consultation metadata ⇒ `DEFAULT_PIPELINE_CONFIG` (back-compat).
  - tenant policy `autoSummaryEnabled=false` ⇒ resolved config disables auto-summary (extends the existing suite at
    `consultation-event.handler.test.ts:657-730`).
  - department override beats tenant; doctor override beats department.
  - **per-consultation overlay:** explicit `metadata.pipelineConfig.autoSummaryEnabled=false` still wins over a
    tenant `true` (preserves `consultation-event.handler.test.ts:229-235`).
  - **`harnessEnabled` routing via cascade:** tenant policy `harnessEnabled=true` (no metadata) routes to
    `HarnessGatewayService.start` (re-expresses `consultation-event.handler.test.ts:952-1035` without the metadata
    hard-code); resolver default `false` keeps the legacy path; auto-summary off ⇒ no harness even if
    `harnessEnabled=true`.
- **Preferred-prompt threading:**
  - `SummaryProcessor` passes the doctor's `preferredPromptTemplateId` into resolve/assemble; `resolvedFrom` =
    `preferred` when the doctor has one (new test in the processor suite).
  - `ConsultationEventHandler` legacy resolve (`:164`) includes the preferred id (extends the GAP-3 suite at
    `consultation-event.handler.test.ts:317-380`).
  - *(pending Q4)* `HarnessInternalService.assemble` threads the preferred id.

### API (Vitest) — `apps/api` unit
- `pipeline-policy-admin.controller` GET returns the effective cascade + trace; PUT enforces If-Match (412 on
  mismatch); non-admin → 403; dept/doctor out-of-max-scope write → 400.

### Seed (TS) — `pnpm --filter @arcaai/database test`
- `seed.test.ts` asserts the SYSTEM `PipelinePolicy` global-default row exists and the demo-tenant row has
  `harnessEnabled=true`.

### UI (clinical-workspace) — type-check / existing suite
- Removing `HARNESS_PIPELINE_METADATA` does not break the open flow (the open request omits `harnessEnabled`; server
  resolves it). Guard the demo path with the seeded demo-tenant policy.

---

## 9. Verification gates (layer gates)
- **DB:** `pnpm db:migrate` + `pnpm db:generate`; review the generated SQL (create-only + WORM REVOKE; no
  destructive DDL).
- **Domain:** `pnpm build --filter @arcaai/domains` + `pnpm test:unit --filter @arcaai/domains`.
- **Applications:** `pnpm build --filter @arcaai/applications` + `pnpm test:unit --filter @arcaai/applications`
  (new `ConfigResolver` + `PipelinePolicyService` suites green; existing
  `consultation-event.handler.test.ts` green/extended).
- **API:** `pnpm build:api` + unit tests for the new controller; `pnpm test:e2e` for the admin policy round-trip.
- **UI:** type-check + the clinical-workspace open flow still launches the harness for the demo tenant.
- **Lint:** `ReadLints` on every modified/created file; no new errors.
- **Evidence:** paste actual test/build output into README §8 (Phase 5 Implementation Summary) on completion.

---

## 10. Overlap boundaries (CRITICAL)

| Area | Owner | Phase 5 stance |
|---|---|---|
| **`prompt-assembly.service.ts`** | TASK-355 (warm-start) | **Do NOT edit.** Param `preferredPromptTemplateId` already exists; thread at call sites only (`summary.processor.ts`, `consultation-event.handler.ts`, `harness-internal.service.ts`). |
| **`prompt-resolution.service.ts`** | shared | **Do NOT change signatures.** 3-tier resolver already supports the preferred id (`:82-85,:119-191`). |
| **`consultation.controller.ts`** | TASK-330/344/345/355 | **No edit expected.** `harnessEnabled` resolution moves server-side; the `open` route is unchanged. Flag if a route change becomes necessary. |
| **`harness-internal.service.ts`** | TASK-355 (warm-start at `:191-196`) | Phase 5 adds **one line** (`preferredPromptTemplateId`) to the existing `assemble()` call (§4.C-14) **pending Q4**; coordinate to avoid colliding with the warm-start block. **No** harness DTO / `apps/harness` change. |
| **`tenant.service.ts`** | **Phase 2 (in-flight, modified in working tree)** | Phase 5 *extends* the clone path for `PipelinePolicy`. **Land after Phase 2 merges** to avoid a clone-path collision. |
| **Clinical-workspace UI (`launch-panel.tsx`, `capture-panel.tsx`)** | Phase 4 (audio console) + TASK-355 | Phase 5 removes only the `harnessEnabled` hard-code in `constants.ts`/`launch-panel.tsx`. Coordinate with Phase 4's UI edits to `capture-panel.tsx`. |
| **Phase 3 — SMR gateway model resolution (D-7)** | Phase 3 | **Seam:** Phase 5 ships the generic `ConfigResolver` + max-scope registry; Phase 3 registers an `smrModel` descriptor (max scope TENANT, backed by `HarnessPolicy.smrModel`) and resolves through it — it does **not** need a new table. **Sequencing:** Phase 5 lands the resolver first; Phase 3 consumes it. If Phase 3 ships first, it keeps using `HarnessPolicyService.getEffectivePolicy()` directly and Phase 5 later wraps it. See §12 Q5. |
| **Phase 6 — Doctor self-service + DNA** | Phase 6 | **Seam:** Phase 5 **reads** `UserProfile.preferredPromptTemplateId` and the doctor-scope `PipelinePolicy` rows (resolution/threading). Phase 6 **writes** them via doctor-facing routes/UI + DNA toggle/capture. Phase 5 adds **no** doctor-prompt CRUD and **no** doctor UI. The doctor's *own* realtime-toggle write route is Phase 6 unless §12 Q3 pulls it forward. |
| **TASK-355/357/358/359** | those tickets | Gating/latency/PHI/sensors untouched; `HarnessPolicy` thresholds/safety unchanged. |

**Doc-only discipline:** Phase 5 writes **only** this plan doc. No README/other-doc/code edits, no git commit, in
this planning step.

---

## 11. Risks
- **R-A — `harnessEnabled` back-compat regression:** removing the UI hard-code while the resolver default is
  `false` would silently disable the harness for the clinical-workspace demo. **Mitigation:** seed the demo-tenant
  `PipelinePolicy` row with `harnessEnabled=true` **and** keep per-consultation `metadata.pipelineConfig` as the
  top overlay (§4.C-11). Land the seed + resolver rewire + UI change **together**.
- **R-B — README §2.5 inaccuracy (harness preferred-id):** the harness path is documented as threading the
  preferred id but does not (§3.4). If Q4 says "thread it everywhere", scope grows by one call site
  (`harness-internal.service.ts`) — small, API-side only, but must dodge the TASK-355 warm-start block.
- **R-C — Domain regeneration footprint:** two new models ⇒ ~10 generated files + enum + barrels +
  `CoreDatabaseModule`. Mechanical but easy to under-wire (missing barrel/registration → runtime DI failure). Gate
  with the domain build.
- **R-D — `tenant.service.ts` clone-path collision** with in-flight Phase 2. **Mitigation:** sequence after Phase 2
  (§10).
- **R-E — Over-generalization (Karpathy):** building `ConfigResolver` as a giant generic engine. **Mitigation:**
  scope it to the registered descriptors (3 realtime settings now; SMR/gating reserved seams), not arbitrary
  settings.
- **R-F — Cascade read cost on the realtime path:** `resolvePipelineConfig()` runs per transcription event; adding
  policy lookups adds queries. **Mitigation:** single indexed lookup per scope (or one `WHERE tenantId AND scope IN
  (...)` query), keep the fail-closed `.catch`, consider a short request-scoped cache if profiling warrants
  (not in initial scope).

---

## 12. Blocking questions (raise — do not guess)

1. **`PipelinePolicy` — new table vs. extend existing?** Recommended: **one new polymorphic table**
   (`scope`/`scopeId`) + WORM companion, mirroring `HarnessPolicy` (§5). Alternative (B): nullable toggle columns on
   `Department` + per-doctor `UserSettings` + tenant-only `PipelinePolicy`. **Confirm the single-table design.**
2. **Override storage for dept/doctor — same table or `Department`/`UserProfile` columns?** Recommended: the single
   polymorphic table (no schema change to `Department`/`UserProfile`). Confirm we are **not** adding toggle columns
   to `Department`.
3. **Doctor's own realtime toggles — Phase 5 or Phase 6?** Recommended: Phase 5 ships the **resolution + admin
   (tenant/dept) write routes**; the **doctor self-service** toggle route lands in Phase 6 alongside the doctor
   prompt/DNA self-service UI. Confirm the split (avoids two phases building doctor write routes).
4. **Preferred-prompt threading scope (given §3.4):** the README says "legacy path", but the **harness path also
   drops** the preferred id, and only the synchronous REST path threads it. Which paths should Phase 5 thread?
   Recommended: **legacy auto (`summary.processor.ts` + event-handler resolve)** + **harness assemble
   (`harness-internal.service.ts`, API-side only)** + **`pre-summary.processor.ts`**; leave
   `comprehensive`/`chain` (multi-consultation, ambiguous "doctor"). Confirm — especially whether the harness path is
   in-scope here or owned by a harness ticket.
5. **Reuse Phase 3's resolver, or Phase 3 reuses Phase 5's?** Recommended: **Phase 5 owns the generic
   `ConfigResolver`; Phase 3 registers an `smrModel` descriptor and consumes it** (no new table; `HarnessPolicy`
   stays the SMR store). Confirm sequencing (Phase 5 resolver first) and whether `PipelinePolicy` admin lives on a
   **new** `admin/harness/pipeline-policy` surface or **folds into** the existing `admin/harness/policy` controller.
6. **Authz subject for the new policy:** reuse `manage HarnessPolicy`, or introduce a new CASL subject
   (e.g. `PipelinePolicy`)? Recommended: a **new subject** for clean separation of realtime-toggle admin from gating
   admin. Confirm.
7. **`harnessEnabled` replacement — max scope + back-compat default.** Recommended: max scope **TENANT (optionally
   DEPARTMENT)**, **not doctor** (rollout decision, not a clinician preference); platform/code default **`false`**;
   per-consultation `metadata.pipelineConfig.harnessEnabled` kept as the **top overlay**; demo tenant seeded
   `true`. Confirm the default + whether department may override.
8. **Scope of "summary/NER" config knobs.** Recommended: exactly **`autoSummaryEnabled`, `autoNerEnabled`,
   `harnessEnabled`** cascade in Phase 5. `dnaStyleId` / `summaryTemplate` / `includeSharedContext` /
   `haltOnFailure` stay consultation-scoped (per-request) as today. Confirm nothing else is expected to cascade.

---

### Report-back appendix (for the requester)

- **Doc created:** `docs/implementation/TASK-356-Admin-Managed-Models-Workflows/phase-5-realtime-cascade-plan.md`
  (this file) — **only** this doc; no code, no other docs, no git commit.
- **Outline:** §1 Purpose · §2 Scope & decisions · §3 Current state (grounded) · §4 File-by-file plan · §5
  Schema/migration · §6 Clone-per-tenant · §7 Auth/safety · §8 TDD (RED-first) · §9 Verification · §10 Overlap ·
  §11 Risks · §12 Blocking questions.
- **Key finding:** README §2.5 (`README.md:116`) is inaccurate — the **harness path also drops** the
  doctor-preferred id (`harness-internal.service.ts:198-210`); only the synchronous REST `SummaryService` threads it
  (§3.4). This reshapes scope item (d) → see Q4.
- **Proposed additive schema:** `PipelinePolicy` + `PipelinePolicyChange` (+ `PipelinePolicyScope` enum), single
  polymorphic table mirroring `HarnessPolicy` (§5) — **additive only**, no changes to existing tables.
