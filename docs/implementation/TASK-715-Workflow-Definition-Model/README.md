# TASK-715 — Workflow Definition Model + Code-Owned Node Registry

| | |
|---|---|
| **Status** | In Progress (Phase A — Database — done; Phases B–F not started) |
| **Wave** | 1 · **Size** | L |
| **Epic slug** | `workflow-definition-model` |
| **Depends on** | TASK-707 (`naming-alignment` — all new code is born with the post-rename names) |
| **Design refs** | D2, D3, D4, D6, D8 from [design.md](../../programs/agentic-workflow-platform/design.md) — Plane 1 §"Workflow substrate", Data flow §Authoring, Roadmap Wave 1 |
| **Findings closed** | — (foundation ticket; closes design.md open question 5 with a recommendation) |

---

## 1. Requirement Analysis

### What this delivers

The persistence and vocabulary floor of the workflow substrate — everything TASK-716
(compiler/validator), TASK-718 (interpreter) and TASK-719 (Studio) build on:

1. **`WorkflowDefinition`** — a tenant-scoped Prisma model on the standard field template
   (UUIDv7 id, `_version` OCC, `tenantId`, soft delete, audit columns). Carries the canvas
   model (`graph` JsonB), the interpreter's input contract (`compiledConfig` JsonB, stamped at
   publish), `parentVersionId` lineage, and the lifecycle
   `DRAFT → VALIDATED → PUBLISHED → DEPRECATED` with published rows immutable.
2. **The node registry** — the code-owned vocabulary of node types. Each type declares its
   config JSON schema, category, palette membership, safety class
   (`mandatory` / `locked` / `optional`), the sanctioned activity it routes to, and its
   entitlement gate. Not tenant-editable (D2: tenants author *configurations*, never
   executable definitions).
3. **The CRUD + version-operation surface** — application service (symbol DI, sys-events,
   DTOs, pagination) and NestJS controller (ETag/If-Match OCC on writes), plus a read-only
   registry endpoint the Studio palette rail and inspector consume.
4. **Platform default definitions** — SYSTEM-tenant seed rows. design.md's runtime error
   handling depends on them: *"Temporal unreachable → platform default config"*, and
   *"safety-critical rule changes may force-deprecate with fallback to the platform default
   config"*. Without a seeded default those two fallbacks have nothing to fall back to.

### Why it is shaped this way

D3 puts full build power in tenant-admin hands on day one, so **the model must be able to
express an unsafe graph and the server must be the only thing that decides it is unsafe.**
This ticket therefore stores the graph verbatim and stamps a separate, server-produced
`compiledConfig` — never trusting the client-supplied `graph` at execution time. The
validator that produces the verdict is TASK-716; this ticket owns the columns it writes into
and the lifecycle guard that makes "published" mean something.

### Invariants this ticket serves

It serves them *structurally*, not by rule evaluation (that is TASK-716):

| Register id | How this ticket serves it |
|---|---|
| INV-159, INV-186 (`hitl-authority`) — the system never signs; only explicit clinician approval commits | The registry has **no signing node type**. `SIGNED` is unreachable from the substrate by construction, exactly as design.md Plane 1 states. Enforced by a registry-assembly assertion, not a comment. |
| INV-157, INV-158 (`commit-idempotency`) — commit must be transactional and idempotent with record-version checks | `graphChecksum` makes republish idempotent (the `ConsultationContextSchemaService.publish` precedent); `_version` + If-Match gives the record-version check on every edit. |
| INV-084 (`audit`) — every context mutation audited with source | Every mutation broadcasts a sys-event; `WorkflowDefinition` is added to `ResourceType` in **both** enums so the `AuditLog` INSERT does not throw. |
| INV-160 (`provenance`) — provenance records model version and input sources | `compiledConfig` + `registryChecksum` + `parentVersionId` make a run's authored source reconstructible from the pinned version alone. |

### Explicitly OUT of scope

- **Any validation logic.** `POST /:id/validate` and the publish gate here call into an
  injected `IWorkflowValidatorService` port whose implementation lands in TASK-716. This
  ticket ships the port + a trivial stub that returns "no rules configured" so the lifecycle
  is testable end-to-end; TASK-716 replaces the stub.
- **The interpreter** (TASK-718) and any Temporal code.
- **The Studio UI** (TASK-719). This ticket ships the registry *endpoint*, not the palette rail.
- **The exposure plane** (TASK-722). No `/api/v1/workflows/:slug` public surface here — the
  admin plane only.
- **Palette content.** Node types for the Summarization palette land with TASK-720; this
  ticket ships the registry mechanism plus the two palette-independent structural node types
  (`core.start`, `core.end`) needed to make the golden fixtures in TASK-716 authorable.
- **Runs / trajectory** (TASK-723).

---

## 2. Current State Evaluation

Verified against the live tree on 2026-08-16 (branch `feat/loop`). Search exclusions applied:
`.claude/worktrees/**`, `**/dist/**`, `**/node_modules/**`, `**/.venv/**`, `**/__pycache__/**`,
`docs/archive/**`.

### 2.1 Nothing named `Workflow*` exists yet

`docs/implementation/` is empty; there is no `workflow-definition.prisma`, no
`WorkflowDefinition` in `packages/database/src/prisma/db_main/`, and no `ValidationReport`
type anywhere in `packages/` or `apps/` (`grep -rn 'ValidationReport'` → zero hits outside
`node_modules`/`dist`). This is greenfield on top of a mature set of primitives.

### 2.2 The house governance pattern this ticket must align with

`packages/database/src/prisma/db_main/consultation-context-schema.prisma:8-16` names it
explicitly:

> "Shape is the house governance triple already used by PromptTemplate/PromptVersion and
> AsrPipeline/AsrPipelineVersion: a MUTABLE head row, an IMMUTABLE per-publish version
> snapshot, and a MOVABLE pin naming which snapshot is currently served."

Concrete instances verified:

| Head | Version snapshot | Pin column |
|---|---|---|
| `PromptTemplate` (`prompt-template.prisma:34`) | `PromptVersion` (`:110`) | `approvedVersionNumber Int?` (`:71`) |
| `ConsultationContextSchema` (`consultation-context-schema.prisma:19`) | `ConsultationContextSchemaVersion` (`:89`) | `pinnedVersionNumber Int?` (`:47`) |
| `DepartmentAgent` (`department-agent.prisma:22`) | `DepartmentAgentVersion` (`:161`) | `pinnedVersionNumber Int?` (`:41`, pins the *bound template*) |

Two facts about that pattern are load-bearing for this ticket and were verified directly:

- **`parentVersionId` has no precedent in this repo.** `grep -rn 'parentVersionId'` over
  `packages/database/src`, `packages/domains/src`, `packages/applications/src` returns zero
  hits. The house lineage mechanism is a monotone `(headId, versionNumber)` integer plus a
  movable pin. design.md nevertheless settles on `parentVersionId`; §3.3 records why that is
  the right call *here* and §6 records the divergence.
- **Hard post-publish immutability has no precedent either.** `PromptTemplate` stays
  editable after `APPROVED`; there is no `if (status === 'APPROVED') throw` guard in
  `packages/applications/src/services/prompt-management/prompt-management.service.ts`. The
  three private guards at `:1429` (`assertOwnedByTenant`), `:1442` (`assertCanApprove`) and
  `:1456` (`assertCanMutate`) are *authorization*, not immutability. Immutability is achieved
  indirectly by pinning — the comment at `:378-382` says an edit to an approved template
  "creates a new PromptVersion … NOT served until re-approval (resolution serves
  `approvedVersionNumber`, not latest)". This ticket needs the *hard* guard; §3.4 justifies
  the divergence.

### 2.3 The publish exemplar to copy

`packages/applications/src/services/consultation-context-schema/consultation-context-schema.service.ts:200`
`async publish(id, dto)` is the closest existing analogue and supplies four mechanisms
verbatim:

- ownership check FIRST, so a cross-tenant id 404s before the caller learns anything about
  whether its payload would have been accepted (`:203-206`);
- structural validation → `BadRequestException({ message, problems })` (`:208-214`);
- **checksum-idempotent republish** — identical canonical bytes write nothing and move
  nothing (`:218-222`);
- **status monotonicity** — `if (entity.status !== APPROVED) entity.status = PUBLISHED;`
  with the comment "re-publishing must not silently drop a governance sign-off back to
  PUBLISHED" (`:252-257`);
- **non-OCC head update on publish** — `this.schemaRepository.update(id, entity)` with the
  comment "publishing is not a compare-and-set on the head row (the caller is not editing
  metadata it read), so it must not fail on an unrelated concurrent metadata edit"
  (`:258-263`).

