# TASK-733 — Per-Department Workflow Assignment + Personalization Re-Enable

| | |
|---|---|
| **Status** | In Progress — Phase A (half (a)) backend COMPLETE; Task 6 (screen) blocked on the design gate; Phase B remains HARD-GATED |
| **Wave** | 4 · **Size** | M |
| **Epic slug** | `department-assignment-personalization` |
| **Depends on** | TASK-700 (`dna-phi-containment`) — **half (b) is HARD-GATED on its decrypt-and-scan returning clean AND its containment tasks having shipped**; TASK-731 (`palette-consultation`) — half (a) assigns consultation workflow definitions, which must exist first. Soft: TASK-710 (`phi-redactor`) hop 2, TASK-718 (`workflow-interpreter`) dispatcher, TASK-719 (`workflow-studio-v1`) for the screen. |
| **Design refs** | Roadmap Wave 4 — *"per-department workflow assignment + personalization (DNA, post-containment only)"*; Plane 1 §Data flow §Execution (*"dispatcher resolves the tenant's active published version — or the platform default config"*); Plane 3 (*"department-agent and pipeline-policy fold into the Studio"*); §Deprecations (scattered admin screens → Studio) |
| **Findings closed** | Half (b) closes the **remaining** half of A-06 (`02-conformance-matrix.md`, CRITICAL) — the governance and re-derivation half that TASK-700's forward-going containment does not reach — and closes the **ungated second injection path** discovered here (§2.7, not previously adjudicated). Half (a) closes no assessment finding; it is net-new Wave-4 capability. |

---

## 1. Requirement Analysis

Two halves that share a ticket because they share one seam — the point where a consultation resolves
*which* configuration governs it.

### 1.1 Half (a) — per-department workflow assignment

TASK-715 makes `WorkflowDefinition` **tenant-scoped**, with at most one `isActive` row per
`(tenantId, slug)`. TASK-731 puts the consultation palette on it. TASK-718 Task 10 + TASK-731 Task 13
make `NoteGenerationService` the dispatcher that resolves the active version at run start.

A tenant with a Radiology department and a Cardiology department cannot express that they document
differently. `Consultation` already carries `departmentId` and `DepartmentAgent` is already a
per-department configuration object — the platform models departments everywhere **except** at the
workflow-selection point.

This half adds:

1. A department→workflow **assignment** (not a department-scoped definition — §1.3),
2. a **resolution order** — `department override → tenant default → platform default` — implemented
   with the repo's existing cascade primitive, not a new one,
3. wiring at the TASK-704/TASK-731 dispatcher seam,
4. an **assignment matrix** screen in the Workflow Studio,
5. **audit on every assignment change**, following the `PipelinePolicyChange` WORM precedent.

### 1.2 Half (b) — personalization re-enable

The writing-DNA feature is the assessment's §3.2 / A-06 finding: *"up to 50 approved clinical notes
are rendered twice each, concatenated to 100,000 characters, sent to an LLM under a prompt that asks
for 'common phrases' and forbids nothing, and the unvalidated response is persisted and later
appended verbatim to the system prompt for whatever patient is summarized next."* Confirmed, and
**enabled in the seeded production tenant**.

TASK-700 fixes the forward-going path (output schema, hard-fail parser, opt-out gate ordering) and
authors — but does not run — the decrypt-and-scan that decides latent-gap vs. live incident.
TASK-710 adds full redaction on the corpus hop.

**Neither of them re-enables the feature safely, because three things are still missing:**

| Missing | Why it matters |
|---|---|
| **A per-clinician, node-level opt-in on the synthesis node** | Today the toggle is a `PipelinePolicy` row read by a config resolver. Post-TASK-731 the synthesis step is an authorable node, and "apply this clinician's style" is a property of that node. Without it, DNA application is invisible in the authored graph — the thing the whole substrate exists to make visible. |
| **A governance surface** | Verified: **no route and no service method deletes or resets a style profile.** Zero `@Delete` decorators in either DNA controller; no `delete`/`reset`/`purge` method on the service. INV-240 requires personalization be *"opt-in, reversible, exportable, and **deletable** by the clinician"*. Reset does not exist. |
| **A re-derivation path for pre-containment profiles** | Every profile generated before TASK-700 was produced by the unconstrained prompt and stored by the fall-back-to-raw parser. Fixing the generator does not fix rows already written. |

Plus one finding this ticket surfaces that neither prior ticket covers: **a second injection path
that bypasses the opt-in gate entirely** (§2.7).

### 1.3 Why assignment is a separate row, not a column on `WorkflowDefinition`

Three options were weighed:

| Option | Verdict |
|---|---|
| Add `departmentId` to `WorkflowDefinition` | **Rejected.** It conflates *what a workflow is* with *who uses it*. A definition would need one row per department, defeating `(tenantId, slug, versionNumber)` lineage, and a department reassignment would become a definition edit — losing the immutability of published rows that TASK-715 §1 is built on. |
| Reuse `PipelinePolicy` (`scope`, `scopeId`) by adding a `workflowDefinitionSlug` column | **Rejected.** `PipelinePolicy` holds nullable *toggles* resolved by `ConfigResolver`; a workflow slug is a reference, not a toggle, and it needs its own referential validation and its own audit semantics. |
| **A dedicated assignment row, shaped like `PipelinePolicy` and resolved with the same cascade primitive** | **Adopted.** `(tenantId, scope, scopeId, paletteKey) → workflowDefinitionSlug`, resolved with `walkCascade` from `settings-registry/scope-cascade` — the same function `ConfigResolver.resolveOne` already uses. One shape, one resolution semantics, one audit pattern. |

### 1.4 Explicitly OUT of scope

- **Any change to `WorkflowDefinition`, the compiler/validator, the interpreter, or the palette.**
- **Doctor-scoped workflow assignment.** The cascade supports it structurally; this ticket exposes
  department and tenant only. A per-doctor *workflow* (as opposed to a per-doctor *style*) is a
  product decision nobody has made.
- **Building the redactor** (TASK-710) or **the containment fixes** (TASK-700). This ticket
  *consumes* both and fails its gate if either is absent.
- **Running TASK-700's decrypt-and-scan.** That remains TASK-700 Task 6, HUMAN-GATED there.
- **Consent-revocation erasure cascade** (A-10 / INV-170 — scrubbing a patient's contributions from
  the exemplar bank). It needs `PatientConsent` (TASK-712) and a `retention-erasure` epic that is
  not in this program's backlog. The *clinician-initiated* reset this ticket builds is a different,
  narrower thing and must not be described as satisfying INV-170.
- **Per-section style application.** No `NoteSection` model exists.

---

## 2. Current State Evaluation

Verified against the live tree on `feat/loop` (2026-08-16). Exclusions applied:
`.claude/worktrees/**`, `**/dist/**`, `**/node_modules/**`, `**/.venv/**`, `**/__pycache__/**`,
`**/.next/**`, `docs/archive/**`.

### 2.1 Department and DepartmentAgent — verified shape

**`Department`** — `packages/database/src/prisma/db_main/department.prisma:4-55`. Standard field
template (`metaData` `:6`, `version` `:7`, `id` `:8`, `tenantId` `:11`). Business fields: `code`
`:14`, `name` `:15`, `description` `:16`. Prompt config: `defaultSummaryTemplate` `:20`,
`preSummaryPromptId` `:21`, `newPatientPromptId` `:22`, `revisitPromptId` `:23`,
**`dnaWritingStylePromptId` `:24`** (a loose reference, no FK), `promptConfig Json? @db.JsonB` `:25`.
Self-hierarchy `parentDepartmentId` `:28` + relations `:29-30`. Relations: `Consultations` `:42`,
`PromptTemplates` `:43`, `UserDepartments` `:44`, `DepartmentAgents` `:45`,
`ConsultationContextSchemas` `:47`. `@@unique([tenantId, code])` `:50`.

**There is no workflow, pipeline or policy column on `Department`.**

**`DepartmentAgent`** — `department-agent.prisma:22-148`. `departmentId String` `:32` with a
**required, non-nullable** relation `:33`. Binding: `promptTemplateId` `:39` + FK `:40`,
`pinnedVersionNumber Int?` `:41` (null ⇒ track latest APPROVED),
**`dnaStylePolicy DepartmentAgentDnaPolicy @default(INHERIT)` `:42`** (INHERIT | DISABLED),
`harnessOverrides Json?` `:43`, `goldenSetId String?` `:44`. Capability bindings `:58-61`.
`toolConfig` `:67`, `llmOverrides` `:74`, `isDefault` `:77`, lineage `:80-81`. Loop config:
`role` `:89`, `subscribedKinds` `:96`, **`writeScope Json?` `:100`**, `goal` `:106`,
`guardrailProfile` `:112`, `alwaysActions`/`neverActions` `:117-118`. `Versions` `:121`.
`@@unique([tenantId, departmentId, slug])` `:138`; index `(tenantId, departmentId, isDefault)` `:146`.
Siblings: `DepartmentAgentVersion` `:161-198` (immutable snapshot, `configSnapshot Json` `:181`,
`checksum` `:185`, `@@unique([agentId, versionNumber])` `:194`), `AgentPromotion` `:220-282`.

**`Consultation` DOES carry `departmentId`** — `consultation.prisma:22-23` (`String?`, nullable),
with `@@index([tenantId, departmentId])` at `:62`.

**There is NO `Consultation` → `DepartmentAgent` relation.** The agent is resolved by
`(tenantId, departmentId, isDefault)` lookup. **This is the precedent half (a) follows** — a
department-scoped default selected at dispatch time, not an FK on the consultation row.

**`writeScope` validation** — `writeScopeProblems(value)` at
`packages/applications/src/services/departmentAgent/constants.ts:242-277`: `version` must be `1`
(`:246-249`), unknown top-level keys rejected (`:251-254`), `outputs` must be an array
(`:258-262`), each entry matches `AGENT_KIND_KEY_PATTERN` with duplicates rejected (`:266-273`).
Cross-checked against the department's published context-schema outputs in
`departmentAgent.service.ts:769-789` (`validateWriteScope`): `writeScopeProblems` at `:772`,
`resolveServableContextDefinition(tenantId, departmentId)` at `:778`, `undefined` ⇒ repositories
unwired ⇒ cross-check **skipped** (`:779`), `null` ⇒ 400 (`:780-784`), unknown outputs ⇒ 400
(`:785-788`). `resolveServableContextDefinition` (`:828-847`) itself cascades
**DEPARTMENT-scoped default → TENANT-scoped default** (`findDefaultForScope`, `:838-841`) — a
second in-repo precedent for exactly the resolution order half (a) needs.

Other `writeScopeProblems` call sites (all must keep working): `agent-template-resync.service.ts:517`,
`consultation/loop/loop-config.service.ts:95`, `agentPromotion/agentPromotion.service.ts:404`.

### 2.2 The existing per-department policy surface — and what it is not

`PipelinePolicy` — `packages/database/src/prisma/db_main/pipeline-policy.prisma:28-70`:
`scope PipelinePolicyScope @default(TENANT)` `:40`, `scopeId String?` `:41` (header comment
`:37-39`: DEPARTMENT ⇒ `scopeId = departmentId`), nullable toggles `autoSummaryEnabled` `:48`,
`autoNerEnabled` `:49`, `harnessEnabled` `:50`, `dnaStyleEnabled` `:51`, `dnaRedactionEnabled` `:53`,
`@@unique([tenantId, scope, scopeId])` `:67`, plus a **WORM change log `PipelinePolicyChange`**
(`:72+`). Enum member: `enums.prisma:401` — `DEPARTMENT // Per-department override (scopeId = departmentId)`.

**What is verified absent:** `AsrPipeline` (`stt.prisma:12-69`) is tenant-scoped only
(`@@unique([tenantId, slug])` `:61`) — **no `departmentId`**. A grep for `departmentId` across every
pipeline/workflow/ASR model returns only the `pipeline-policy.prisma:37` comment. The models
carrying a `Department` relation are exactly: `Consultation`, `ConsultationContextSchema`,
`DepartmentAgent`, `PromptTemplate`, `UserDepartment`, and `Department` itself.

So: **department-scoped *toggles* exist; department-scoped *workflow selection* does not.**

### 2.3 The cascade primitive half (a) must reuse verbatim

`packages/applications/src/services/config-resolver/config-resolver.service.ts`:

- Declared order, header `:6-17`, line `:10`:
  `doctor → department → tenant → SYSTEM-tenant default → code default`
- `export type ConfigResolutionSource = 'doctor' | 'department' | 'tenant' | 'system-default' | 'code-default'` — `:23`
- Descriptor map `:77-85`, e.g. `harnessEnabled: { codeDefault: false, maxScope: PipelinePolicyScope.DEPARTMENT }` `:80`,
  `dnaStyleEnabled: { codeDefault: false, maxScope: PipelinePolicyScope.DOCTOR }` `:81`
- `resolveOne` `:286-311` builds the tier list — doctor `:300-302`, department `:303-305`, tenant
  `:306`, system-default `:307` — then `return walkCascade(tiers, codeDefault)` at `:309`
- `walkCascade` / `CascadeTier` imported from `../settings-registry/scope-cascade` at `:3`

**`walkCascade` is the primitive. Half (a) calls it with a three-tier list; it does not implement a
fourth cascade.**

### 2.4 What TASK-715/718/731 hand this ticket

- `WorkflowDefinition` is tenant-scoped with `slug` lineage, `paletteKey`, and `isActive` —
  *"the movable pointer: the version the dispatcher resolves for new runs. At most one true per
  `(tenantId, slug)` among ENABLED rows — enforced in the application service, mirroring
  `ConsultationContextSchema.isDefault` and **`DepartmentAgent.isDefault`**"* (TASK-715 Task 1). The
  ticket's own model already names `DepartmentAgent.isDefault` as its precedent.
- Platform default definitions are SYSTEM-tenant `PUBLISHED` + `isActive` rows, one per palette
  (TASK-715 Task); TASK-731 Task 14 seeds the consultation one.
- The dispatcher is `NoteGenerationService` (TASK-704) calling
  `POST /api/v1/internal/workflow-runs:start` (TASK-718 Task 10), wired for the consultation palette
  by TASK-731 Task 13 — which explicitly defers department resolution to **this** ticket.

### 2.5 DNA — the data model

`packages/database/src/prisma/db_main/dna-writing-style.prisma:6-55`. `doctorId` `:16` + relation
`:17` (back-ref `user.prisma:101`). Encrypted (Vault-Transit ciphertext, `Bytes?`, plaintext columns
**dropped** per the comment at `:19-24`): `encryptedReportData` `:25`, `encryptedStyleText` `:26`,
`encryptedRedactionRules` `:31`, `keyVersion` `:32`. `isLatest Boolean @default(true)` `:35`,
`currentVersionNumber` `:36`. `DnaWritingStyleVersion` `:57-96` with `@@unique([dnaReportId, versionNumber])` `:92`.
`DnaUsageRecord` `:103-128` carries `departmentId String?` `:117`.

**No unique constraint exists on `DnaWritingStyleReport`** — only three indexes (`tenantId` `:51`,
`doctorId` `:52`, `(doctorId, isLatest)` `:53`). "One latest report per doctor" is enforced **only in
application code**, where the processor flips the previous latest (`dna-writing-style.processor.ts:281-284`).
A concurrent generate can therefore produce two `isLatest = true` rows, and `getEffectiveStyleText`
resolves "the latest" from an ordering, not a constraint. Relevant to half (b)'s reset semantics.

### 2.6 DNA — the service surface, and the hole in it

`packages/applications/src/services/dna-writing-style/` contains `IDnaWritingStyleService.ts`,
`dna-writing-style.service.ts`, `.processor.ts`, `.dto.mapper.ts`, `.service.module.ts`,
`dna-regeneration.scheduler.ts`, `redaction-rules.ts`, `dto/` (7 files), `__tests__/` (8 files).

Processor: `buildCorpus` `:305-313` (renders each encounter as an `AI DRAFT:` → `DOCTOR APPROVED:`
pair — two full PHI-bearing renderings per patient), called at `:174`; `maxContextChars` default
`100_000` in `CONTEXT_DEFAULTS` `:33`, read at `:93`, truncation at `:177-179`; the opt-in gate
`resolveEffectiveDnaStyleEnabled` at `:117-125` — **only in the automatic `else` branch**, bypassed
by `textSamples` at `:105-111` (TASK-700 Task 4 moves it); the parser fallback at `:197-203` where
`catch { styleText = smrResponse.content; }` stores raw model output verbatim (TASK-700 Task 3 hard-fails it).

Service public methods (`dna-writing-style.service.ts`): `generateDnaReport` `:112`, `getDnaReport`
`:154`, `getRedactionRules` `:174`, **`getEffectiveStyleText(doctorId, explicitTenantId?)` `:202-230`**
(tenant resolution `:213-216`, `assertUserBelongsToTenant` `:217`, **gate**
`if (!settings.effective) return null` `:222-225`, `findLatestForDoctor` + decrypt `:227-229`),
`getDnaSettings` `:280`, `setDnaEnabled` `:299`, `updateDnaReport` `:330`, `setDefaultReport` `:429`,
`getVersions` `:468`, `getVersionsForDoctor` `:480`, `listReports` `:517`, `listReportsPaginated`
`:546`, `getDashboard` `:578`.