Version-number minting must copy `prompt-management.service.ts:419-447`: the next number is
`findMaxVersionNumber(...) + 1` **queried through the transaction client**, not
`currentVersionNumber + 1`, so a lagging counter cannot collide with the unique index.

### 2.4 The code-owned registry precedent — `settings-registry`

This is the exact shape of the node registry, already shipped and in production use:

| Concern | File:line |
|---|---|
| Descriptor interface (`SettingDescriptor`) | `packages/applications/src/services/settings-registry/registry.types.ts:88` |
| Descriptor arrays, one file per domain | `packages/applications/src/services/settings-registry/descriptors/*.descriptors.ts` (21 files) |
| Assembly into one object | `packages/applications/src/services/settings-registry/registry.ts:32` — `HOPE_SETTINGS_REGISTRY = new SettingsRegistry().registerAll([...])` |
| Assembly-time assertions | `settings-registry.ts:26` (duplicate key), `:29`, `:36`, `:90` (`kill-switch(es) must default OFF but default ON: …`) |
| Read-only catalog endpoint | `apps/api/src/modules/settings-catalog/settings-catalog.controller.ts:24` `@Controller('admin/settings')`, `:31` `@Get('catalog')` |

`.claude/rules/09-infrastructure-devops.md` §Configuration Tiers states the governing
property: *"Registering a descriptor is the ONLY step needed to make a key governed and
writable — there is no per-key allow-list."* That is precisely the property the node
registry needs.

Two design features of `SettingDescriptor` transfer directly: `failMode` declared on the
descriptor rather than decided at the call site (`registry.types.ts:39-55`), and `globalOnly`
(`:104`) as the GLOBAL_ADMIN lock. The node registry's `safetyClass` is the same idea.

### 2.5 Node config schemas — the validator already exists

`packages/json-schema-subset` (`@arcaai/json-schema-subset`, zero runtime dependencies) ships:

- `authorableJsonSchemaProblems(schema, path?)` — structural problems with an *authored*
  schema (rejects `if`/`then`/`else` at any depth, requires a sibling
  `discriminator.propertyName` on `oneOf`, bounds depth to `MAX_SCHEMA_DEPTH` = 12 and node
  count to `MAX_SCHEMA_NODES` = 512);
- `jsonSchemaValueProblems(schema, value, path?)` — problems with a submitted value.

Both return problem strings rather than throwing "so a caller can surface every problem in
one response" (`packages/json-schema-subset/README.md`). Its README records why it exists:
one clinical validation rule had drifted into three copies (server, `@arcaai/vox`,
`@arcaai/admin-console`) "because neither the SDK nor the console can depend on
`@arcaai/applications`". Its consumer table already lists all three.

**This is the single most valuable reuse in the ticket.** Declaring node config schemas in
that same authorable subset means the Studio inspector generates its forms from the same
bytes the server validates against — which is design.md's *"Contract tests: one schema, three
consumers (registry ↔ inspector forms ↔ compiled config)"* satisfied by construction rather
than by a test that catches drift after the fact.

Verified dependency facts: **`ajv` is not a dependency anywhere** in the monorepo (grep over
every non-`node_modules` `package.json`). `zod` `^4.4.3` is declared by the root,
`packages/ui`, `packages/applications`, `apps/api`, `apps/admin-console`.
`packages/json-schema-subset/package.json` declares **zero** runtime dependencies and ships
dual CJS/ESM "so the NestJS server (`moduleResolution: node`) and the bundled browser
consumers can both use it".

### 2.6 Canonical JSON + checksum already exist

`packages/applications/src/services/consultation-context-schema/context-schema-definition.ts:346`
`export function canonicalJson(value: unknown): string` and `:366`
`export function computeDefinitionChecksum(definition: unknown): string`
(`createHash('sha256')`, imported at `:1`). The same idiom appears at
`packages/applications/src/services/departmentAgent/departmentAgent.service.ts:865`.

### 2.7 The pure-function validator idiom

`packages/applications/src/services/departmentAgent/constants.ts` is the house style for
structural validation of a tenant-authored JSONB payload — pure functions that never throw
and never do I/O, returning `{ problems: string[], …keys }`:

- `writeScopeProblems(value)` — `:242`, returns `{ problems, outputKeys }`;
- `subscribedKindsProblems(value)` — `:187`, returns `{ problems, kindKeys }`;
- `actionListProblems(value, field)` — `:321`; `actionOverlapProblems(always, never)` — `:344`;
- closed catalogues: `LIVE_TOOL_KEYS` `:61`, `AGENT_KIND_KEY_PATTERN = /^[a-z0-9_]{2,48}$/`
  `:177`, `GUARDRAIL_PROFILE_KEYS = ['STANDARD','STRICT','RELAXED']` `:286`,
  `AGENT_ACTION_KEYS` `:304` (7 members: `livedoc.start`, `livedoc.stop`,
  `vision.extract_text`, `document.extract_text`, `nlp.extract_entities`,
  `harness.finalize`, `client.emit`).

Node/port keys in this ticket reuse `AGENT_KIND_KEY_PATTERN`'s grammar — the comment at
`constants.ts:169-176` already declares it "a platform-wide convention", mirrored from
`CONTEXT_KIND_KEY_PATTERN` (`context-schema-definition.ts:47`).

### 2.8 Entitlement gating is column-per-key

`IEntitlementsService.isFeatureEnabled(tenantId, feature)` —
`packages/applications/src/services/entitlements/IEntitlementsService.ts:98`, implemented at
`entitlements.service.ts:268`. But the key type is
`export type EntitlementFeatureKey = keyof ResolvedFeatures` (`IEntitlementsService.ts:18`)
with the comment *"entitlements are COLUMN-per-key, so the type system is the registry"*.
`ResolvedFeatures` (`resolve-entitlements.ts:48-63`) has exactly four members today:
`dnaReports`, `voiceEnrollment`, `monitoringAccess`, `platformDefaultCredential`.

Adding one feature means: a `Boolean @default(false)` column on `PlanEntitlement`
(`entitlement.prisma:99`), a `Boolean?` column on `TenantEntitlement` (`:182`), a
`ResolvedFeatures` member, a seed row edit in
`packages/database/src/prisma/db_main/seed/15-entitlements.ts:208`, and a mirror into
`packages/applications/src/services/entitlements/entitlements.constants.ts:180` — or
`packages/applications/src/services/entitlements/__tests__/plan-matrix-parity.test.ts` fails.

**This settles design.md open question 5 arithmetically: gate per PALETTE, not per node
type.** Per-node-type gating costs one column pair per node type in two tables plus a seed
and a parity-test edit — unbounded schema churn for a vocabulary that is meant to grow
without deploys. §3.5 records the decision.

Note `isFeatureEnabled` is non-throwing and returns `true` when the global kill-switch
`entitlements.enabled` is off (`entitlements.service.ts:260-262`: "with the switch off,
feature gates are INERT"). That switch seeds `'false'` on a fresh local DB
(`seed/15-entitlements.ts:285-314`), so palette gating is inert in dev by default — expected,
and the reason the registry endpoint must *label* gated nodes rather than silently omit them.

### 2.9 Registration mechanics (the edit points a new model requires)

| Edit point | File:line | Note |
|---|---|---|
| Multi-file schema | `packages/database/src/prisma/db_main/schema.prisma` holds only datasource + generator | a new `.prisma` file in that folder needs no registration edit |
| Tenant scoping | `packages/database/src/extensions/tenant-scope.ts:52` `TENANT_SCOPED_MODELS` (closes `:252`); PascalCase literals | drift-guard: `packages/database/src/extensions/__tests__/tenant-scope.test.ts` |
| System shared read | `tenant-scope.ts:296` `SYSTEM_SHARED_READ_MODELS` | precedent at `:244-249`: `ConsultationContextSchema*` deliberately NOT added — "a tenant reads only its own schemas, and the golden-library clone path copies rows rather than sharing them" |
| Soft delete | `packages/database/src/client.ts:95` `MODELS_WITHOUT_SOFT_DELETE` (closes `:194`) | omitting a `resourceStatus`-less model causes `PrismaClientValidationError` → bare 400 on every read (`:99-103`) |
| Audit enum (DB) | `packages/database/src/prisma/db_main/audit.prisma:103` `enum ResourceType` | bare PascalCase identifiers |
| Audit enum (domain) | `packages/domains/src/enums/generated/ResourceType.ts:5` (68 members, closes `:102`) | hand-edited despite the `generated/` path |
| Parity guard | `packages/domains/src/enums/__tests__/resourceType.enum-parity.test.ts` | generic checks at `:33`/`:45` plus **named pin assertions** from `:56` |
| Repository DI | `packages/domains/src/common/databaseServices/core/core.database.module.ts` — import ~`:33`, `const repositories = [` `:117` (closes `:256`); `@Module` at `:258` spreads the array into providers `:260` + exports `:261` | no third edit needed |

Migration template: `packages/database/src/prisma/db_main/migrations/20260811000000_task_658_consultation_context_schema/migration.sql`.
The `ResourceType` statement form (verified in the three newest such migrations) is exactly:

```sql
ALTER TYPE "core"."ResourceType" ADD VALUE IF NOT EXISTS 'WorkflowDefinition';
```

with the transaction-safety note that migration carries at `:17-20`: PostgreSQL ≥ 12 allows
`ADD VALUE` inside a transaction block provided the new value is not USED in the same
transaction.

### 2.10 The controller exemplar

`apps/api/src/modules/consultation-context-schema/consultation-context-schema.controller.ts`
is the exact route shape for a versioned, publishable, pinnable tenant resource:

```
:36  @Controller('admin/consultation-context-schemas')
:37  @CanManage('ConsultationContextSchema')
:44  @Get()            :51 @Get(':id')        :60 @Get(':id/versions')
:72  @Post()           :84 @Patch(':id') + :85 @RequiresIfMatch() + :102 @ExpectedVersion()
:110 @Post(':id/publish')                     :128 @Post(':id/pin')
:140 @Delete(':id')
:172 @Controller('tenant/me/context-schema')  :173 @Authorize()   :180 @Get()
```

The AUTH-NOTE marker template for a route whose real gate is imperative in the service is
`apps/api/src/modules/prompt-management/prompt-management.controller.ts:338-344`.
The header/body precedence idiom for `@ExpectedVersion()` is repeated verbatim at `:186-190`,
`:329-332`, `:396-399`.

### 2.11 Seeds

`packages/database/src/prisma/db_main/seed/` is numerically ordered; the highest business
seed today is `20-ai-price-book.ts`, so this ticket's file is `21-workflow-definition.ts`.
The SYSTEM-tenant golden-library precedent is `seed/07a-agent-golden-library.ts`; constants
(`SYSTEM_TENANT_ID = '00000000-…'`) live in `seed/00-constants.ts`.

### 2.12 What the interpreter will route to

`apps/harness/src/harness/temporal/activities.py` declares 27 `@activity.defn` activities
today — among them `fetch_policy` (`:655`), `extract_entities` (`:755`), `call_mcp_tool`
(`:802`), `assemble_prompt` (`:1009`), `generate` (`:1049`), `retrieve_context` (`:1230`),
`run_sensors` (`:1282`), `apply_redaction` (`:1754`), `persist_draft` (`:1897`),
`finalize_assurance` (`:1956`), `record_gate_decision` (`:2050`), `escalate_gate` (`:2110`).
This is the sanctioned set a node descriptor's `activity` field may name. It is recorded here
so the registry's `activity` field is a closed catalogue from day one rather than a free
string — the `AGENT_ACTION_KEYS` discipline (`departmentAgent/constants.ts:304`) applied to
node types.

**Notably absent: any activity that writes `SIGNED`.** Approval remains `approveSummary`,
outside the substrate. The registry-assembly assertion in Task 5 makes that structural.

---

## 3. Knowledge & Best Practices

### 3.1 Repo rules that bind this work

| Rule | Section | Obligation |
|---|---|---|
| `.claude/rules/02-database-prisma.md` | Standard Model Field Template | exact section order: meta → tenant → business → resource status → audit → tags → relations → indexes; `String @id @default(uuid(7))`; `tenantId` NOT NULL with no FK and no `NULL = global` |
| `02-database-prisma.md` | Client Access Tiers | update `TENANT_SCOPED_MODELS`; never import `getPlatformAdminPrismaClient_Unscoped` outside seeds |
| `02-database-prisma.md` | Migration Workflow | migrations are authored against a **throwaway shadow DB**, never the dev DB (`pnpm db:all` runs `db push --force-reset` and would wipe a baselined ledger). `-n` must go to the package-level script: `pnpm --filter @arcaai/database db:migrate:create -n task_715_workflow_definition` |
| `02-database-prisma.md` | Rules | on `@@unique`, `name:` is the client-facing compound key and `map:` is the DB index name. `@@index(..., name: …)` is the exception — there `name:` IS the DB name |
| `.claude/rules/03-domain-layer.md` | Generated Code Discipline | **NEVER run `pnpm gen:mapper`** — it strips `FIELDS_NOT_WRITABLE = ['version']` from mappers before crashing. `gen:repository` is broken. `gen:entity`/`gen:factory` reconcile barrels and prove coverage; they never create files |
| `03-domain-layer.md` | Adding a New Domain Model | `gen:model` → hand-author entity/factory/mapper/repository → `gen:entity` + `gen:factory` to reconcile; `ResourceType` in BOTH places + `ALTER TYPE` migration; register in `CoreDatabaseModule`; hand-add mapper + repository barrel lines |
| `03-domain-layer.md` | Strict Rules | never `new XxxEntity()` in services — `XxxFactory.CreateXxx()`; setters route through `setProperty()`; mappers never write `_version` |
| `.claude/rules/04-application-services.md` | Service Folder Pattern | `IXxxService.ts` (symbol + interface), `xxx.service.ts`, `xxx.service.module.ts`, `xxx.dto.mapper.ts`, `dto/`, `__tests__/`, `index.ts` |
| `04-application-services.md` | NEVER | no `databaseService.client` in a service (`no-restricted-syntax`, warning in `packages/*` — treat as error); cross-tenant → `NotFoundException`, never `ForbiddenException` |
| `04-application-services.md` | Canonical CRUD Flows | create → factory → repo → `broadcastSysEvent(ResourceCreated)` → DTO; update → `updateEntity` → `hasChanges` guard → `updateWithVersion` |
| `.claude/rules/05-nestjs-api.md` | Global Request Pipeline | strict `ValidationPipe` (`whitelist + forbidNonWhitelisted + forbidUnknownValues`) — every accepted field must be declared on a DTO |
| `05-nestjs-api.md` | Optimistic Concurrency | `_version` → ETag → `If-Match` → `@RequiresIfMatch()` (missing → 428) + `@ExpectedVersion()` → `updateWithVersion` → 412 on drift |
| `05-nestjs-api.md` | Imperative Privilege Checks | any route whose real gate is in the service carries a standardized `// AUTH-NOTE:` marker and still carries a class- or handler-level decorator so the boot audit stays green |

### 3.2 Decision — registry representation: **code module served via API**

Two candidates were weighed against the two stated constraints ("the palette grows without
console deploys" and "the registry is code-owned").

| | Code module + API | Seeded catalog rows (`NodeType` table) |
|---|---|---|
| Palette grows without console deploys | Yes — the console renders the palette rail and inspector forms from the API response; a new node type is one API deploy, zero console deploys | Yes |
| Code-owned / not tenant-editable | Yes, structurally — there is no write path because there is no table | No — a DB row is writable by anything holding an extended Prisma client. Nothing prevents a later ticket adding a tenant-facing write path, and design.md D2's whole safety story is "tenants author configurations, never executable definitions" |
| Seed-vs-code default divergence | Impossible | The named repo pitfall. `seed/15-entitlements.ts:275-279` already upserts create-only *specifically* so a re-seed cannot clobber tuned values — meaning seeded rows and code constants routinely diverge in this codebase, and a parity test (`plan-matrix-parity.test.ts`) exists solely to catch it |
| Schema evolution | A node type's config schema is a TypeScript literal — refactorable, type-checked, reviewable in the diff | A JSONB column; changes are data migrations |
| Precedent | `settings-registry` (21 descriptor files → `HOPE_SETTINGS_REGISTRY` → `GET admin/settings/catalog`) | none for a code-owned vocabulary |

**Recommendation: code module served via API. No `NodeType` table.** The registry lives at
`packages/applications/src/services/workflow-registry/`, is assembled by
`WORKFLOW_NODE_REGISTRY`, and is served read-only at `GET /api/v1/admin/workflow-nodes`,
mirroring `settings-registry` exactly.

Two consequences follow and are designed for, not worked around:

1. **Per-tenant availability is still data.** The registry declares *which* entitlement gates
   a node; whether a given tenant holds it is resolved at request time via
   `IEntitlementsService.isFeatureEnabled`. The endpoint returns every node type with an
   `available: boolean` + `gatedBy` field rather than silently omitting gated ones — a
   Studio that silently omits nodes cannot explain why a workflow that used to validate no
   longer does.
2. **Registry changes must be detectable from a published row.** `registryChecksum` (sha256
   over the canonical JSON of the assembled registry) is stamped on every publish. TASK-716's
   re-validation-on-registry-bump → `NEEDS_REVIEW` flow keys off a mismatch between a
   published row's stamped checksum and the running registry's. Without this column, a
   code-owned registry has no way to tell a published definition that its vocabulary moved.

### 3.3 Decision — lineage: `parentVersionId` **and** `(slug, versionNumber)`

design.md settles `parentVersionId`; §2.2 records that it has no precedent here. Both are
implemented, and they are not redundant:

- `(tenantId, slug, versionNumber)` is the *addressing* key — monotone, uniquely indexed,
  minted as `max + 1` inside the transaction (the `prompt-management.service.ts:419-447`
  discipline).
- `parentVersionId` is the *provenance* edge. It is genuinely needed here and not in the
  prompt/schema cases because a workflow author may branch a new draft from **any** published
  version, not only the latest — the Studio's "duplicate this version" and the
  force-deprecate-with-fallback path in design.md's error handling both produce a new row
  whose parent is not `versionNumber - 1`. A monotone integer cannot express that.

### 3.4 Decision — immutability enforcement: service guard + DTO whitelist + checksum. **No DB trigger.**

The registry's own §2.2 finding is that no precedent for hard immutability exists, and that
`PromptTemplate` deliberately does the opposite (edits are permitted and neutralized by the
pin). This ticket diverges, for a reason that does not apply to prompt templates:

> design.md, Data flow §Execution: *"In-flight runs pin their version; publishes affect new
> runs only. Immutable config + pinned version = deterministic Temporal replay."*

A prompt template's un-served edit is harmless. A published `compiledConfig` that changes
under a running Temporal workflow breaks replay determinism — the failure mode is a
non-deterministic workflow error on worker pickup, days after the edit, on a clinical run.
The guard is therefore real.

Mechanism, in three layers, all of which exist in this codebase already:

1. **Service guard.** A private `assertMutable(entity)` throwing `BadRequestException` for
   `PUBLISHED`/`DEPRECATED`, called by every write path. Modelled on
   `prompt-management.service.ts:1456` `assertCanMutate` (same shape, different predicate).
2. **DTO whitelist.** `compiledConfig`, `compiledConfigChecksum`, `registryChecksum`,
   `status`, `publishedAt`, `parentVersionId`, `versionNumber`, `validationReport` and
   `isActive` are declared on **no** request DTO, so the global pipe's
   `forbidNonWhitelisted` rejects any attempt to set them over the API. This is an existing,
   deliberate technique — `department-agent.prisma:18-19`: *"`templateLocked` is deliberately
   absent from every request DTO, so the gateway's whitelist pipe rejects attempts to flip it
   over the API."*
3. **Checksum detection.** `compiledConfigChecksum` is persisted alongside `compiledConfig`;
   the interpreter (TASK-718) re-hashes on load and refuses to start on mismatch. This is the
   `AgentPromotion` drift-detection idiom (`department-agent.prisma:246-249`: "Storing both
   makes the record self-contained … and makes drift detectable: compare against the target
   agent's CURRENT checksum at read time").

**A DB trigger is explicitly rejected.** Verified: there are **zero** `CREATE TRIGGER`,
`CREATE RULE` or `CHECK` constraints across all migration folders in
`packages/database/src/prisma/db_main/migrations/` — the single grep hit is a comment
(`20260809010000_task_644_.../migration.sql:48`). Introducing the first one costs shadow-DB
replay complexity and permanent `prisma migrate diff` drift (Prisma does not model triggers),
for a guard that would also have to distinguish DRAFT from PUBLISHED rows *in the same
table*, which a row-blind trigger does awkwardly and a `REVOKE` cannot do at all.

The one DB-level precedent that does exist — `REVOKE UPDATE, DELETE`, applied to
`HarnessAuditEvent` in
`migrations/20260606143138_task_330_add_clinical_harness_eval_and_worm_audit/migration.sql:206-215`
inside a role-existence-guarded, idempotent `DO $worm$` block — is **table-level** and so
cannot be applied to a table that also holds mutable drafts. §6 records the one shape that
would make it available.

### 3.5 Decision — entitlement gating granularity: **per palette**

Recorded in §2.8 with the arithmetic. `WorkflowNodeDescriptor.entitlement` is typed
`EntitlementFeatureKey | undefined`, and the registry-assembly assertion requires that every
node type in a palette declare the *same* key as the palette (or none). Wave 1 introduces one
key, `workflowSummarizationPalette`; TASK-724 and TASK-731 add one each. Three column pairs
over the whole program, not one per node type.

### 3.6 Known pitfalls for THIS ticket

- **Never run `pnpm gen:mapper`.** It rewrites the mappers it has already processed before
  crashing, dropping the `FIELDS_NOT_WRITABLE = ['version']` strip. Recovery is
  `git checkout -- packages/domains/src/mappers/generated/core/`.
- **`ResourceType` in one place only ⇒ 500s.** Omitting either enum makes every `AuditLog`
  INSERT throw and rolls the originating mutation into a 500. Both enums plus the
  `ALTER TYPE` migration, plus the named pin in `resourceType.enum-parity.test.ts:56+`.
- **`@@unique` `name:` vs `map:`.** Getting this wrong drifts the ledger from the schema
  permanently (rule 02). Use `map:` for DB index names on `@@unique`; let Prisma generate the
  migration rather than hand-writing the index name.
- **`pnpm db:migrate` prompting for a migration name is a drift finding, not a hang** (rule
  02). Diff first.
- **Publish is not a CAS.** Copy `consultation-context-schema.service.ts:258-263` — publish
  uses `repository.update`, not `updateWithVersion`, so an unrelated concurrent metadata edit
  does not 412 the publish. Metadata `PATCH` *is* a CAS.
- **Version-number minting inside the transaction.** `max + 1` via the tx client, never
  `currentVersionNumber + 1`.
- **Seed-vs-code divergence.** The seeded platform-default definitions in
  `seed/21-workflow-definition.ts` must be produced by *compiling* a graph through the same
  code path publish uses, not by hand-writing a `compiledConfig` literal. A hand-written seed
  is a second implementation of the compiler.

---

## 4. Implementation Plan

TDD-ordered and layered per `.claude/rules/01-development-workflow.md`:
**Database → Domain → Services → API**. Each layer's gate must be green before the next
starts.

### Phase A — Database

#### Task 1 — Author the Prisma model + enum
- **Agent:** T3 · sonnet-5 · medium
- **Files:**
  - create `packages/database/src/prisma/db_main/workflow-definition.prisma`
  - modify `packages/database/src/prisma/db_main/enums.prisma`
  - modify `packages/database/src/prisma/db_main/audit.prisma` (`ResourceType`, `:103`)
- **Approach:** Copy the field order and comment discipline of
  `packages/database/src/prisma/db_main/consultation-context-schema.prisma`. One model,
  `WorkflowDefinition`; its rows ARE versions (design.md), so it keeps the standard
  `resourceStatus` lifecycle and is **not** added to `MODELS_WITHOUT_SOFT_DELETE`.

  ```prisma
  model WorkflowDefinition {
    // meta fields
    metaData Json?  @map("_metadata") @db.JsonB
    version  Int    @default(1) @map("_version")
    id       String @id @default(uuid(7))

    // multi tenant fields
    tenantId String

    // core (business) fields
    slug          String   // stable lineage key; unique per (tenant, slug, versionNumber)
    name          String
    description   String?
    paletteKey    String   // validated against the code registry, never a free string
    versionNumber Int
    parentVersionId String? // provenance edge; see §3.3. NO @relation — self-relation would
                            // put a back-reference array on every row for zero query benefit
    status WorkflowDefinitionStatus @default(DRAFT)

    // The canvas model, verbatim as authored. NEVER executed directly.
    graph Json @db.JsonB
    // sha256 over canonicalJson(graph) — drives idempotent republish.
    graphChecksum String

    // The interpreter's input contract, produced SERVER-SIDE at publish (TASK-716).
    // Null until PUBLISHED. Never accepted from a request DTO.
    compiledConfig         Json?   @db.JsonB
    compiledConfigChecksum String?
    // sha256 of the assembled node registry at publish time; a mismatch against the
    // running registry is what triggers TASK-716's NEEDS_REVIEW re-validation.
    registryChecksum String?

    // The last server-side ValidationReport (TASK-716 owns its shape).
    validationReport Json? @db.JsonB
    needsReview      Boolean @default(false)

    validatedAt  DateTime?
    publishedAt  DateTime?
    deprecatedAt DateTime?

    // The movable pointer: the version the dispatcher resolves for new runs.
    // At most one true per (tenantId, slug) among ENABLED rows — enforced in the
    // application service, mirroring ConsultationContextSchema.isDefault
    // (consultation-context-schema.prisma:49-53) and DepartmentAgent.isDefault.
    isActive Boolean @default(false)

    // resource status fields
    resourceStatus          ResourceStatusType @default(ENABLED)
    resourceStatusUpdatedAt DateTime?
    resourceStatusUpdatedBy String?

    // audit fields
    createdBy String?  @default("60000000-0000-0000-0000-000000000000")
    updatedBy String?
    createdAt DateTime @default(now())
    updatedAt DateTime @updatedAt

    tags String[] @default([])

    @@unique([tenantId, slug, versionNumber], map: "WorkflowDefinition_tenant_slug_version_unique")
    @@index([tenantId], name: "WorkflowDefinition_tenantId_idx")
    @@index([tenantId, slug, status], name: "WorkflowDefinition_tenant_slug_status_idx")
    @@index([tenantId, slug, isActive], name: "WorkflowDefinition_tenant_slug_isActive_idx")
    @@index([parentVersionId], name: "WorkflowDefinition_parentVersionId_idx")
    @@schema("core")
  }
  ```

  In `enums.prisma`, beside the `ConsultationContextSchemaStatus` block (`:266-272`):

  ```prisma
  enum WorkflowDefinitionStatus {
    DRAFT
    VALIDATED
    PUBLISHED
    DEPRECATED

    @@schema("core")
  }
  ```

  In `audit.prisma`'s `ResourceType`, add `WorkflowDefinition` with a justification comment
  modelled on `:243-251`, stating that only the definition row is audited.
- **Verify:** `pnpm db:generate` succeeds; `pnpm --filter @arcaai/database typecheck`.

#### Task 2 — Allow-lists + domain enum + parity test (RED first)
- **Agent:** T2 · sonnet-5 · low
- **Files:**
  - `packages/domains/src/enums/generated/ResourceType.ts` (`:5`–`:102`)
  - `packages/database/src/extensions/tenant-scope.ts` (`:52`)
  - `packages/domains/src/enums/__tests__/resourceType.enum-parity.test.ts` (add the named pin)
- **Approach:** Write the pin assertion for `'WorkflowDefinition'` in the parity test FIRST
  and watch it fail. Then add the member to `ResourceType.ts` (PascalCase,
  `WorkflowDefinition = 'WorkflowDefinition'`, with a comment mirroring `:90-95`). Add
  `'WorkflowDefinition'` to `TENANT_SCOPED_MODELS`. Do **not** add it to
  `SYSTEM_SHARED_READ_MODELS` — record the reason in a comment mirroring `tenant-scope.ts:244-249`:
  platform default definitions reach a tenant by the seed's clone path, not by shared read,
  so a tenant reads only its own rows and the 404-over-403 posture stays uniform.
  Do **not** touch `MODELS_WITHOUT_SOFT_DELETE`.
- **Verify:** `pnpm --filter @arcaai/domains test` (parity test green);
  `pnpm --filter @arcaai/database test` (`tenant-scope.test.ts` green).

#### Task 3 — Author the migration against a shadow DB
- **Agent:** T3 · sonnet-5 · medium
- **Files:** `packages/database/src/prisma/db_main/migrations/<ts>_task_715_workflow_definition/migration.sql`
- **Approach:** Follow `.claude/rules/02-database-prisma.md` §"Authoring a migration"
  **exactly** — shadow DB `hope_shadow`, `db:migrate:deploy` to replay the ledger,
  `pnpm --filter @arcaai/database db:migrate:create -n task_715_workflow_definition`, apply,
  then prove no drift with
  `npx prisma migrate diff --from-config-datasource --to-schema src/prisma/db_main --script`
  (must print `-- This is an empty migration.`). Unset `DATABASE_URL`/`DIRECT_URL`, run
  `pnpm db:push`, drop the shadow DB.
  Template: `migrations/20260811000000_task_658_consultation_context_schema/migration.sql`.
  Carry over its transaction-safety comment (`:17-20`) and its lock-step warning (`:25-27`).
  The enum statement is exactly
  `ALTER TYPE "core"."ResourceType" ADD VALUE IF NOT EXISTS 'WorkflowDefinition';`
- **Verify:** the `migrate diff` output above is empty; review every generated statement.

### Phase B — Domain layer

#### Task 4 — Hand-author the domain quartet
- **Agent:** T3 · sonnet-5 · medium
- **Files:**
  - `packages/domains/src/models/generated/core/WorkflowDefinitionModel.ts` (via `pnpm gen:model`)
  - `packages/domains/src/entities/generated/core/WorkflowDefinitionEntity.ts`
  - `packages/domains/src/factories/generated/core/WorkflowDefinitionFactory.ts`
  - `packages/domains/src/mappers/generated/core/WorkflowDefinitionEntityMapper.ts`
  - `packages/domains/src/repositories/generated/core/WorkflowDefinitionRepository.ts`
  - `packages/domains/src/common/databaseServices/core/core.database.module.ts` (import ~`:33`, array `:117`)
  - barrel `index.ts` at each level (mapper + repository lines by hand)
  - `packages/domains/src/entities/generated/core/__tests__/WorkflowDefinitionEntity.test.ts`
- **Approach:** `pnpm gen:model` is the ONLY scaffolding step. **Do not run `pnpm gen:mapper`
  or `pnpm gen:repository`.** Hand-author the other four following the
  `ConsultationContextSchema*` / `AiTaskDefault*` exemplars. The mapper MUST carry
  `FIELDS_NOT_WRITABLE = ['version']` + `stripNonWritableFields` — this model is OCC-written
  via `PATCH`. The repository adds two hand-written finders beyond the base contract:
  `findMaxVersionNumber(tenantId, slug, tx?)` and `findActiveForSlug(tenantId, slug, tx?)`;
  both accept an optional `tx` client so publish can run them inside the transaction. Entity
  `validate()` carries structural invariants only: `versionNumber >= 1`, `slug` matches the
  key grammar, a `PUBLISHED` row has non-null `compiledConfig` + `compiledConfigChecksum`,
  `isActive` implies `status === PUBLISHED`.
  Write the entity test first (RED) for each `validate()` clause.
- **Verify:** `pnpm --filter @arcaai/domains build` and `pnpm --filter @arcaai/domains test`;
  then `pnpm gen:entity` + `pnpm gen:factory` report no drift AND schema coverage OK.

### Phase C — Registry (application layer, no persistence)

#### Task 5 — Node registry: types, assembly, assertions (RED first)
- **Agent:** T4 · opus-5 · high
- **Files:**
  - create `packages/applications/src/services/workflow-registry/registry.types.ts`
  - create `packages/applications/src/services/workflow-registry/workflow-node-registry.ts`
  - create `packages/applications/src/services/workflow-registry/registry.ts`
  - create `packages/applications/src/services/workflow-registry/descriptors/core.nodes.ts`
  - create `packages/applications/src/services/workflow-registry/__tests__/registry.test.ts`
  - create `packages/applications/src/services/workflow-registry/index.ts`
- **Approach:** Mirror `settings-registry` file-for-file
  (`registry.types.ts` → `settings-registry.ts` → `registry.ts` → `descriptors/*.ts`).

  ```ts
  export type NodeSafetyClass = 'mandatory' | 'locked' | 'optional';

  export interface WorkflowNodePort {
    /** Port key; grammar mirrors AGENT_KIND_KEY_PATTERN (departmentAgent/constants.ts:177). */
    key: string;
    label: string;
    /** One of CONTEXT_PRIMITIVES (context-schema-definition.ts:35) or 'CONTROL'. */
    primitive: string;
    required: boolean;
  }

  export interface WorkflowNodeDescriptor {
    /** Dotted type key, e.g. `core.start`, `summarization.generate`. */
    type: string;
    category: string;
    /** Palette membership; a node may appear in more than one palette. */
    palettes: readonly string[];
    safetyClass: NodeSafetyClass;
    /**
     * Entitlement gate. Typed `EntitlementFeatureKey`, never a free string —
     * IEntitlementsService.ts:12-18 ("entitlements are COLUMN-per-key, so the type
     * system is the registry"). Gating is PER PALETTE (§3.5): the assembly asserts
     * every node in a palette declares the same key, or none.
     */
    entitlement?: EntitlementFeatureKey;
    /**
     * The sanctioned harness activity this node routes to. Closed catalogue —
     * SANCTIONED_ACTIVITY_KEYS, derived from apps/harness/src/harness/temporal/activities.py.
     * `null` for pure control-flow nodes.
     */
    activity: string | null;
    /**
     * The node's config schema, in the authorable JSON Schema subset. Validated at
     * assembly by authorableJsonSchemaProblems (@arcaai/json-schema-subset) — the SAME
     * function the Studio inspector and the SDK use, so one schema really does serve
     * three consumers (design.md §Testing strategy).
     */
    configSchema: Record<string, unknown>;
    inputs: readonly WorkflowNodePort[];
    outputs: readonly WorkflowNodePort[];
    label: string;
    description: string;
  }
  ```

  `WorkflowNodeRegistry.register()` throws — mirroring `settings-registry.ts:26,29,36,90` —
  on each of:
  1. duplicate `type`;
  2. `configSchema` producing any `authorableJsonSchemaProblems`;
  3. `activity` not in `SANCTIONED_ACTIVITY_KEYS`;
  4. a `mandatory` node declaring an `entitlement` (a mandatory safety node must never be
     gated off by a plan — the structural analogue of `settings-registry.ts:90`'s
     "kill-switch(es) must default OFF");
  5. two nodes in the same palette declaring different `entitlement` keys (§3.5);
  6. **any descriptor whose `activity` or `type` mentions signing.** `SIGNED` is unreachable
     from the substrate by construction (design.md Plane 1); this assertion is what makes
     "by construction" a test rather than a promise.

  `WORKFLOW_NODE_REGISTRY` also exposes `checksum()` — `sha256(canonicalJson(descriptors))`,
  reusing `canonicalJson` from `context-schema-definition.ts:346`. This is the value stamped
  into `WorkflowDefinition.registryChecksum`.

  `descriptors/core.nodes.ts` ships exactly two palette-independent types this wave:
  `core.start` (safetyClass `mandatory`, `activity: null`) and `core.end` (`mandatory`,
  `activity: null`). Palette content is TASK-720/724/731.

  Tests first, one per assertion, each asserting the exact thrown message.
- **Verify:** `pnpm --filter @arcaai/applications test -- workflow-registry` — all assertion
  tests green; `pnpm --filter @arcaai/applications build`.

#### Task 6 — Add the summarization palette entitlement column pair
- **Agent:** T2 · sonnet-5 · low
- **Files:**
  - `packages/database/src/prisma/db_main/entitlement.prisma` (`PlanEntitlement` `:99`,
    `TenantEntitlement` `:182`)
  - `packages/applications/src/services/entitlements/resolve-entitlements.ts` (`ResolvedFeatures` `:48`)
  - `packages/applications/src/services/entitlements/entitlements.constants.ts` (`PLAN_ENTITLEMENT_DEFAULTS` `:180`)
  - `packages/database/src/prisma/db_main/seed/15-entitlements.ts` (`PlanEntitlementSeed` `:125`, `PLAN_ENTITLEMENTS` `:208`)
  - a migration folder (fold into Task 3's migration if authored in the same pass)
- **Approach:** Add `featureWorkflowSummarizationPalette Boolean @default(false)` to
  `PlanEntitlement` and `featureWorkflowSummarizationPalette Boolean?` to `TenantEntitlement`
  (tri-state: null inherit / true grant / false explicit deny — `entitlement.prisma:186-193`).
  Add `workflowSummarizationPalette: boolean` to `ResolvedFeatures`. Seed matrix: `false` for
  `STARTER`, `true` for `TRIAL`/`PRO`/`ENTERPRISE` (matching `featureDnaReports`). Mirror into
  `entitlements.constants.ts:180` or the parity test fails.
- **Verify:** `pnpm --filter @arcaai/applications test -- plan-matrix-parity` green.

### Phase D — Application service

#### Task 7 — Service, DTOs, mapper, module (RED first)
- **Agent:** T3 · opus-4-8 · high
- **Files:** create under `packages/applications/src/services/workflow-definition/`:
  `IWorkflowDefinitionService.ts`, `workflow-definition.service.ts`,
  `workflow-definition.service.module.ts`, `workflow-definition.dto.mapper.ts`,
  `dto/` (`create-workflow-definition.request.ts`,
  `update-workflow-definition.request.ts`, `publish-workflow-definition.request.ts`,
  `new-version.request.ts`, `activate-workflow-definition.request.ts`,
  `workflow-definition.response.ts`, `workflow-definition-summary.response.ts`),
  `__tests__/workflow-definition.service.test.ts`, `index.ts`
- **Approach:** Exemplar folder:
  `packages/applications/src/services/consultation-context-schema/`. Exemplar method:
  its `publish` at `:200`.

  Method surface on `IWorkflowDefinitionService` (symbol token per rule 04):

  | Method | Notes |
  |---|---|
  | `create(dto)` | mints `versionNumber: 1`, `status: DRAFT`, `graphChecksum`; quota precheck via `entitlements?.assertQuantityQuota` following `prompt-management.service.ts:225-229` |
  | `list(query)` / `listPaginated(query)` | `PaginatedQuery` + `withFormattedPaginatedProps` → `ToPaginatedResponse` (rule 04) |
  | `findById(id)` | ownership check → `NotFoundException` on cross-tenant |
  | `listVersions(slug)` | the lineage read |
  | `update(id, dto, expectedVersion)` | `assertMutable` FIRST → `updateEntity` → `hasChanges` guard → `updateWithVersion` |
  | `validate(id)` | delegates to the injected `IWorkflowValidatorService` port; persists `validationReport`, sets `status: VALIDATED` on a clean report, `validatedAt` |
  | `publish(id, dto)` | re-runs validation SERVER-SIDE; refuses on any error-severity finding; stamps `compiledConfig` + both checksums + `registryChecksum`; `status: PUBLISHED`; `publishedAt`; checksum-idempotent |
  | `newVersion(id, dto)` | clones a PUBLISHED row into a new `DRAFT` with `parentVersionId = <source id>` and `versionNumber = max + 1` inside the transaction |
  | `activate(id)` | moves the pointer: clears `isActive` on the current active row and sets it on this one, in ONE transaction; refuses a non-PUBLISHED row |
  | `deprecate(id, dto)` | `status: DEPRECATED`, `deprecatedAt`; refuses if `isActive` |
  | `softDelete(id)` | DRAFT only |

  Rules that must be visibly satisfied in the code:
  - `assertOwnedByTenant` throws `NotFoundException`, never `ForbiddenException` (404-over-403).
  - Every mutation ends in `this.broadcastSysEvent(...)`: `ResourceCreated` on create/newVersion;
    `ResourceUpdated` with `data.action` ∈ `'validate' | 'publish' | 'activate' | 'deprecate'`
    plus `previousVersion`/`newVersion` on the rest; `ResourceDeleted` on delete.
    Payload shape copied from `consultation-context-schema.service.ts:265-278`.
  - `assertMutable(entity)` — the §3.4 guard.
  - Publish uses `repository.update`, NOT `updateWithVersion`
    (`consultation-context-schema.service.ts:258-263`).
  - `activate` runs inside `this.databaseService.baseClient.$transaction(callback)` — the
    at-most-one-active invariant is application-enforced, exactly as
    `consultation-context-schema.prisma:49-53` records for `isDefault`.
  - No `databaseService.client` in this service (rule 04's `no-restricted-syntax`).

  Response DTOs expose `versionNumber`, `status`, `isActive`, `parentVersionId`,
  `graphChecksum`, `registryChecksum` and the `_version` OCC token — the
  `prompt-management.dto.mapper.ts:18-21` lesson applies verbatim ("Without it the console
  cannot distinguish 'approved and running v3' from 'edited to v5 since'").

  Tests (written first, all RED): factory used on create; `broadcastSysEvent` on every
  mutation; cross-tenant id → 404 (reuse `tests/cross-tenant/fixtures.ts`); `assertMutable`
  rejects an update to a PUBLISHED row; idempotent republish writes nothing; `activate`
  clears the previous active row; `deprecate` refuses an active row; publish refuses when the
  validator port returns any error-severity finding.
- **Verify:** `pnpm --filter @arcaai/applications test -- workflow-definition` and
  `pnpm --filter @arcaai/applications build`.

#### Task 8 — The validator port + stub
- **Agent:** T2 · sonnet-5 · low
- **Files:**
  - create `packages/applications/src/services/workflow-definition/IWorkflowValidatorService.ts`
  - create `packages/applications/src/services/workflow-definition/__tests__/validator-stub.test.ts`
- **Approach:** Declare the symbol token + interface only:
  `validate(input: { graph: unknown; paletteKey: string; tenantId: string }): Promise<ValidationReportShape>`
  where `ValidationReportShape` is declared **here** as the minimal contract the lifecycle
  needs (`{ ok: boolean; findings: Array<{ nodeId: string | null; severity: 'error' | 'warning'; ruleId: string; message: string }>; compiledConfig: unknown | null }`) and
  **owned/extended by TASK-716**. Ship a stub provider returning
  `{ ok: true, findings: [], compiledConfig: null }` so the lifecycle is testable; TASK-716
  replaces the provider binding, not the port.
  Note in the file header that publish must refuse when `compiledConfig` is null once
  TASK-716 lands — the stub's null is why Wave 1's publish path is not production-reachable
  until then.
- **Verify:** `pnpm --filter @arcaai/applications test`.

### Phase E — API

#### Task 9 — Controllers (definition + registry)
- **Agent:** T3 · sonnet-5 · medium
- **Files:** create under `apps/api/src/modules/workflow-definition/`:
  `workflow-definition.controller.ts`, `workflow-node-registry.controller.ts`,
  `workflow-definition.module.ts`, `__tests__/workflow-definition.controller.test.ts`
- **Approach:** Exemplar:
  `apps/api/src/modules/consultation-context-schema/consultation-context-schema.controller.ts`.

  ```
  @Controller('admin/workflows')
  @CanManage('WorkflowDefinition')     // class-level: `manage`, NOT `read` —
                                       // prompt-management.controller.ts:31-41's reasoning
    GET    /                          list (paginated)
    GET    /:id
    GET    /:slug/versions
    POST   /                          create draft
    PATCH  /:id      @RequiresIfMatch() + @ExpectedVersion()
    POST   /:id/validate
    POST   /:id/publish               @RequiresIfMatch() + @ExpectedVersion()
    POST   /:id/versions              new draft from this version
    POST   /:id/activate              @RequiresIfMatch() + @ExpectedVersion()
    POST   /:id/deprecate             @RequiresIfMatch() + @ExpectedVersion()
    DELETE /:id

  @Controller('admin/workflow-nodes')
  @Authorize()                        // any authenticated caller in the tenant; the
                                      // registry is a read-only vocabulary, and the
                                      // Studio's read-only viewers need it
    GET    /                          the registry, entitlement-annotated + ETag'd by checksum
  ```

  The header/body precedence idiom for `@ExpectedVersion()` is copied verbatim from
  `prompt-management.controller.ts:186-190`. 412 = drift, 428 = missing `If-Match`, both
  documented with `@ApiResponse`.

  No route may read Prisma or `process.env.<downstream URL>` (rule 05 —
  `no-controller-direct-prisma` is a HARD ERROR in `apps/api`).

  If any route's real gate ends up imperative in the service, it carries a
  `// AUTH-NOTE:` marker in the form of `prompt-management.controller.ts:338-344`.

  Register the module in `apps/api/src/app.module.ts`.
- **Verify:** `pnpm api:build`; `pnpm test:unit`.

#### Task 10 — E2E incl. cross-tenant
- **Agent:** T2 · sonnet-5 · medium
- **Files:** create `apps/api/tests/e2e/task-715-workflow-definition.spec.ts`,
  `apps/api/tests/e2e/task-715-workflow-definition-cross-tenant.spec.ts`
- **Approach:** Model the cross-tenant spec on the existing
  `apps/api/tests/e2e/task-307-*-cross-tenant.spec.ts` files (rule 05: "new admin/by-id
  surfaces need equivalent coverage"). Cover: full lifecycle
  draft → validate → publish → activate → new version → deprecate; `PATCH` without `If-Match`
  → 428; stale `If-Match` → 412; `PATCH` on a PUBLISHED row → 400; every by-id route with
  another tenant's id → 404 (never 403); the registry endpoint returns `available: false`
  with a `gatedBy` key for a plan that lacks the palette entitlement (with
  `entitlements.enabled` toggled ON in-test via `setEnforcementEnabled`).
- **Verify:** `pnpm test:up:api` (terminal 1) then `pnpm test:e2e`.

### Phase F — Seeds

#### Task 11 — Platform default definitions
- **Agent:** T2 · sonnet-5 · medium
- **Files:** create `packages/database/src/prisma/db_main/seed/21-workflow-definition.ts`;
  modify `packages/database/src/prisma/db_main/seed/index.ts` and
  `packages/database/src/prisma/db_main/seed/00-constants.ts`
- **Approach:** Follow `seed/07a-agent-golden-library.ts`. Seed SYSTEM-tenant
  (`00000000-0000-0000-0000-000000000000`) `PUBLISHED` + `isActive` rows — one per palette
  that exists (Wave 1: a single minimal `core.start → core.end` definition per palette key
  that is registered). Upsert **create-only** (`update: {}`), the
  `seed/15-entitlements.ts:275-279` discipline, so a re-seed never clobbers an admin edit.

  **The seed must compile its `compiledConfig` by calling the same code path publish uses**,
  not by embedding a literal — a hand-written `compiledConfig` is a second implementation of
  the compiler and will drift (§3.6). Because `packages/database` must not depend on
  `@arcaai/applications` (the constraint recorded at `seed/15-entitlements.ts:30`), the
  compiler entry point must be reachable from a dependency-free module; TASK-716 places it in
  a package both can import. Until TASK-716 lands, the seed writes `status: VALIDATED` with a
  null `compiledConfig` and a TODO naming TASK-716 — a `VALIDATED` platform default is inert
  but honest; a fabricated `compiledConfig` is not.
- **Verify:** `pnpm db:seed` on a fresh local DB; then `pnpm db:seed` again (idempotent, no
  rows changed).

---

## 5. Acceptance Criteria

Paste **actual command output** as evidence for every box; a claim without output is not done
(`.claude/rules/01-development-workflow.md` §Anti-Patterns).

- [ ] `pnpm db:generate` succeeds; `pnpm --filter @arcaai/database test` passes
- [ ] `npx prisma migrate diff --from-config-datasource --to-schema src/prisma/db_main --script`
      prints `-- This is an empty migration.` against the shadow DB after the new migration applies
- [ ] `pnpm --filter @arcaai/domains build` and `pnpm --filter @arcaai/domains test` pass
- [ ] `pnpm gen:model`, `pnpm gen:entity`, `pnpm gen:factory` (`:check` variants) report no
      drift **and** schema coverage OK. **`pnpm gen:mapper` was NOT run** (state this explicitly)
- [ ] `packages/domains/src/enums/__tests__/resourceType.enum-parity.test.ts` passes with a
      named pin for `WorkflowDefinition`
- [ ] `packages/database/src/extensions/__tests__/tenant-scope.test.ts` passes
- [ ] `packages/applications/src/services/entitlements/__tests__/plan-matrix-parity.test.ts` passes
- [ ] `pnpm --filter @arcaai/applications build` and `pnpm --filter @arcaai/applications test` pass
- [ ] Registry assembly assertion tests pass, **including the "no signing node type" assertion**
- [ ] `pnpm api:build` and `pnpm test:unit` pass
- [ ] `pnpm test:up:api` + `pnpm test:e2e` — the lifecycle spec and the cross-tenant spec pass;
      every by-id route returns **404** (not 403) for another tenant's id
- [ ] `pnpm db:seed` is idempotent (run twice; second run changes no rows)
- [ ] `pnpm lint` and `pnpm typecheck:all` clean — including `packages/*` `only-warn` warnings,
      which are treated as errors (rule 01)
- [ ] `WorkflowDefinition` mapper carries `FIELDS_NOT_WRITABLE = ['version']`
- [ ] No request DTO declares `compiledConfig`, `compiledConfigChecksum`, `registryChecksum`,
      `status`, `publishedAt`, `parentVersionId`, `versionNumber`, `validationReport` or `isActive`
- [ ] Ticket README updated with an Implementation Summary and the files changed

---

## 6. Risks & Open Questions

1. **Single-table versions vs. the house governance triple.** design.md settles a single
   `WorkflowDefinition` whose rows are versions; the repo's three shipped instances all use
   head + immutable version + movable pin (§2.2). The single-table shape is defensible here
   because a published version IS the addressable product — TASK-722 binds
   `/api/v1/workflows/:slug` to it, runs pin a `workflowVersionId`, and TASK-723's trajectory
   rows join to it — so a head/version split would give two identities to one thing, and the
   "version" would need its own status, entitlement, activation and audit lifecycle, i.e. it
   would BE the head. Recorded so a later reviewer sees the divergence was deliberate.
2. **HUMAN-GATED — no DB-level immutability.** §3.4 rejects a trigger and shows why `REVOKE`
   cannot apply to a mixed draft/published table. If a reviewer requires DB-level enforcement
   of the published bytes, the migration path is an append-only
   `WorkflowVersionPublication` table (compiled config + both checksums + publisher + at) with
   `REVOKE UPDATE, DELETE` in the `HarnessAuditEvent` idiom
   (`migrations/20260606143138_task_330_.../migration.sql:206-215`) — a second table, not a
   trigger. Not built here to avoid gold-plating; the decision needs a human. **Answer**: Lets review, suggest best practices.
3. **Palette-level entitlement granularity closes design.md open question 5** — but only
   because entitlements are column-per-key today. If a future ticket generalizes entitlements
   to a key/value table, per-node-type gating becomes cheap and this decision should be
   revisited.
4. **The registry endpoint is a new public-ish surface.** It exposes the platform's whole node
   vocabulary to any authenticated tenant user. That is intended (the Studio needs it and node
   types are not secrets), but it means a node type's `description` is tenant-visible copy —
   reviewers should read descriptors as product text, not internal notes.
5. **`paletteKey` is a `String` column, not an enum.** Deliberate: palettes are registry data,
   and a Prisma enum would need an `ALTER TYPE` migration per palette — the exact deploy
   coupling the code-owned registry exists to avoid. The service validates it against the
   registry on every write, so an unknown palette is a 400, not a bad row.
6. **Publish is not reachable in production until TASK-716 lands.** The stub validator returns
   a null `compiledConfig` and the entity's `validate()` requires a non-null one on a
   `PUBLISHED` row. This is intentional: it makes the dependency a compile/runtime fact rather
   than a coordination promise. It also means Task 11's seed lands at `VALIDATED`, and
   TASK-716 must include a follow-up task that re-seeds it to `PUBLISHED`.
7. **`registryChecksum` couples the substrate to registry ordering.** `canonicalJson` sorts
   keys, but descriptor **array order** must also be stable or every deploy looks like a
   registry bump and flags every published definition `NEEDS_REVIEW`. The registry's
   `checksum()` must sort descriptors by `type` before hashing — called out here because it is
   easy to miss and its failure mode is a flood of false NEEDS_REVIEW notifications.

---

## 7. Implementation Summary

**Scope actually executed in this pass: Phase A (Database) only** — this agent owned
`packages/database` exclusively for this phase; Phases B–F (domain layer, registry,
application service, API, seeds) are NOT started and are left for follow-on agents/passes.

### What landed (Task 1, the database portion of Task 2, Task 3-authoring)

- **Task 1 — Prisma model + enums**: created
  `packages/database/src/prisma/db_main/workflow-definition.prisma` with the `WorkflowDefinition`
  model exactly as specified in §4 Task 1 (standard field template order: meta → tenant →
  business → resource status → audit → tags → indexes; `uuid(7)` id; `_version` OCC;
  `tenantId` NOT NULL, no FK). Added `WorkflowDefinitionStatus` (`DRAFT | VALIDATED | PUBLISHED |
  DEPRECATED`) to `packages/database/src/prisma/db_main/enums.prisma`, next to
  `ConsultationContextSchemaStatus`. Added `WorkflowDefinition` to the `ResourceType` enum in
  `packages/database/src/prisma/db_main/audit.prisma` with a justification comment mirroring the
  `ConsultationContextSchema` precedent.
- **Task 2 (database portion only)**: added `'WorkflowDefinition'` to `TENANT_SCOPED_MODELS` in
  `packages/database/src/extensions/tenant-scope.ts` (NOT added to `SYSTEM_SHARED_READ_MODELS`,
  per the ticket's rationale — a tenant reads only its own definitions; platform defaults reach a
  tenant via the seed's clone path). Updated the `tenant-scope.test.ts` size tripwire 76 → 77 with
  a dated comment. Did **not** touch `MODELS_WITHOUT_SOFT_DELETE` (correct — the model keeps
  `resourceStatus`).
  **NOT done (out of this agent's scope, `packages/domains`)**: adding `WorkflowDefinition` to
  `packages/domains/src/enums/generated/ResourceType.ts` and the named pin in
  `resourceType.enum-parity.test.ts`. Verified this leaves `resourceType.enum-parity.test.ts`
  RED (see Verification below) — this is the **expected, single known gap** a domains-layer pass
  must close before Task 4 (or before this parity test is asserted "done" in the acceptance
  criteria). No other packages/domains file was touched.
- **Task 3 — migration authoring (no execution)**: hand-authored
  `packages/database/src/prisma/db_main/migrations/20260816020000_task_715_workflow_definition/migration.sql`
  by copying the `20260811000000_task_658_consultation_context_schema` template's structure
  (`CREATE TYPE` → `ALTER TYPE ... ADD VALUE IF NOT EXISTS` → `CREATE TABLE` → `CREATE INDEX` ×4
  → `CREATE UNIQUE INDEX`). Column names/types/order were cross-checked against the Prisma-7
  generated client output (`packages/database/src/generated/core-prisma-client/models/WorkflowDefinition.ts`,
  produced by `pnpm db:generate`, which the schema-parse step of `db:generate` DOES run without a
  live DB) rather than against a live migration diff.

### What was NOT done / explicitly gated

- **The shadow-DB proof (rule 02 §Migration Workflow) could NOT be run.** Local infra is down (no
  Postgres) and the hard rules for this pass forbid `db:migrate*` / `db push` /
  `prisma migrate diff` regardless. The migration SQL above is **unverified against a live
  `prisma migrate diff`** — a follow-up pass with infra up MUST run the shadow-DB sequence from
  rule 02 (`hope_shadow` → `db:migrate:deploy` → `db:migrate:create -n task_715_workflow_definition`
  should report **no new migration needed** since one was hand-authored; the correct check is
  applying this hand-authored migration to the shadow DB, then `prisma migrate diff
  --from-config-datasource --to-schema src/prisma/db_main --script` must print
  `-- This is an empty migration.`) before this is trusted in CI.
- Phases B (domain quartet), C (registry), D (application service + validator port), E
  (controllers + e2e), F (seeds) — none started. Task 6 (entitlement column pair) and Task 11
  (seed) both touch `packages/database` too but were left for the phase(s) that own the
  registry/entitlements design they depend on, per this agent's explicit "packages/database this
  phase" scope.
- **`pnpm gen:mapper` was NOT run** (forbidden; also not yet relevant — no domain layer exists
  yet for this model).
- **HUMAN-GATED open question (ticket §6 #2, restated here as required)**: this ticket's
  DB-level-immutability question is still open. §3.4 recommends service guard + DTO whitelist +
  checksum with **no DB trigger and no `REVOKE`**, and that recommendation is what the schema
  above implements (no trigger/rule/check was added — verified zero `CREATE TRIGGER`/`CREATE
  RULE` in this migration). If a reviewer wants DB-level enforcement of published bytes, the
  ticket's own answer is a second, append-only `WorkflowVersionPublication` table with `REVOKE
  UPDATE, DELETE` (the `HarnessAuditEvent` idiom) — not built, needs a human decision before any
  agent builds it.

### Verification (actual output)

```
$ pnpm --filter @arcaai/database db:generate
✔ Generated Prisma Client (7.9.1) to ./src/generated/core-prisma-client in 356ms
✅ Index file generated successfully!

$ pnpm --filter @arcaai/database typecheck
> tsc --noEmit
(clean, no output)

$ pnpm --filter @arcaai/database build
> tsc
(clean, no output)

$ pnpm --filter @arcaai/database test
 Test Files  51 passed (51)
      Tests  1237 passed (1237)
```

Cross-check that the parity gap is exactly the expected one (this test lives in
`packages/domains`, out of this agent's scope — run read-only to confirm the boundary, not fixed):

```
$ pnpm --filter @arcaai/domains test -- resourceType.enum-parity
 FAIL  src/enums/__tests__/resourceType.enum-parity.test.ts
   × every database ResourceType value exists in the domain enum
   AssertionError: Database ResourceType values are missing from the domain enum.
   Add each to packages/domains/src/enums/generated/ResourceType.ts: WorkflowDefinition
 Test Files  1 failed | 141 passed | 2 skipped (144)
      Tests  1 failed | 1719 passed | 2 skipped | 9 todo (1731)
```

This is the sole, expected, pre-identified failure — the fix is a one-line addition to
`packages/domains/src/enums/generated/ResourceType.ts` plus a named pin in the parity test,
both explicitly out of this pass's `packages/database`-only scope.

**Not run** (forbidden this pass / infra down): `pnpm db:migrate*`, `pnpm db push`,
`npx prisma migrate diff`, `pnpm db:seed`, `pnpm lint` (repo-root aggregate — orchestrator's job),
`pnpm --filter @arcaai/database test:cov`.

---

## 8. Change History

| Date | Change | By |
|---|---|---|
| 2026-08-16 | Ticket authored | ticket-writer agent (Wave 1 substrate foundations) |
| 2026-08-16 | Phase A (Database) executed: `WorkflowDefinition` model + `WorkflowDefinitionStatus` enum + `ResourceType` DB-enum addition ([Task 1](#task-1--author-the-prisma-model--enum)); `TENANT_SCOPED_MODELS` allow-list + drift-guard test updated (database portion of [Task 2](#task-2--allow-lists--domain-enum--parity-test-red-first)); migration hand-authored, shadow-DB proof NOT run (infra down + forbidden this pass) ([Task 3](#task-3--author-the-migration-against-a-shadow-db)). Domains-layer half of Task 2 (`ResourceType.ts` + parity-test pin) explicitly NOT done — confirmed as the sole resulting `resourceType.enum-parity.test.ts` failure. Phases B–F not started. See §7 for full detail and verification output. | packages/database execution agent |