> **Verified absent: there is no `deleteReport`, `resetDnaProfile`, or `purge` method on the service
> or its interface, and zero `@Delete` decorators in either DNA controller.** The closest thing to a
> reset is `PATCH :reportId` overwriting `styleText`. **INV-240 requires personalization be
> "deletable by the clinician." It is not.**

Routes that DO exist —
`apps/api/src/modules/dna-writing-style/dna-writing-style.controller.ts` (base `dna-writing-styles`
`:49`, class `@Authorize()` `:50`, doctor gate `assertActingAsDoctor()` `:77-88`, role constants
`DNA_ADMIN_ROLES` `:34` / `DNA_DOCTOR_ROLES` `:35`): `POST /generate` `:90-100`,
`GET /my-style` `:102-113`, `GET /my-style/redaction-rules` `:119-128`, `GET /settings` `:134-139`,
`PUT /settings` `:141-159`, `GET /mine` `:163-170`, `GET /doctor/:doctorId` `:172-190` (self-only
check `:182-184`), `PATCH /:reportId` `:192-233` (`@RequiresIfMatch()` `:198`),
`PATCH /:reportId/default` `:237-248`, `GET /:reportId/versions` `:250-261`, `GET /jobs/:jobId`
`:263-270`, SSE `GET /jobs/:jobId/stream` `:272-279`.
`dna-writing-style-admin.controller.ts` (base `admin/dna-writing-styles` `:28`, class
`@Authorize(['manage','DnaWritingStyleReport'])` `:36`): `GET /dashboard` `:51-62`, `GET /` `:64-96`,
`GET /doctor/:doctorId` `:104-115`, `PATCH /:reportId` `:117-156` (`@RequiresIfMatch()` `:123`,
`bypassOwnershipCheck: true` `:155`), `POST /generate/:doctorId` `:158-168`,
`GET /:reportId/versions` `:170-180`, `GET /jobs/:jobId` `:182-189`, SSE `:196-209`.

Admin console: `/dna-writing-styles`
(`apps/admin-console/src/app/(console)/(tenant)/dna-writing-styles/page.tsx`, feature
`src/features/dna-writing-styles/`, editor `components/doctor-detail.tsx:67-79`, textarea `:108`) and
`/playground/dna-writing-style` (feature `src/features/playground-dna-style/`,
`components/my-style-card.tsx:28-40`, textarea `:69`).

Scheduler: `dna-regeneration.scheduler.ts` — `JOB_NAME = 'dna-regeneration'` `:11`, defaults `:13-17`
(**`enabled: false` `:14`**, cron `'0 0 1 * *'` `:15`, `jobDelayMs: 5000` `:16`), class `:32`,
`getConfig()` `:60-66`, live re-sync `@OnEvent('app-settings.cache-refreshed')` `:55-58`.

### 2.7 **New finding: a second injection path bypasses the opt-in gate**

`getEffectiveStyleText` is gated (`:222-225`). Its callers via `resolveDnaStyleText`
(`apps/api/src/modules/text-compat/text-compat.controller.ts:285-301`, call at `:293`, optional DI at
`:179`, threaded at `:329, :366, :378, :463-464, :527-528, :593, :598, :621-622, :671-672`) are
therefore gated too, and the injected text is wrapped in *"without changing any clinical facts"*
(`v1-summary-prompt.builder.ts:379-382`; `summary-prompt.builder.ts:231-234` and `:383-385`).

**But `apps/api/src/modules/streaming/text-proxy.controller.ts:960-986` does not go through it.** It
resolves the profile directly — `dnaWritingStyleRepository.findById(body.dna_writing_style_id)` —
applies an ownership/tenant check (`:971-983`), and appends the raw ciphertext-decrypted style to the
system prompt at `:985-986` with the string `"Apply the following writing style:\n${dnaStyle.styleText}"`.
**A caller who supplies a `dna_writing_style_id` gets style injection regardless of
`dnaStyleEnabled`, regardless of the doctor's opt-out.**

The harness path, by contrast, resolves a style **id** rather than text
(`harness-internal.service.ts:633`, `:1480-1490`) and is not affected.

This was not adjudicated in the assessment (A-06's evidence cites `smr-compat.controller.ts:284-302`,
not the proxy). **Half (b) cannot claim a per-clinician node-level opt-in while this path exists** —
a node-level opt-in that another route ignores is decoration. Closing it is Task 8.

### 2.8 `dnaStyleEnabled` — descriptor, defaults, seeds, and a declared/actual mismatch

Per-key metadata: `packages/applications/src/services/settings-registry/descriptors/pipeline.descriptors.ts:46`
— `dnaStyleEnabled: { label: 'DNA writing style', description: "Apply and learn the doctor's DNA writing style." }`,
deliberately **not** `globalOnly` (comment `:31-32`: tenant-writable). Descriptors generated `:54-69`:
`key: 'pipeline.dnaStyleEnabled'` `:55`, `tier: 'db-config'` `:56`, `dataType: 'boolean'` `:57`,
`sensitivity: 'internal'` `:58`, `maxScope → 'doctor'` `:59`, `editableBy: 'PipelinePolicy'` `:60`,
**`failMode: 'open-to-default'` `:63`**, `category: 'Pipeline'` `:64`, `default` from `codeDefault` `:67`.
`codeDefault: false` is single-sourced at `config-resolver.service.ts:81`.

> **Declared/actual mismatch worth fixing in this ticket.** The registry declares
> `failMode: 'open-to-default'`, while the runtime DNA resolver is documented and implemented
> **fail-closed** (`config-resolver.service.ts:150-152`, and the catch at `:164-177` returning
> `{ effective: false, tenantEnabled: false, doctorToggle: null }`). They agree numerically today
> **only because the code default is `false`.** Rule 09 §Configuration Tiers is explicit that
> `failMode` is *declared, not decided at the call site*. Re-enabling personalization is exactly when
> a wrong declaration becomes dangerous — Task 9.

Seeds: `packages/database/src/prisma/db_main/seed/14-pipeline-policy.ts` —
`ARCAAI_PIPELINE_POLICY_OVERRIDE` `:74-79` with **`dnaStyleEnabled: true` at `:79`** (TENANT scope;
rationale `:68-73`), SYSTEM default `null` `:57`, demo `null` `:65`, written at `:119` inside
`ensureTenantRow` (`:105-130`). Report fixtures: `seed/08-dna-writing-style.ts` (PHI-encrypted at
`:485`, `:496`). A **separate** SDK feature flag `features.dnaStyle` lives at
`seed/11-global-setting.ts:390,398` — do not confuse the two knobs.

Note also (`config-resolver.service.ts:300-305`): because `dnaStyleEnabled`'s `maxScope` is `DOCTOR`,
the **department tier is already in its cascade walk**. A DEPARTMENT-scope `PipelinePolicy` row for
`dnaStyleEnabled` already works today; it is simply not exposed in any UI.

---

## 3. Knowledge & Best Practices

### 3.1 Repo law that binds this work

| Rule + section | Binding constraint |
|---|---|
| `.claude/rules/02-database-prisma.md` §Standard Model Field Template | The new assignment model follows the exact section order: meta → tenant → business → resourceStatus → audit → indexes. `id String @id @default(uuid(7))`, `version Int @map("_version")`, `tenantId` NOT NULL with no default and no FK, explicit index names, composite uniques include `tenantId`. |
| `.claude/rules/02-database-prisma.md` §Migration Workflow | Author against a **throwaway shadow DB**, never the dev DB. `pnpm --filter @arcaai/database db:migrate:create -n task_733_<desc>` (the `-n` flag does **not** forward through the root alias). Prove no drift with `npx prisma migrate diff --from-config-datasource --to-schema src/prisma/db_main --script` printing `-- This is an empty migration.` |
| `.claude/rules/02-database-prisma.md` §`@@unique` `name:` vs `map:` | On `@@unique`, `name:` sets the **client-facing** compound key; the DB index name comes from `map:`. Getting this wrong permanently drifts the ledger — the rule documents a real prior incident from this exact mistake. |
| `.claude/rules/03-domain-layer.md` §Generated Code Discipline | `pnpm gen:model` is the **only** scaffolder. **Never run `pnpm gen:mapper`** — it is destructive and strips the `_version` OCC guard. Hand-author entity/factory/mapper/repository; reconcile barrels with `gen:entity` + `gen:factory`. The mapper carries `FIELDS_NOT_WRITABLE = ['version']` because this model is OCC-written. |
| `.claude/rules/03-domain-layer.md` §Checklist step 4 | If the model emits sys-events, add it to `ResourceType` in **BOTH** `audit.prisma` (+ `ALTER TYPE ... ADD VALUE` migration) **and** `packages/domains/src/enums/generated/ResourceType.ts`. Skipping it makes every AuditLog INSERT throw and rolls the mutation into a 500 (`resourceType.enum-parity.test.ts` is the guard). |
| `.claude/rules/04-application-services.md` | Service folder pattern, symbol DI, `broadcastSysEvent` on every mutation, DTO mapper, **cross-tenant → `NotFoundException`, never `ForbiddenException`**. |
| `.claude/rules/05-nestjs-api.md` §OCC | Assignment writes are versioned: `@RequiresIfMatch()` + `@ExpectedVersion()` + `repository.updateWithVersion(...)`; missing header → 428, drift → 412. Exemplar chain: `department.controller.ts:119-157`. |
| `.claude/rules/13-nextjs-apps.md` §Routing / §Structure | The matrix screen is tier 30–49 → `(console)/(tenant)/`; `src/app` is routing only; `features/` never import each other; all data through the BFF proxy; ETag/If-Match passthrough. |
| `.claude/rules/11-ux-ui-principles.md` §Screen Template + §11 | `ScreenTemplate`; `<Skeleton />` for loading; axe 0 violations; both themes; ≥24px targets. |
| `.claude/rules/12-design-workflow.md` §2 Gate 2 | **No screen is implemented until its Figma frames are fully available and explicitly approved.** Record the approval (frame inventory + date) in this README. |
| `.claude/rules/09-infrastructure-devops.md` §Configuration Tiers | `failMode` is declared, not decided at the call site: `closed` for secrets and provider/model selection, `open-to-default` for tuning knobs and flags. §2.8's mismatch is a violation of this rule as written. |

### 3.2 SOTA practice this plan follows

- **Reuse the cascade primitive, do not write a fourth one.** `walkCascade` already serves
  `ConfigResolver`; `resolveServableContextDefinition` (`departmentAgent.service.ts:828-847`) already
  does DEPARTMENT→TENANT for context schemas. A third resolution semantics would be the same drift
  `04-target-architecture.md` §4 warns about for provenance.
- **Assignment is a reference, and references get referential validation.** A slug that resolves to
  no `PUBLISHED` definition in the tenant is rejected at write time, not at dispatch time.
- **Audit the assignment, not just the definition.** `PipelinePolicyChange` (`pipeline-policy.prisma:72+`)
  is the in-repo precedent for a WORM change log on a policy row; assignment changes are the same
  class of act.
- **Opt-in must be visible in the authored artifact.** Post-TASK-731 the synthesis step is a node;
  "apply this clinician's style" belongs on that node's config, so a reviewer reading the graph can
  see it. A hidden config-resolver read is exactly what made A-06 hard to see.
- **A gate is only real if it is the only path.** §2.7 — close the bypass in the same change that
  claims the opt-in, or the claim is false.
- **Fail-closed for a PHI-adjacent selection.** Rule 09's own split: an unresolved value for a
  selection raises; nothing is substituted.

### 3.3 Pitfalls specific to THIS ticket

1. **Half (b) is HARD-GATED. Do not build it speculatively.** Task 7's gate is a precondition for
   Tasks 8–12, not a checkbox at the end.
2. **A clean scan is necessary but not sufficient.** TASK-700's containment tasks (2–5) must have
   *shipped*, and TASK-710 hop 2 (full redaction on the corpus) must be wired. A clean scan of rows
   produced by an uncontained generator only says the model happened to behave.
3. **Reset semantics need a decision, not a default.** Delete rows, or soft-delete and mark
   `isLatest=false`? Rule 03 says `softDelete()` is the default and hard delete is *"reserved for
   genuinely immutable cleanup."* But INV-240 says *"deletable by the clinician."* Task 10 decides in
   writing. Note §2.5: `isLatest` has **no DB uniqueness**, so a reset that only flips flags can
   leave a resolvable row behind.
4. **`text-proxy.controller.ts:960-986` is a second injection path** (§2.7). Closing it changes an
   API-facing behaviour — a caller passing `dna_writing_style_id` for an opted-out doctor will start
   getting no style. That is the point, but it is a behaviour change worth naming in the release note.
5. **`DepartmentAgent.dnaStylePolicy` already exists** (`department-agent.prisma:42`, INHERIT |
   DISABLED). Half (b)'s node-level opt-in must **compose with** it, not shadow it. Two knobs meaning
   "is DNA on here" with no stated relationship is how `metadata.status` happened.
6. **Do not add `departmentId` to `WorkflowDefinition`** (§1.3).
7. **`AsrPipeline` has no `departmentId`** (§2.2). A department-scoped **STT** workflow is out of
   scope; do not let the assignment model imply it works for the STT palette until TASK-724's
   compile target is checked.
8. **The cascade already includes the department tier for `dnaStyleEnabled`** (§2.8 last paragraph).
   Do not add a new tier; surface the existing one if a department-level DNA toggle is wanted.
9. **`getEffectiveStyleText` takes no patient parameter** — that is A-06's load-bearing link
   (`dna-writing-style.service.ts:202`). This ticket does not change the signature; the containment
   is that the *content* is schema-constrained post-TASK-700 and redacted post-TASK-710. Say so
   rather than implying cross-patient application was removed.

---

## 4. Implementation Plan

---

### Phase A — Per-department workflow assignment

#### Task 1 — RED: assignment resolution tests
- **Agent:** T2 · sonnet-5 · medium
- **Files:** create `packages/applications/src/services/workflow-assignment/__tests__/workflow-assignment.resolution.test.ts`
- **Approach:** Failing tests for the three-tier order **department override → tenant default →
  platform default**, mocked repositories, using `walkCascade` semantics (first non-null wins):
  a department row wins over a tenant row; absent department falls to tenant; absent both falls to
  the SYSTEM-tenant platform default for the palette; a consultation with `departmentId = null`
  (legal — `consultation.prisma:22`) resolves at the tenant tier; an assignment pointing at a slug
  with no `PUBLISHED`/`isActive` version resolves to the platform default **and emits an observable
  warning**, never silently nothing; a cross-tenant `departmentId` resolves as if absent (never
  another tenant's assignment).
- **Verify:** `pnpm --filter @arcaai/applications test -- workflow-assignment` — RED.

#### Task 2 — Prisma model + migration + domain layer
- **Agent:** T3 · sonnet-5 · high
- **Files:**
  - `packages/database/src/prisma/db_main/workflow-assignment.prisma` (new)
  - `packages/database/src/prisma/db_main/migrations/<ts>_task_733_workflow_assignment/migration.sql`
  - `packages/database/src/extensions/tenant-scope.ts` (`TENANT_SCOPED_MODELS`)
  - `packages/domains/src/enums/generated/ResourceType.ts` + `packages/database/src/prisma/db_main/audit.prisma`
  - `packages/domains/src/{models,entities,factories,mappers,repositories}/generated/core/WorkflowAssignment*.ts`
  - `packages/domains/src/common/databaseServices/core/core.database.module.ts`
- **Approach:** One model on the standard field template (rule 02):

  ```prisma
  model WorkflowAssignment {
    metaData Json?  @map("_metadata") @db.JsonB
    version  Int    @default(1) @map("_version")
    id       String @id @default(uuid(7))
    tenantId String
    // Mirrors PipelinePolicy's (scope, scopeId) shape — pipeline-policy.prisma:40-41.
    scope   PipelinePolicyScope @default(TENANT)
    scopeId String?             // DEPARTMENT ⇒ scopeId = departmentId
    paletteKey             String  // validated against the code registry, never a free string
    workflowDefinitionSlug String  // lineage key; the ACTIVE version is resolved at dispatch
    // resourceStatus + audit fields per the template …
    @@unique([tenantId, scope, scopeId, paletteKey], map: "WorkflowAssignment_scope_palette_unique")
    @@index([tenantId], name: "WorkflowAssignment_tenantId_idx")
    @@index([tenantId, paletteKey], name: "WorkflowAssignment_tenant_palette_idx")
    @@schema("core")
  }
  ```

  Reuse `PipelinePolicyScope` (`enums.prisma:401`) rather than declaring a parallel enum. Note the
  `map:` on `@@unique` (rule 02 pitfall). Add `'WorkflowAssignment'` to `TENANT_SCOPED_MODELS`; do
  **not** add it to `SYSTEM_SHARED_READ_MODELS` (the platform default is resolved by palette, not by
  shared read) and do **not** add it to `MODELS_WITHOUT_SOFT_DELETE`. Add `WorkflowAssignment` to
  `ResourceType` in **both** places with an `ALTER TYPE ... ADD VALUE` migration (rule 03 step 4).
  Then: `pnpm gen:model`, **hand-author** the entity/factory/mapper/repository following
  `AiTaskDefault*` / `AiProviderConnection*`, mapper carrying `FIELDS_NOT_WRITABLE = ['version']`
  (it is OCC-written), register the repository in `CoreDatabaseModule` (providers **and** exports),
  add the mapper and repository barrel lines **by hand**, then `gen:entity` + `gen:factory` to
  reconcile and prove coverage. **Never `gen:mapper`.**
  Migration authored on a shadow DB per rule 02's recipe.
- **Verify:** `pnpm db:generate`; `pnpm --filter @arcaai/database test`;
  `pnpm --filter @arcaai/domains build test`; `pnpm gen:model:check`, `pnpm gen:entity:check`,
  `pnpm gen:factory:check` all report no drift and schema-coverage OK;
  `resourceType.enum-parity.test.ts` green. Paste the empty-migration diff proof.

#### Task 3 — Application service + resolution
- **Agent:** T3 · sonnet-5 · high
- **Files:** create `packages/applications/src/services/workflow-assignment/` —
  `IWorkflowAssignmentService.ts`, `workflow-assignment.service.ts`,
  `workflow-assignment.service.module.ts`, `workflow-assignment.dto.mapper.ts`, `dto/`, `index.ts`
- **Approach:** Standard folder pattern (rule 04); exemplar `packages/applications/src/services/department/`.
  Two responsibilities:
  1. **CRUD** on assignments with tenant guards, `broadcastSysEvent` on every mutation, DTO mapping,
     and **referential validation at write time**: the slug must resolve to a `PUBLISHED` definition
     in the caller's tenant on the stated `paletteKey`, and a `DEPARTMENT`-scope row's `scopeId` must
     be a department in the same tenant. Cross-tenant → `NotFoundException` (404-over-403).
  2. **`resolve(tenantId, paletteKey, departmentId?)`** — build a three-tier `CascadeTier[]`
     (department, tenant, platform-default) and call `walkCascade` from
     `packages/applications/src/services/settings-registry/scope-cascade` — the same import
     `config-resolver.service.ts:3` uses. **Do not reimplement the walk.** Return the resolved slug
     **and its source** (`'department' | 'tenant' | 'platform-default'`) so the runs tab and the
     dispatcher log can say *why* a workflow was chosen.
  Selection is **fail-closed** in rule 09's vocabulary: an unresolvable palette raises; it never
  silently substitutes a different palette's definition. Falling back to the platform default is not
  a substitution — it is the declared last tier.
- **Verify:** Task 1's tests GREEN; `pnpm --filter @arcaai/applications build test`.

#### Task 4 — Admin API + audit
- **Agent:** T2 · sonnet-5 · medium
- **Files:** create `apps/api/src/modules/workflow-assignment/` (controller + module); tests alongside
- **Approach:** `@Controller('admin/workflow-assignments')`, class-level `@CanManage('WorkflowDefinition')`
  (reuse the definition's subject — assignment is a definition-governance act, not a new subject;
  confirm against TASK-715's landed authorization subject in execution). Routes: list (by palette,
  optional scope filter), get by id, upsert, delete. **Every write carries `@RequiresIfMatch()` +
  `@ExpectedVersion()` and calls `repository.updateWithVersion`** — copy `department.controller.ts:119-157`
  verbatim as the exemplar chain.
  **Audit:** every assignment change appends a WORM-style change row following the
  `PipelinePolicyChange` precedent (`pipeline-policy.prisma:72+`) — previous slug, new slug, scope,
  actor, reason. If reusing `PipelinePolicyChange` is not structurally clean, add a sibling table in
  Task 2's migration rather than relying on `AuditLog`, which `02-conformance-matrix.md` records as
  *"mutable, unchained, and hard-deletable via a live cron."*
- **Verify:** `pnpm api:build`; `pnpm test:unit`; an e2e asserting PATCH without `If-Match` → 428,
  stale ETag → 412, and a cross-tenant assignment id → **404** (rule 05; imitate the existing
  cross-tenant specs).

#### Task 5 — Wire the dispatcher
- **Agent:** T3 · sonnet-5 · medium
- **Files:** modify `packages/applications/src/services/consultation/note-generation/` (TASK-704's
  seam; TASK-731 Task 13's dispatcher hop); tests alongside
- **Approach:** At the point TASK-731 Task 13 resolves "the tenant's active published consultation
  definition", insert `IWorkflowAssignmentService.resolve(tenantId, 'consultation',
  consultation.departmentId ?? undefined)` and use its result. Log the resolved slug **and source**.
  Nothing else about the dispatch changes; the pinned-version and claim-check semantics are TASK-718's.
  Behaviour when TASK-731's hook has not landed: **STOP and flag**, do not build a parallel dispatch.
- **Verify:** `pnpm --filter @arcaai/applications test` — a test asserting a consultation whose
  department carries an assignment starts the assigned definition, and one asserting a `null`
  `departmentId` resolves at the tenant tier. `pnpm api:build`.

#### Task 6 — Studio assignment-matrix screen
- **Agent:** T3 · sonnet-5 · high
- **Files:** `apps/admin-console/src/features/workflow-studio/components/assignments/` (new),
  `apps/admin-console/src/app/(console)/(tenant)/workflow-studio/assignments/page.tsx` + `loading.tsx`,
  `nav-config.ts` entry, `__tests__/`
- **Approach:** **Design gate first** — per rule 12 §2 gate 2, no screen is implemented until its
  frames are approved; record the frame inventory + approval date in §7. The screen is a tab or
  sub-route of the Studio (rule 13: *"one authoritative editor per backend resource"* — the Studio
  owns `WorkflowDefinition`, so it owns its assignment too). Rows = departments (+ a tenant-default
  row); columns = palettes; each cell a definition picker showing the **resolved source** when
  inherited (so an inheriting cell is visibly distinct from an explicitly-assigned one — never by
  colour alone, rule 11 §11). Data via the BFF proxy with `If-Match` passthrough; TanStack Query for
  reads, route-handler mutations. `ScreenTemplate` with `contentMode="fill"`; `<Skeleton />` in
  `loading.tsx`; both themes; `vitest-axe` 0 violations.
- **Verify:** `pnpm --filter @arcaai/admin-console build lint test`; the axe assertion; a manual
  keyboard + 200%-zoom pass (rule 11: automation catches ≲57%). Runtime verification via the
  `next-dev-loop` skill.

---

### Phase B — Personalization re-enable (HARD-GATED)

> **Nothing in Phase B starts until Task 7's gate is signed.** Building it "ready to switch on" is
> the same mistake as shipping a floor that becomes permanent.

#### Task 7 — [HUMAN-GATED] The personalization re-enable gate
- **Agent:** T3 · opus-4-8 · high (assembly) — **the decision is the user's**
- **Files:** create `docs/implementation/TASK-733-Department-Assignment-Personalization/reenable-gate.md`
- **Approach:** One checklist, one verdict, one signature. Required evidence per row:

  | # | Gate condition | Evidence required | Owner of the artifact |
  |---|---|---|---|
  | 1 | TASK-700 Task 2 shipped — DNA_ANALYSIS carries a strict `json_schema` `promptConfig` with **no free-text field** | the seed diff + a test asserting the schema shape | TASK-700 §7 |
  | 2 | TASK-700 Task 3 shipped — `response_format` bound on the SMR call and the parser **hard-fails** instead of storing raw output | the removed `catch { styleText = smrResponse.content }` at `dna-writing-style.processor.ts:197-203`, plus its test | TASK-700 §7 |
  | 3 | TASK-700 Task 4 shipped — the opt-out gate sits **above** the `textSamples` branch | diff at `dna-writing-style.processor.ts:105-125` + the e2e asserting an opted-out doctor cannot have a profile generated via `textSamples` | TASK-700 §7 |
  | 4 | **TASK-700 Task 6 executed** and the scan reports **zero** name/MRN/DOB/drug+dose matches for every tenant holding profiles | the scan's per-category **counts** (never excerpts) recorded in TASK-700 §7, with the target environment and date named | TASK-700 §7 |
  | 5 | TASK-710 Task 5 shipped — the DNA corpus is fully redacted before SMR, fail-closed | the integration test asserting a fixture name/MRN in the corpus reaches `callSmr` in neither branch | TASK-710 §7 |
  | 6 | §2.7's bypass is closed (Task 8) | the test in Task 8 | this ticket |
  | 7 | A reset path exists (Task 10) | the route + test | this ticket |

  **Row 4 is the hard one and it is not binary per platform — it is per tenant.** TASK-700's own
  risk note says so: *"If Task 6 finds dirty rows, TASK-733's dependency note in `backlog.md`
  ('700 (scan clean)') means Wave-4 personalization stays blocked until a separate remediation…
  cleans the affected rows."*
  **Who flips what:** the gate document records the verdict; re-enabling for a given tenant is then
  a `PipelinePolicy` write at tenant scope (`dnaStyleEnabled = true`) performed by a
  `manage:PipelinePolicy` holder — the same mechanism `seed/14-pipeline-policy.ts:79` uses for
  ArcaAI today. **This ticket does not flip it for any tenant.** A tenant with a dirty scan stays
  off until Task 12's re-derivation has run for it and the scan is re-run clean.
- **Verify:** a dated, signed verdict per tenant. Tasks 8–12 are unblocked only for tenants marked GO.

#### Task 8 — Close the ungated injection path
- **Agent:** T2 · sonnet-5 · medium
- **Files:** modify `apps/api/src/modules/streaming/text-proxy.controller.ts:960-986`; tests alongside
- **Approach:** Route the proxy's style resolution through the **gated**
  `IDnaWritingStyleService.getEffectiveStyleText` (`dna-writing-style.service.ts:202`) instead of
  `dnaWritingStyleRepository.findById`. Keep the existing ownership/tenant checks (`:971-983`) — they
  are correct and must not be dropped. If a caller supplies a `dna_writing_style_id` for a doctor
  whose effective setting is off, the style is **not** injected; log it once, do not error the
  generation (the request is otherwise legitimate).
  **RED first:** a test asserting that today's code path injects style for an opted-out doctor, then
  make it assert the opposite.
- **Verify:** `pnpm api:build`, `pnpm test:unit` — the RED-then-GREEN pair pasted. Note the
  behaviour change in §7 for the release note.

#### Task 9 — Correct the `failMode` declaration
- **Agent:** T1 · haiku-4-5 · default
- **Files:** modify `packages/applications/src/services/settings-registry/descriptors/pipeline.descriptors.ts:63`
  (for `dnaStyleEnabled` specifically); tests alongside
- **Approach:** §2.8 — the descriptor declares `open-to-default` while the runtime is fail-closed
  (`config-resolver.service.ts:150-152`, `:164-177`). Rule 09: *"`failMode` is declared, not decided
  at the call site."* Declare `dnaStyleEnabled` as `closed` so the declaration matches the
  implementation, and add a test asserting the two agree. **Do not change the runtime behaviour** —
  fail-closed is correct for a PHI-adjacent selection; only the declaration is wrong.
  If the generated descriptor block at `:54-69` applies one `failMode` to all `PIPELINE_SETTINGS`
  uniformly, add a per-key override rather than flipping the whole family.
- **Verify:** `pnpm --filter @arcaai/applications test -- settings-registry`; a test asserting the
  descriptor's `failMode` matches the resolver's observed behaviour on a backend error.

#### Task 10 — Style-profile governance: inspect and reset
- **Agent:** T3 · sonnet-5 · high
- **Files:** modify `packages/applications/src/services/dna-writing-style/dna-writing-style.service.ts`
  + `IDnaWritingStyleService.ts`; `apps/api/src/modules/dna-writing-style/dna-writing-style.controller.ts`
  and `dna-writing-style-admin.controller.ts`; tests alongside
- **Approach:** **Inspect already exists** (§2.6 route list) — this task adds the missing half.
  1. **Decide reset semantics in writing** (§3.3 pitfall 3) before implementing: soft-delete the
     report **and** its versions and clear `isLatest`, versus hard delete. Rule 03's default is
     `softDelete()`. Whichever is chosen, `getEffectiveStyleText`'s `findLatestForDoctor` must return
     nothing afterwards — and because **`isLatest` has no DB uniqueness** (§2.5), the reset must
     clear every candidate row for the doctor, not just the one it read.
  2. `resetDnaProfile(doctorId, tenantId, reason)` on the service, with `assertUserBelongsToTenant`
     (the pattern `:217` already uses) and `broadcastSysEvent`.
  3. Routes: `DELETE /dna-writing-styles/my-style` (doctor self-service, `assertActingAsDoctor()`
     `:77-88` — this is the INV-240 "deletable by the clinician" requirement) and
     `DELETE /admin/dna-writing-styles/doctor/:doctorId` (class `@Authorize(['manage','DnaWritingStyleReport'])`).
     Both are irreversible clinical-adjacent actions → the console must confirm (rule 11 §5).
- **Verify:** `pnpm --filter @arcaai/applications test -- dna-writing-style`; `pnpm api:build`;
  `pnpm test:unit`; a test asserting `getEffectiveStyleText` returns `null` after a reset **even when
  two `isLatest = true` rows existed beforehand**.

#### Task 11 — Node-level DNA opt-in on the synthesis node
- **Agent:** T3 · sonnet-5 · high
- **Files:** modify the consultation palette's `consultation.synthesize` descriptor (TS registry) and
  its Python `NodeSpec` (both landed by TASK-731 Tasks 8/9); tests alongside
- **Approach:** Add an optional config field to the synthesis node — e.g.
  `applyClinicianStyle: boolean` (default `false`) — authored in the `@arcaai/json-schema-subset`
  authorable subset. At dispatch, style is applied **only if all of** the node config says so **and**
  the effective per-clinician setting is on **and** the department agent's `dnaStylePolicy` is not
  `DISABLED` (`department-agent.prisma:42`). Write that three-way composition down explicitly
  (§3.3 pitfall 5) — the node config is a *narrowing* switch, never a widening one: it can turn
  style off for a graph that would otherwise apply it, and it can never turn it on for a doctor who
  is opted out.
  Add a TASK-716-style validator rule for the consultation palette: **a graph may not enable
  `applyClinicianStyle` on a node upstream of a `consultation.phiHop` with `mode: 'full'` on the
  retained-artifact path** — i.e. style application must not become a route by which raw approved
  notes re-enter a corpus. Cite INV-017, INV-080, INV-095, INV-096, INV-164, INV-165, INV-168,
  INV-180.
- **Verify:** the palette registry test suite (path confirmed against TASK-731's landed layout) —
  a test per composition branch: node off ⇒ never applied; node on + doctor off ⇒ not applied;
  node on + doctor on + agent `DISABLED` ⇒ not applied; all three on ⇒ applied. Plus the validator
  rule's pass/fail golden fixture pair. `pnpm --filter @arcaai/applications test`,
  `pnpm harness:test:unit`.

#### Task 12 — [HUMAN-GATED for dirty tenants] Re-derive pre-containment profiles
- **Agent:** T3 · sonnet-5 · high (authoring) — **execution is gated per tenant by Task 7**
- **Files:** create `packages/database/scripts/dna-rederive.ts`; register a package script following
  the `decrypt:row` precedent in `packages/database/package.json`
- **Approach:** A batch task that, for a named tenant, regenerates every doctor's style profile
  **through the post-containment path**: the automatic (non-`textSamples`) branch, so the opt-in gate
  applies; the strict `json_schema` output (TASK-700 Task 2); the hard-fail parser (TASK-700 Task 3);
  and the corpus **fully redacted** by TASK-710's `IPhiRedactor` (`mode: 'full'`, TASK-710 Task 5).
  It re-uses `generateDnaReport` rather than reimplementing the pipeline — a second generation path
  is exactly the drift this program exists to remove.
  Discipline copied from TASK-700 Task 6's script: read-only where it can be, **never print decrypted
  content or matched excerpts**, output only counts and row/doctor ids, unit-test the pure helpers
  with no DB/Vault.
  Ordering per tenant: **reset (Task 10) → re-derive → re-run TASK-700's scan → record the result.**
  Re-deriving without resetting leaves the pre-containment row as a resolvable `isLatest` candidate
  (§2.5).
  **Execution is HUMAN-GATED for any tenant whose scan was dirty** — that is an incident-response
  path, and the data owner authorizes it, not the executing agent. Credentials
  (`SECRETS_PROVIDER=vault`, `VAULT_ADDR`, role/secret ids) are supplied by an authorized operator and
  are never entered by the agent.
  Leave the regeneration scheduler at its default (`enabled: false`,
  `dna-regeneration.scheduler.ts:14`) — re-enabling a monthly cron is a separate decision.
- **Verify:** `pnpm --filter @arcaai/database test -- dna-rederive` (pure helpers only, no live
  DB/Vault in CI). Execution evidence — per-tenant counts and the post-re-derivation scan result —
  recorded in §7 when authorized.

---

### Phase C — Verification

#### Task 13 — Full verification pass
- **Agent:** T2 · sonnet-5 · low
- **Files:** none
- **Approach:** Run every gate touched by both halves.
- **Verify:** `pnpm --filter @arcaai/database test`, `pnpm --filter @arcaai/domains build test`,
  `pnpm --filter @arcaai/applications build test`, `pnpm api:build`, `pnpm test:unit`,
  `pnpm test:integration`, `pnpm test:up:api` + `pnpm test:e2e`,
  `pnpm --filter @arcaai/admin-console build lint test`, `pnpm harness:test`, `pnpm lint:all`,
  `pnpm typecheck:all`, plus `pnpm gen:model:check` / `gen:entity:check` / `gen:factory:check`.
  Paste all output.

---

## 5. Acceptance Criteria

**Half (a) — assignment:**
- [ ] `WorkflowAssignment` follows the standard field template; `TENANT_SCOPED_MODELS` updated; **not**
      added to `SYSTEM_SHARED_READ_MODELS` or `MODELS_WITHOUT_SOFT_DELETE`
- [ ] `WorkflowAssignment` added to `ResourceType` in **both** `audit.prisma` (with an
      `ALTER TYPE ... ADD VALUE` migration) and `packages/domains/src/enums/generated/ResourceType.ts`;
      `resourceType.enum-parity.test.ts` green
- [ ] Migration authored against a **shadow DB**; `prisma migrate diff` prints
      `-- This is an empty migration.` (paste it)
- [ ] Entity/factory/mapper/repository **hand-authored**; mapper carries `FIELDS_NOT_WRITABLE = ['version']`;
      repository registered in `CoreDatabaseModule` (providers **and** exports); barrels updated;
      `gen:model:check` / `gen:entity:check` / `gen:factory:check` report no drift and coverage OK
- [ ] **`pnpm gen:mapper` was not run** (confirmed by diff review of
      `packages/domains/src/mappers/generated/core/`)
- [ ] Resolution is `department → tenant → platform default`, implemented via `walkCascade` from
      `settings-registry/scope-cascade` — **no fourth cascade implementation**
- [ ] `resolve()` returns the resolved slug **and its source**, and the dispatcher logs both
- [ ] Assignment writes validate referentially at write time (slug resolves to a `PUBLISHED`
      definition on the stated palette in the caller's tenant; a `DEPARTMENT` `scopeId` is a
      department in the same tenant)
- [ ] Writes carry `@RequiresIfMatch()` + `@ExpectedVersion()` + `updateWithVersion`; e2e proves
      428 (missing) and 412 (stale)
- [ ] Cross-tenant assignment id → **404**, never 403
- [ ] Every assignment change appends a WORM change row (previous slug, new slug, scope, actor,
      reason) — **not** an `AuditLog` row alone
- [ ] The matrix screen's Figma frames were approved before implementation, with the frame inventory
      + date recorded in §7; axe 0 violations; both themes; inheritance shown by more than colour

**Half (b) — personalization (only for tenants with a signed GO):**
- [ ] `reenable-gate.md` exists with all seven rows evidenced and a **per-tenant** dated verdict
- [ ] **HUMAN-GATED:** TASK-700 Task 6's scan was executed and its per-category counts recorded
- [ ] `text-proxy.controller.ts`'s ungated injection path is closed — RED-then-GREEN pasted
- [ ] `dnaStyleEnabled`'s declared `failMode` matches its implemented behaviour, with a test
- [ ] A reset path exists and is reachable by the clinician (INV-240); `getEffectiveStyleText`
      returns `null` after a reset **even with duplicate `isLatest` rows**
- [ ] The node-level opt-in composes as a **narrowing** switch across node config × clinician setting
      × `DepartmentAgent.dnaStylePolicy` — one test per branch
- [ ] The validator rule forbidding style application upstream of the full-redaction hop has a
      pass/fail golden fixture pair
- [ ] The re-derivation script is authored and unit-tested; **execution for any dirty-scan tenant
      remains HUMAN-GATED** and its evidence (counts + post-re-derivation scan) is recorded in §7
- [ ] The DNA regeneration cron remains `enabled: false`

**Both:**
- [ ] **Layer gates, with pasted output:** `pnpm --filter @arcaai/database test`,
      `pnpm --filter @arcaai/domains build test`, `pnpm --filter @arcaai/applications build test`,
      `pnpm api:build`, `pnpm test:unit`, `pnpm test:integration`, `pnpm test:e2e`,
      `pnpm --filter @arcaai/admin-console build lint test`, `pnpm harness:test`, `pnpm lint:all`,
      `pnpm typecheck:all`
- [ ] **Evidence rule:** paste actual command output before claiming done

---

## 6. Risks & Open Questions

| # | Risk / question | Handling |
|---|---|---|
| R-1 | **HUMAN-GATED — the re-enable gate (Task 7).** Row 4 (TASK-700's scan) has not been run at authoring time and may come back dirty for some tenants. | Phase B is per-tenant. A dirty tenant stays off until Task 12's re-derivation has run **and** the scan is re-run clean. TASK-700 §6 already anticipates this exact dependency. |
| R-2 | **HUMAN-GATED — re-derivation execution** against real PHI-bearing rows. | Authored, unit-tested, not executed. Requires the data owner's authorization and a named target environment; credentials are supplied by an authorized operator, never entered by the agent. |
| R-3 | **§2.7's bypass changes API behaviour.** A caller passing `dna_writing_style_id` for an opted-out doctor stops receiving style injection. | Intentional and named in the release note. It is the difference between a gate and a suggestion. |
| R-4 | **Two DNA knobs with no stated relationship** — the node config and `DepartmentAgent.dnaStylePolicy` (`department-agent.prisma:42`). | Task 11 states the composition explicitly and tests every branch. Narrowing-only, never widening. |
| R-5 | **`isLatest` has no DB uniqueness** (§2.5), so "the latest profile" is an ordering, not a guarantee. Reset and re-derivation both depend on it. | Task 10 clears every candidate row, and its test constructs the duplicate case. Adding a partial unique index is a tempting fix but is a schema change beyond this ticket's size — flag it as a follow-up rather than doing it here. |
| R-6 | **TASK-731 must have landed** for Tasks 5 and 11 (the dispatcher hop and the synthesis node). | Task 5 and Task 11 STOP and flag rather than building a parallel dispatch or a speculative node config. |
| R-7 | **Department-scoped assignment implies STT department scoping, which does not work.** `AsrPipeline` has no `departmentId` (§2.2). | Half (a) ships with the consultation palette wired; the assignment model is palette-keyed, so an STT assignment is expressible but must be verified against TASK-724's compile target before being exposed. State this in the screen's palette filter rather than letting an admin create an assignment that silently does nothing. |
| R-8 | **The Studio design gate (rule 12 §2 gate 2) can block Task 6 indefinitely** if frames are not produced. | The backend (Tasks 1–5) is independent of the screen and ships first; rule 12's own delivery model puts non-visual work off the design critical path. |
| R-9 | **Open question: should the assignment cascade include a doctor tier?** The primitive supports it and `dnaStyleEnabled` already walks four tiers. | Deliberately out of scope (§1.4). If a product need appears, it is one extra `CascadeTier` entry — the design does not preclude it. |
| R-10 | **This ticket's reset is not INV-170's erasure cascade.** A clinician resetting their own profile does not scrub a specific patient's contributions from an exemplar bank. | Stated in §1.4. Do not let the reset route be described as satisfying INV-170/A-10; that needs `PatientConsent` (TASK-712) and a `retention-erasure` epic not in this backlog. |

---

## 7. Implementation Summary

**Executed 2026-08-19 on `feat/loop` @ `a6daa9157`.** Phase A Tasks 1–4 are complete. Task 5,
Task 6 and all of Phase B are blocked — see "Not done, and why" below.

### 7.1 What was built (Phase A, half (a))

| Layer | Files |
|---|---|
| Database | `packages/database/src/prisma/db_main/workflow-assignment.prisma` (new — `WorkflowAssignment` + `WorkflowAssignmentChange`), `.../migrations/20260819120000_task_733_workflow_assignment/migration.sql` (new), `.../db_main/audit.prisma` (`ResourceType.WorkflowAssignment`), `src/extensions/tenant-scope.ts` (both models -> `TENANT_SCOPED_MODELS`), `src/client.ts` (`WorkflowAssignmentChange` -> `MODELS_WITHOUT_SOFT_DELETE`) |
| Domain | `packages/domains/src/{models,entities,factories,mappers,repositories}/generated/core/WorkflowAssignment*.ts` + `WorkflowAssignmentChange*.ts`, barrels, `enums/generated/ResourceType.ts`, `common/databaseServices/core/core.database.module.ts` |
| Services | `packages/applications/src/services/workflow-assignment/**` (interface + service + module + DTO mapper + DTOs + 2 test files), `services/index.ts` barrel |
| API | `apps/api/src/modules/workflow-assignment/**` (controller + module + tests), `apps/api/src/app.module.ts` |
| Generated artifacts | `apps/api/route-manifest.json`, `apps/api/openapi.json`, `packages/vox-node/src/resources/admin/**` (regenerated; `gen:admin:check` reports no drift) |
| Tests updated | `packages/database/src/__tests__/soft-delete-extension.test.ts`, `packages/database/src/extensions/__tests__/tenant-scope.test.ts` (allow-list expectation lists) |

Design decisions worth recording:

- **`WorkflowAssignment` mirrors `PipelinePolicy`'s `(scope, scopeId)` shape and REUSES
  `PipelinePolicyScope`** rather than declaring a parallel enum, so `walkCascade` from
  `settings-registry/scope-cascade` resolves it unchanged. No fourth cascade was written.
- **The platform-default tier is `null`, not a SYSTEM-tenant assignment row.** §4 Task 2 says
  `WorkflowAssignment` must NOT be added to `SYSTEM_SHARED_READ_MODELS`, so a SYSTEM assignment
  row is not readable from a tenant context by construction. `resolve()` therefore returns
  `{ workflowDefinitionSlug: null, source: 'platform-default' }` when no tier has an opinion, and
  the CALLER keeps its own platform-default resolution (the seed clone path). This is the one
  place the implementation had to make the plan's wording concrete; it preserves both the stated
  tier order and the stated tenancy posture.
- **The WORM change log is a sibling table, not `PipelinePolicyChange` reuse** (§4 Task 4's
  fallback), because the payload is a slug pair, not a toggle snapshot. It carries no encryption
  columns: a workflow slug is a configuration identifier, never PHI.
- **`REVOKE UPDATE, DELETE` is deliberately absent** from the migration, and the migration says
  so: the equivalent grant DDL for `PipelinePolicyChange`/`HarnessPolicyChange` did not survive
  the 2026-08-17 squash, and inventing a role name here would be a guess. Append-only is enforced
  the same way it is for those two today (no update/delete surface on the repository).
  Restoring the DB-privilege layer for all three change logs is a follow-up.
- **Authorization reuses `@CanManage('WorkflowDefinition')` + `svc:admin:workflow-definition:manage`**
  — assignment is a definition-governance act, not a new subject.

### 7.2 Verification evidence (actual output)

Migration authored against a THROWAWAY shadow DB (`hope_shadow_733`, created and dropped; the dev
DB was never touched):

```
$ pnpm --filter @arcaai/database db:migrate:deploy      # against hope_shadow_733
  └─ 20260819120000_task_733_workflow_assignment/
    └─ migration.sql
All migrations have been successfully applied.

$ npx prisma migrate diff --from-config-datasource --to-schema src/prisma/db_main --script
Loaded Prisma config from prisma.config.ts.
-- This is an empty migration.
```

Generator gates:

```
$ pnpm gen:model:check    check: no drift — 169 generated file(s) match the committed files.
$ pnpm gen:entity:check   check: no drift — 99 generated file(s) match the committed files.
                          Schema coverage OK: 97 entity artifact(s) cover every persisted column of 101 Prisma model(s)
$ pnpm gen:factory:check  check: no drift — 99 generated file(s) match the committed files.
                          Schema coverage OK: 97 factory artifact(s) cover every persisted column of 101 Prisma model(s)
$ pnpm --filter @arcaai/vox-node gen:admin:check
                          [vox-node-codegen] no drift (52 areas, 390 routes, 353 schemas)
```

`pnpm gen:mapper` was NOT run (`git diff packages/domains/src/mappers/generated/core/` shows only
the two new files + the barrel line).

RED → GREEN on Task 1's resolution tests:

```
# RED (service did not exist yet)
FAIL  src/services/workflow-assignment/__tests__/workflow-assignment.resolution.test.ts
Error: Cannot find module '../workflow-assignment.service'
 Test Files  1 failed (1)

# GREEN
 Test Files  2 passed (2)
      Tests  13 passed (13)
```

Layer gates:

```
$ pnpm --filter @arcaai/database test       Test Files  58 passed (58)     Tests  1541 passed (1541)
$ pnpm --filter @arcaai/domains build       (tsc, clean)
$ pnpm --filter @arcaai/domains test        Test Files  147 passed | 2 skipped (149)   Tests  1810 passed
$ pnpm --filter @arcaai/applications build  (tsc, clean)
$ pnpm --filter @arcaai/applications test   Test Files  1 failed | 512 passed | 1 skipped (514)
                                            Tests  1 failed | 9517 passed (9522)
$ pnpm api:build                            Tasks: 12 successful, 12 total
$ apps/api vitest run                       Test Files  238 passed | 2 skipped (240)   Tests  3770 passed
$ pnpm --filter @arcaai/vox-node test       Test Files  18 passed (18)     Tests  233 passed (233)
$ typecheck: @arcaai/{domains,applications,api,vox-node}   all clean
$ lint: @arcaai/{database,domains,applications,api}        no errors, no new warnings
```

The ONE applications failure is `s3.service.secret-gate.test.ts > initializes when credentials
come from SecretsService and NO GlobalSetting rows exist`. It is **pre-existing**: it fails
identically with this ticket's changes stashed (`git stash push -- packages/applications
packages/domains packages/database apps/api` → same single failure). Out of scope.

Not run: `pnpm test:integration` / `pnpm test:e2e` (live test infra + a running gateway are the
orchestrator's to start), and the `apps/compat-playground` / `apps/quick-compat-app` /
`packages/ui` suites (owner directive, 2026-08-19).

### 7.3 Not done, and why

| Item | State |
|---|---|
| **Task 5 — wire the dispatcher** | **STOPPED AND FLAGGED, as §4 Task 5 instructs.** TASK-731 has not landed: `NoteGenerationService` (`packages/applications/src/services/consultation/note-generation/note-generation.service.ts`, 196 lines) contains no workflow/palette resolution at all, and the node registry carries `summarization` + `stt` only — there is no `consultation` palette to resolve. Building a parallel dispatch was explicitly forbidden. `IWorkflowAssignmentService.resolve()` is ready for the one-line hop when TASK-731 lands. |
| **Task 6 — Studio assignment-matrix screen** | **BLOCKED on the design gate** (rule 12 §2 gate 2 — no screen before its Figma frames are approved; no frame inventory exists for it). §6 R-8 anticipates exactly this and puts the backend first, which is what shipped. |
| **Phase B Tasks 8–12** | **HARD-GATED on Task 7**, which is a human verdict. `reenable-gate.md` was authored with the evidence status verified against the tree. Findings worth surfacing: **Task 8 (the §2.7 ungated injection path), Task 9 (the `failMode` declaration) and Task 10 (the reset path) are ALREADY CLOSED on `feat/loop` by other work** — the proxy now routes through the gated `getEffectiveStyleText` (`text-proxy.controller.ts:1041-1045`), `pipeline.descriptors.ts:74-76` declares `dnaStyleEnabled` as `'closed'`, and both DNA controllers now carry `@Delete` routes. Task 11 is additionally blocked on TASK-731; Task 12 is deferred with the gate. |
| **A DB-level `REVOKE` on the change log** | Deliberately omitted (see §7.1); a follow-up should restore it for all three change logs together. |

## 8. Change History

| Date | Change | By |
|---|---|---|
| 2026-08-16 | Ticket authored | Claude (Wave-4 ticket-authoring agent) |
| 2026-08-19 | Phase A implemented (Tasks 1–4): `WorkflowAssignment` + `WorkflowAssignmentChange` model/migration/domain trio, `WorkflowAssignmentService` (cascade resolution via `walkCascade` + OCC CRUD + WORM audit), `/api/v1/admin/workflow-assignments` controller, regenerated route-manifest/openapi/vox-node admin artifacts. Task 5 STOPPED (TASK-731 not landed), Task 6 blocked on the design gate, Phase B gate document authored unsigned — and Tasks 8/9/10 found already closed by other work on `feat/loop`. | Claude (implementing agent) |
