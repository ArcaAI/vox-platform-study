# TASK-721 — Workbench

| | |
|---|---|
| **Status** | Pending |
| **Wave** | 2 · **Size** | M |
| **Epic slug** | `workbench` |
| **Depends on** | TASK-718 (`workflow-interpreter`), TASK-719 (`workflow-studio-v1`) |
| **Design refs** | D2, D3, D4 from [design.md](../../architecture/agentic-workflow-platform/design.md) §"Plane 3 — Workflow Studio" (Workbench paragraph), §"Error handling" (runtime), §"Testing strategy" |
| **Findings closed** | — |

## 1. Requirement Analysis

Deliver the **Workbench**: the surface where a tenant admin runs a workflow definition — DRAFT or
published — through the interpreter in **sandbox mode** against synthetic inputs, watches progress
live, and inspects per-node inputs/outputs/timings.

design.md §Plane 3 states it in one sentence: *"**Workbench** (extends the playground tier):
sandboxed interpreter runs against synthetic sessions — test a workflow, an agent node, a tool/MCP
binding, memory behavior, STT, and text generation. Sandbox mode never writes external artifacts and
cannot reach a signed state (structurally true — the substrate has no signing node)."*

Scope:

1. **Run a definition in sandbox mode** — DRAFT or published — against a chosen synthetic input.
2. **Live progress via SSE** while the run executes.
3. **Per-node inspection** — input, output, timing, status, for each node of the run.
4. **Isolated node test** — run a single node's config (agent node, tool/MCP binding) on its own,
   where the palette's node-type descriptor declares it independently runnable.
5. **Fixture management** — per-tenant saved synthetic test inputs (create / edit / pick / delete).
6. **Sandbox containment guardrail** — sandbox artifacts are visibly watermarked in the UI and
   excluded by default from every real-data surface.

STT and text-generation quick tests are **explicitly delegated, not re-implemented** — see §2.3.

### Explicitly OUT of scope

| Out | Owner / reason |
|---|---|
| The sandbox execution mode itself (interpreter flag, external-write suppression) | TASK-718 — this ticket consumes its contract |
| The canvas composite, the graph store, the inspector generator | TASK-719 — reused, not rebuilt |
| The runs list, the run read model, historical run browsing | TASK-723 |
| Node types / palette content | TASK-720 |
| A general STT playground, a general text-generation playground, guardrail/NER testing | Already shipped as `/playground/live-transcription` and `/playground/llm` (§2.3) |
| Memory-management screens | TASK-728 |
| Exposing sandbox runs over the REST/SSE channel plane | TASK-722 |
| Any path that could produce a signable or signed artifact | Structurally impossible — asserted, never implemented |

## 2. Current State Evaluation

### 2.1 The playground tier as it actually works

Verified in `apps/admin-console/src/shared/navigation/nav-config.ts`:

- `NavTier` is `'10-19' | '20-29' | '30-49' | '50-59'` (line 63); `NAV_SECTIONS` labels `'50-59'`
  as `Playground` (line 88).
- The five playground entries are at lines 427–438. **All five carry `required: []`**, e.g.
  `{ route: '/playground/llm', label: 'Agent Playground', tier: '50-59', icon: IconSparkles,
  required: [], implemented: true }` (line 438).
- The comment above them (lines 421–426) states why: *"End-user demo planes run under the admin's
  OWN account, so the backend guards are plain `@Authorize()` — visibility is role-gated
  (GLOBAL_ADMIN or TENANT_ADMIN) via `visibleNavEntries`, mirroring the (tenant) tier guard."*
- The role gate is imperative, not ability-based: `visibleNavEntries` (line 455) does
  `if (entry.tier === '50-59' && !isAdminTier(roles)) return false;` (line 459), where
  `isAdminTier` (line 442) is `isElevated(roles) || roles?.includes('TENANT_ADMIN')`.
- `NavEntry.required` is documented (lines 71–75) as *"visible when ANY pair is granted… An empty
  list means any authenticated user"*, and `visibleNavEntries` line 460 reads
  `entry.required.length === 0 ? !!rules : canAny(rules, entry.required)`.

Routing: the playground screens live at
`apps/admin-console/src/app/(console)/(tenant)/playground/{consultation,live-transcription,llm,voice-profiles,dna-writing-style}/page.tsx`
— i.e. **inside the `(tenant)` route group**, so they inherit its tier guard
(`app/(console)/(tenant)/layout.tsx`: `notFound()` unless `isElevated` or `TENANT_ADMIN`). Rule 13
§Routing records this exactly: tier 50–59 has no route group of its own and is gated at the nav level
by a role check.

Each page is a thin routing file (`metadata` + one feature component) — e.g.
`app/(console)/(tenant)/playground/llm/page.tsx`.

### 2.2 Playground shared building blocks (REUSE)

`apps/admin-console/src/features/playground-shared/components/`:

| File | What it gives |
|---|---|
| `run-bar.tsx` | `RunBar` — the single Run/Stop affordance plus connection + progress chips. `ConnectionState = 'idle' \| 'connecting' \| 'live' \| 'closed' \| 'error'`; the `CONNECTION` map (lines 12–17) pairs each state with a **label**, because "rule 11 §7: color is never the only signal" |
| `playground-canvas.tsx` | `CanvasHeader` (the page's own `h1`, one per page per rule 11 §6) + the centred playground work column that "reads configure → run → result top-to-bottom" |
| `playground-persona-bar.tsx`, `persona-control.tsx` | The acting-as/impersonation control the playground e2e spec asserts (`tests/e2e/playground.spec.ts`) |

`apps/admin-console/src/shared/page/playground-banner.tsx` — `PlaygroundBanner`, a
`role="note"` primary-tinted strip designed for the `statusBanner` slot of `ScreenTemplate`. This is
the exact pattern the sandbox watermark should extend.

### 2.3 STT and text-generation quick tests already exist — do not rebuild them

| Existing surface | Route | Feature module | Covers |
|---|---|---|---|
| **Agent Playground** | `/playground/llm` (`nav-config.ts:438`) | `features/playground-llm/` — `playground-llm-screen.tsx`, `prompt-editor-card.tsx`, `providers-card.tsx`, `output-pane.tsx`, `guardrails-tab.tsx`, `ner-tab.tsx`, `template-picker.tsx` | Text generation (sync + streaming), guardrails, NER. Client calls `text/providers`, `text/guardrail-providers`, `admin/prompt-templates` (`features/playground-llm/api/client.ts`) |
| **Live Transcription** | `/playground/live-transcription` (`nav-config.ts:428`) | `features/playground-live-transcription/` | STT streaming |
| **Consultation Demo** | `/playground/consultation` (`nav-config.ts:427`) | `features/playground-consultation/` (incl. a `scribe/` sub-surface) | End-to-end `@arcaai/vox` consultation |

**Ruling: the Workbench links to these; it does not embed or duplicate them.** Embedding would
require a cross-feature import, which rule 13 §Structure forbids ("features never import each
other"). The Workbench therefore carries plain `href` deep links, and reuses only `playground-shared`
and `@/shared/*`, which are cross-feature by design.

There is also an existing **prompt-template test-run** surface —
`features/agents/components/test-run-panel.tsx` — which uses `useTaskStream` from `@/shared/streams`
and `useTestTemplate`/`useFinalizeTemplateTest`. It is the closest existing "configure → run →
inspect result" precedent in the console and is the template for the Workbench's isolated-node panel.

### 2.4 Streaming: the house SSE contract (REUSE, do not hand-roll)

`apps/admin-console/src/shared/streams/`:

- `use-event-stream.ts` — `useEventStream({ path, scope, eventNames, onEvent, maxRetries, enabled })`
  returning `{ status, error, close, reopen }`. It mints a **single-use ticket** through the BFF
  (`POST /api/auth/stream-ticket`, `StreamTicketResponse { ticket, expiresAt, scope }`) and then
  connects the browser **DIRECTLY to the gateway**: `streamUrl()` builds
  `${publicEnv.apiHost}/api/v1/${path}?ticket=…`. Its header comment states the rule: *"rule 13:
  JWTs never appear in URLs — streams authenticate with single-use ~30s tickets minted through the
  BFF"*. `scope` must match the route's `@StreamScope` declaration or the gateway rejects the ticket.
- `use-task-stream.ts` — the SMR task-stream consumer, with a documented replay hazard: the endpoint
  reads `last_event_id` from the query string only, so **every reconnect replays from 0-0**; the hook
  therefore sets `maxRetries: 0` and recovers via an explicit `reopen()`.
- `index.ts` exports `useEventStream`, `useTaskStream`, `taskStreamPath`, `taskStreamScope`.

Live-progress precedent for a run: `features/ai-operations-runs/api/client.ts` defines
`trajectoryStreamPath(consultationId)` → `consultations/{id}/trajectory/stream` and
`trajectoryStreamScope(consultationId)` → `consultation_trajectory:{id}`.

### 2.5 The trajectory read plane the Workbench inspects

- Model: `packages/database/src/prisma/db_main/agent-trajectory.prisma:62` — `AgentTrajectoryStep`.
  Fields relevant here: `sessionKind` (`AgentSessionKind`, line 29: `LIVE_DOC | HARNESS_DOC |
  SUMMARY_JOB | EVAL_RUN`), `sessionId`, `runId` (non-null `""` sentinel, lines 78–85), `seq`,
  `stepType` (line 38), `name`, `status` (line 52: `STARTED | OK | ERROR | SKIPPED | TIMEOUT`),
  `startedAt`/`endedAt`/`durationMs`, `stats` JsonB, `payloadRef` JsonB, `errorCode`,
  `correlationId`.
  **PHI posture, stated in the file header (lines 8–11): "Stats-first / payload-by-reference … any
  prompt/note/thinking payload is stored ONLY as a claim-check ref / encrypted pointer in
  `payloadRef` — never plaintext clinical content in this ops table."**
- Read API: `apps/api/src/modules/agent-trajectory/agent-trajectory.controller.ts` —
  `@Controller('admin/agent-trajectory')` (line 36), class-level `@CanRead('AgentTrajectory')`
  (line 37); routes `GET metrics/generation` (45), `GET sessions` (64),
  `GET sessions/:sessionId/steps` (83).
- Service contract: `packages/applications/src/services/agent-trajectory/IAgentTrajectoryService.ts`
  — `listSessions` (offset), `listSteps` (**keyset**, `ListTrajectoryStepsOptions { runId?, cursor?,
  limit? }`), `aggregateGenerationStats`, `pruneOlderThan`, and `recordSteps` (idempotent on
  `(tenantId, sessionId, runId, seq)`, emitting **no** sys-event — telemetry exemption).

### 2.6 No sandbox mode exists today

`grep -rln "sandbox\|dry_run\|dryRun"` over `apps/harness/src/harness` (excluding `__pycache__`)
matches only `temporal/models.py`, `temporal/workflows.py` and `api/endpoints/internal.py`, and every
match refers to **Temporal's own workflow sandbox** (e.g. `internal.py:85` "stay importable without
loading the workflow sandbox"; `models.py:391` "stays deterministic/sandbox-safe"). There is no
application-level sandbox/dry-run mode. **TASK-718 must provide it; this ticket must not invent it.**

Existing `@workflow.defn` classes (`apps/harness/src/harness/temporal/workflows.py`):
`HarnessPingWorkflow` (261), `HarnessDocWorkflow` (279), `SpecialistWorkflow` (1802),
`ConsultationLoopWorkflow` (1876) — the last is a documented deprecation (design.md §Deprecations).

### 2.7 There is no generic per-tenant test-fixture store

The closest existing store is the harness eval golden-set family
(`packages/database/src/prisma/db_main/harness.prisma`): `GoldenSet` (line 43) with
`name`/`description`/`pinnedVersion`/`departmentId`, and `GoldenCase` (line 82) whose payload columns
are `encryptedTranscript` / `encryptedReferenceNote` / `keyVersion` — the comment records that *"The
plaintext transcript / referenceNote columns have been DROPPED; persisted as Vault-Transit ciphertext
only."*

**Verdict: golden sets are not reusable as Workbench fixtures.** They model a consultation transcript
plus a reference note under a PHI encryption regime. A generic synthetic workflow input is neither,
and pushing one into that table would put non-clinical test data into a PHI-encrypted clinical
structure and misuse its `EvalRun` relations. A small dedicated model is the correct call (Task 3).

## 3. Knowledge & Best Practices

### 3.1 Repo law that binds this ticket

| Rule + section | What it forces |
|---|---|
| `13-nextjs-apps.md` §Routing | Tier 50–59 has **no route group of its own**: playground screens nest under `(console)/(tenant)/playground/*` and are gated at the nav level by a role check. Segment `loading.tsx` + `error.tsx` |
| `13-nextjs-apps.md` §Structure | `src/app` is routing only; logic in `src/features/workbench/`; **features never import each other** |
| `13-nextjs-apps.md` §Auth (BFF) | Data calls through `/api/hope/[...path]`; **SSE/WS connect DIRECTLY to the gateway with single-use tickets from `POST /api/v1/auth/stream-ticket` — never put JWTs in URLs** |
| `13-nextjs-apps.md` §Data & State | TanStack Query v5; never fetch in `useEffect`; nuqs for shareable state |
| `12-design-workflow.md` §2 gate 2 | **No screen until its Figma frame is approved.** Frames 50–59 = Playground group |
| `11-ux-ui-principles.md` §1, §5, §7 | `ScreenTemplate` region contract; feedback within 100ms; `toast.success`/`toast.error`; badge meaning never carried by colour alone |
| `10-skeleton-loading.md` | `<Skeleton />` matching the loaded shape; in-button work uses `<Spinner />` |
| `02-database-prisma.md` | Standard model template (UUIDv7, `_version`, tenantId NOT NULL no-FK, `ResourceStatusType` soft delete, explicit index names, `@@schema("core")`); migration authored **against a throwaway shadow DB**, folder `<timestamp>_task_721_<desc>`; `@@unique` uses `map:` for the DB index name |
| `03-domain-layer.md` §Generated Code Discipline | `gen:model` is the ONLY scaffolder; entity/factory/mapper/repository are **hand-authored**; `gen:entity`/`gen:factory` only reconcile barrels; **`gen:mapper` is destructive — never run it**; `gen:repository` is broken. Register the repository in `CoreDatabaseModule` |
| `03-domain-layer.md` step 4 | A model that emits sys-events must be added to `ResourceType` in **BOTH** `audit.prisma` (+ `ALTER TYPE … ADD VALUE` migration) **and** `packages/domains/src/enums/generated/ResourceType.ts` — skipping it makes every AuditLog INSERT throw |
| `04-application-services.md` | `BaseService`; symbol-token DI in `IXxxService.ts`; repositories only (no `databaseService.client`); DTO mapper; `broadcastSysEvent` on every mutation; **cross-tenant ⇒ `NotFoundException`, never `ForbiddenException`** |
| `05-nestjs-api.md` | Every route carries `@Public()` or a permission decorator (boot audit enforces); versioned PATCH carries `@RequiresIfMatch()` + `@ExpectedVersion()`; no Prisma in controllers |
| `06-python-services.md` | Harness workflow changes must keep **replay compatibility** — run the replay-compat tests |

### 3.2 SOTA / base practices

| Practice | Justification |
|---|---|
| Sandbox containment enforced **server-side**, surfaced client-side | D3's principle generalised: "no reliance on UI lockouts". A watermark is a courtesy; the interpreter's mode flag is the boundary |
| One run-status filter point (the run read model), not a new `AgentSessionKind` member | Adding an enum member costs an `ALTER TYPE … ADD VALUE` migration on a hot enum (rule 02) and would need every existing reader updated. Joining through the run row is cheaper and reversible |
| Fixtures get their own small tenant-scoped model rather than reusing `GoldenSet`/`GoldenCase` | §2.7: golden cases are PHI-encrypted consultation transcripts; synthetic workflow inputs are neither |
| Reuse `useEventStream` verbatim for live progress | It already solves ticket minting, single-use replay, backoff and teardown, and it is the only path that keeps JWTs out of URLs |
| Link to `/playground/llm` and `/playground/live-transcription` rather than embedding them | Rule 13 forbids cross-feature imports; duplicating them would create a second authoritative surface for the same backend |

### 3.3 Known pitfalls for THIS ticket

1. **`payloadRef` is a reference, not content.** The per-node input/output inspector must resolve
   through the claim-check indirection the interpreter provides and must never assume plaintext is in
   the trajectory row. If the referenced payload cannot be resolved, render "payload not available"
   — never an empty box that reads as "no output".
2. **`runId` is an empty-string sentinel, not null**, for non-Temporal sessions
   (`agent-trajectory.prisma:78-85`). Any client key built from `(sessionId, runId)` must handle `""`
   — `features/ai-operations-runs/components/session-list.tsx` exports a `sessionKey` helper for
   exactly this.
3. **Never auto-reconnect a replaying stream.** `use-task-stream.ts` documents why: the SMR endpoint
   replays from 0-0 on every connect, so auto-reconnect silently re-appends the whole log. Confirm
   the interpreter's progress stream's replay semantics before choosing `maxRetries`.
4. **Never run `pnpm gen:mapper`** (rule 03) — it strips the `_version` OCC guard from mappers before
   crashing.
5. **A sandbox run must not be reachable from a signing path.** design.md: "cannot reach a signed
   state (structurally true — the substrate has no signing node)". Assert it with a test; do not add
   a guard that implies the risk exists in the substrate.
6. **Do not add the Workbench to the `(global)` group.** Sandbox runs execute against tenant
   definitions and tenant config; it is a tenant-scoped surface.

## 4. Implementation Plan

### Phase A — Placement, gate, and the sandbox contract

#### Task 1 — Clear the design gate (Figma frames, Playground group)
- **Agent:** T3 · sonnet-5 · medium — **HUMAN-GATED (product-owner approval)**
- **Files:** this README §7 (frame inventory + approval date)
- **Approach:** Rule 12 §2 gate 2. Frames in the **50–59 Playground** group, grammar
  `<NN>[.<sub>][-<device>] - <Name>`:
  `NN - Workbench` (run + live progress), `NN.1 - Workbench — Node Inspector`,
  `NN.2 - Workbench — Isolated Node Test`, `NN.3 - Workbench — Fixtures`.
  Light + dark, default/loading/empty/error, desktop mandatory. Each instances
  `09 - Screen Templates`. The **sandbox watermark treatment** must be designed here, not invented at
  build time. `NN` is assigned by the designer (the numbering inventory rule 13 points at is no
  longer under `docs/implementation/` — see TASK-719 §2.8).
- **Verify:** Frame inventory + approval date recorded in §7; frames Ready for Dev.

#### Task 2 — Verify and record TASK-718's sandbox-mode contract
- **Agent:** T4 · opus-5 · high
- **Files:** `docs/implementation/TASK-721-Workbench/contracts/sandbox-mode.contract.md` (new)
- **Approach:** §2.6 proves no sandbox mode exists today, so this ticket has **no** basis to guess
  its shape. Read what TASK-718 delivered and record, with `file:line`:
  1. How a run is started in sandbox mode (the gateway route, the request field, the enum/flag).
  2. Exactly **which writes are suppressed** — the design contract is "never writes external
     artifacts". Enumerate what that covers (notes, storage objects, webhooks, downstream service
     calls with side effects) and what it deliberately does not.
  3. How a sandbox run is **identifiable after the fact** — the field on the run row and/or the
     trajectory correlation. This is the filter key for the exclusion guardrail (Task 9).
  4. The **live progress stream**: path, `@StreamScope` value, event names, payload shape, and its
     **replay semantics on reconnect** (see pitfall 3).
  5. Whether the interpreter supports **single-node execution** and, if so, how a node type declares
     itself independently runnable (this decides Task 8's feasibility).
  6. The synthetic-input payload shape the interpreter accepts (this decides Task 3's fixture value
     column).
  If any of these is missing, record it in §6 as a blocking open question rather than designing
  around it.
- **Verify:** The contract file exists and every claim carries a `file:line` into TASK-718's code.

#### Task 3 — RULING: place the Workbench in the playground tier, with a real ability gate
- **Agent:** T3 · sonnet-5 · medium
- **Files:** `apps/admin-console/src/shared/navigation/nav-config.ts`;
  `apps/admin-console/src/shared/navigation/__tests__/` (extend the existing nav tests)
- **Approach:** Implement the ruling argued in §2.1 and restated in §6/R1:
  - **Route:** `apps/admin-console/src/app/(console)/(tenant)/playground/workbench/page.tsx` — same
    route group and same tier-guard inheritance as the five existing playground screens.
  - **Nav entry:** `tier: '50-59'`, so `visibleNavEntries` applies the `isAdminTier` role check
    (`nav-config.ts:459`) exactly as it does for its siblings.
  - **Deliberate divergence:** `required` is **NOT** `[]`. It carries the ability pair(s) that the
    gateway actually enforces on the sandbox-run route (from Task 2's contract) — e.g.
    `[['read','WorkflowDefinition'], ['manage','WorkflowDefinition']]`. Add a comment above the entry
    explaining the divergence: the existing `required: []` convention holds because those screens are
    own-account end-user planes whose backend guards are plain `@Authorize()` (nav-config.ts:421-426);
    the Workbench reads and executes tenant `WorkflowDefinition` rows, so its backend guard **is** a
    resource ability, and declaring `[]` would hide a real gate from the nav and diverge from the
    gateway.
  - **Deep link from the Studio:** TASK-719's editor gets a "Test in Workbench" action linking to
    `/playground/workbench?definitionId=…&version=…` as a plain `href` (no cross-feature import).
    One runner, reachable from two places — the one-authoritative-editor rule applied to a runner.
- **Verify:** `pnpm admin:test` — extend the nav-config tests to assert (a) the entry is hidden for a
  non-admin role, and (b) it is hidden for an admin role lacking the declared ability. `pnpm
  admin:lint`, `pnpm admin:typecheck`.

### Phase B — Fixtures (per-tenant synthetic inputs)

#### Task 4 — Add the `WorkflowTestFixture` Prisma model + migration
- **Agent:** T3 · sonnet-5 · high
- **Files:** `packages/database/src/prisma/db_main/workflow-test-fixture.prisma` (new);
  `packages/database/src/prisma/db_main/migrations/<timestamp>_task_721_workflow_test_fixture/migration.sql`;
  `packages/database/src/extensions/tenant-scope.ts` (`TENANT_SCOPED_MODELS`);
  `packages/database/src/prisma/db_main/audit.prisma` + `packages/domains/src/enums/generated/ResourceType.ts`
- **Approach:** Standard model template from rule 02 (field section order exactly as documented):
  meta (`metaData`, `version`, `id` `@default(uuid(7))`) → `tenantId` → business fields → resource
  status → audit → indexes → `@@schema("core")`. Business fields:
  `name String`, `description String? @db.Text`, `paletteId String?`,
  `workflowDefinitionId String?` (null ⇒ tenant-wide fixture; no FK, mirroring the `tenantId`
  posture used by `GoldenSet.departmentId` in `harness.prisma:60-62`),
  `input Json @db.JsonB` (shape from Task 2's contract).
  Indexes: `@@index([tenantId], name: "WorkflowTestFixture_tenantId_idx")`,
  `@@index([tenantId, workflowDefinitionId], name: "WorkflowTestFixture_tenant_definition_idx")`.
  It **does** emit sys-events (it is CRUD, not telemetry), so per rule 03 step 4 add
  `WorkflowTestFixture` to `ResourceType` in **both** `audit.prisma` (with an `ALTER TYPE … ADD
  VALUE` statement in the migration) **and** the domain enum — the parity test
  `resourceType.enum-parity.test.ts` is the guard. It keeps soft delete, so it is **not** added to
  `MODELS_WITHOUT_SOFT_DELETE`. It **is** tenant-scoped, so add it to `TENANT_SCOPED_MODELS`.
  Author the migration with the shadow-DB recipe in rule 02 §Migration Workflow — note the two
  documented traps: `-n` must go to the package-level script
  (`pnpm --filter @arcaai/database db:migrate:create -n task_721_workflow_test_fixture`), and
  `prisma migrate dev` prompts on drift.
  **PHI note to carry in the file header:** fixtures are *synthetic* inputs by contract. Add a short
  comment stating that clinical content must not be pasted here and that the field is not encrypted —
  and see §6/R4.
- **Verify:** From the shadow DB, `npx prisma migrate diff --from-config-datasource --to-schema
  src/prisma/db_main --script` prints `-- This is an empty migration.`; then `pnpm db:push`;
  `pnpm --filter @arcaai/database test`.

#### Task 5 — Hand-author the domain layer for the fixture
- **Agent:** T3 · sonnet-5 · high
- **Files:** `packages/domains/src/models/generated/core/WorkflowTestFixtureModel.ts` (via
  `pnpm gen:model`); then **hand-authored** `entities/generated/core/WorkflowTestFixtureEntity.ts`,
  `factories/generated/core/WorkflowTestFixtureFactory.ts`,
  `mappers/generated/core/WorkflowTestFixtureEntityMapper.ts`,
  `repositories/generated/core/WorkflowTestFixtureRepository.ts`; barrels;
  `packages/domains/src/common/databaseServices/core/core.database.module.ts`
- **Approach:** Rule 03 §Generated Code Discipline, verbatim: run `pnpm gen:model` (the only
  scaffolder), then hand-author the other four following the `AiTaskDefault*` /
  `AiProviderConnection*` exemplars. The mapper **must** carry
  `FIELDS_NOT_WRITABLE = ['version']` + `stripNonWritableFields` (the model is OCC-written).
  **Never run `pnpm gen:mapper`** — it strips exactly that guard from every mapper it touches before
  crashing; recovery is `git checkout -- packages/domains/src/mappers/generated/core/`.
  Add the mapper and repository **barrel lines by hand**; `gen:entity`/`gen:factory` reconcile only
  the entity/factory barrels. Register the repository in `CoreDatabaseModule` (providers AND exports).
- **Verify:** `pnpm gen:model`, `pnpm gen:entity`, `pnpm gen:factory` report no drift and schema
  coverage OK; `pnpm --filter @arcaai/domains build` and `pnpm --filter @arcaai/domains test` green.

#### Task 6 — Application service + gateway routes for fixtures
- **Agent:** T2 · sonnet-5 · medium
- **Files:** `packages/applications/src/services/workflow-test-fixture/` —
  `IWorkflowTestFixtureService.ts`, `workflow-test-fixture.service.ts`,
  `workflow-test-fixture.service.module.ts`, `workflow-test-fixture.dto.mapper.ts`, `dto/`,
  `__tests__/`, `index.ts`;
  `apps/api/src/modules/workflow-test-fixture/` — controller + module + `__tests__/`
- **Approach:** Copy `packages/applications/src/services/department/` structure exactly (rule 04's
  exemplar). Symbol-token DI; extends `BaseService`; repository access only (no
  `databaseService.client`); `broadcastSysEvent` on every mutation; cross-tenant access throws
  `NotFoundException` (404-over-403). Request DTOs carry `class-validator` + `@ApiProperty` on every
  field (the global pipe runs `whitelist + forbidNonWhitelisted + forbidUnknownValues`).
  Controller at `@Controller('admin/workflow-test-fixtures')`; class-level permission decorator; the
  update route carries `@RequiresIfMatch()` + `@ExpectedVersion()` and the service calls
  `repository.updateWithVersion(...)` (rule 05 §Optimistic Concurrency).
- **Verify:** `pnpm --filter @arcaai/applications build test`; `pnpm api:build`; `pnpm test:unit`.
  Add a cross-tenant e2e per rule 05 ("new admin/by-id surfaces need equivalent coverage").

### Phase C — The Workbench screen

#### Task 7 — RED then GREEN: feature module, API layer, run panel with live progress
- **Agent:** T3 · sonnet-5 · high
- **Files:** `apps/admin-console/src/features/workbench/` — `api/{client,hooks,keys,types,index}.ts`,
  `components/workbench-screen.tsx`, `components/run-panel.tsx`,
  `components/fixture-picker.tsx`, `components/__tests__/*.test.tsx`,
  `api/__tests__/workbench-api.test.ts`;
  `apps/admin-console/src/app/(console)/(tenant)/playground/workbench/{page,loading,error}.tsx`
- **Approach:** Tests first. Screen composition:
  - `ScreenTemplate` with `header` = `PageHeader` (the one `h1`), `statusBanner` = the sandbox
    watermark (Task 9) **plus** `PlaygroundBanner` where the design gate keeps it,
    `toolbar` = definition + version + fixture selectors and the `RunBar` from
    `features/playground-shared/components/run-bar.tsx`, `contentMode="scroll"`.
  - Definition/version selection is driven by the URL (`?definitionId=`, `?version=`) via **nuqs**, so
    the Studio's "Test in Workbench" deep link (Task 3) works and the state is shareable.
  - Starting a run is a TanStack **mutation** through the BFF (`postJson`); live progress is
    `useEventStream` with the path and `scope` from Task 2's contract, `maxRetries` chosen from its
    documented replay semantics (pitfall 3).
  - Feedback within 100ms and a terminal `toast.success` / `toast.error` (rule 11 §5). Loading uses
    `<Skeleton />` shaped like the loaded panel (rule 10); the in-button run state uses `<Spinner />`.
  - `loading.tsx` / `error.tsx` at the segment (rule 13 §Routing).
- **Verify:** `pnpm admin:test` (RED first, then GREEN — paste both); `pnpm admin:build`.

#### Task 8 — Per-node inspection + isolated node test
- **Agent:** T3 · sonnet-5 · high
- **Files:** `.../features/workbench/components/node-run-inspector.tsx`,
  `.../components/isolated-node-test.tsx`, `.../components/__tests__/*.test.tsx`
- **Approach:**
  - **Per-node inspection:** for the selected node of the current run, show input, output, timing
    (`startedAt`/`endedAt`/`durationMs`), status (`STARTED|OK|ERROR|SKIPPED|TIMEOUT`) and, for
    `LLM_CALL` steps, the `stats` rollup. Payloads resolve through the claim-check indirection —
    honour pitfall 1: an unresolvable `payloadRef` renders an explicit "payload not available", never
    an empty box. JSON payloads render in `CodeEditor` (`@arcaai/ui`), never a bare `<Textarea>`
    (rule 11 anti-patterns). Present it in `DetailDrawer` (`@/shared/detail/detail-drawer.tsx`),
    the console-wide detail surface — do not hand-roll a Sheet.
  - **Isolated node test:** only rendered when Task 2 §5 confirms the interpreter supports it **and**
    the node-type descriptor declares the node independently runnable. Build it on
    `features/agents/components/test-run-panel.tsx`'s configure→run→inspect shape (as a *pattern*,
    copied — not imported across features). If the interpreter does not support single-node
    execution, this sub-task becomes a documented gap in §6, not a client-side simulation.
- **Verify:** `pnpm admin:test` including a `vitest-axe` 0-violation assertion; `pnpm admin:typecheck`.

#### Task 9 — Sandbox containment: watermark + exclusion from real-data surfaces
- **Agent:** T4 · opus-5 · high
- **Files:** `apps/admin-console/src/shared/page/sandbox-banner.tsx` (new, sibling of
  `playground-banner.tsx`); `.../features/workbench/components/sandbox-badge.tsx`;
  every real-data surface that lists runs (coordinate with TASK-723);
  `apps/admin-console/tests/e2e/workbench.spec.ts` (the containment assertions)
- **Approach:** Two layers, and be explicit about which is the boundary:
  - **Server-side is the boundary.** Every run started from the Workbench is marked sandbox by
    TASK-718 (field per Task 2 §3). Real-data run surfaces filter it out **by default at the query
    level**, with an explicit opt-in toggle to include sandbox runs. Coordinate with TASK-723, which
    owns the run read model: the sandbox flag lives there (`isSandbox`), so the filter is one
    predicate in one place rather than a rule each surface re-implements. If TASK-723 has not landed,
    record the requirement in its ticket rather than adding a second marker here.
  - **Client-side is the disclosure.** A persistent `role="note"` banner in the `statusBanner` slot
    (built like `playground-banner.tsx:15`), a `Badge` on the run header and on every artifact pane,
    and result panes labelled "Sandbox — not clinical output". Rule 11 §7: the badge carries the word,
    never colour alone.
  - **Assert the structural property, do not add a guard implying otherwise.** A test asserts that no
    node type served by the registry can produce a signed artifact — design.md: signing "remains
    `approveSummary`, outside the substrate, preserving the keystone property by construction". If
    that assertion cannot be written because a signing-capable node exists, that is a TASK-716/718
    defect and a blocker, not a Workbench workaround.
- **Verify:** `pnpm admin:test`; `pnpm admin:test:e2e` — a spec that starts a sandbox run and asserts
  it does **not** appear in the default runs list and **does** appear with the include-sandbox toggle.

#### Task 10 — Cross-links to the existing STT / text-gen playgrounds
- **Agent:** T1 · haiku-4-5 · default
- **Files:** `.../features/workbench/components/related-playgrounds.tsx`
- **Approach:** A small card listing plain `href` links to `/playground/llm` (text generation ·
  guardrails · NER) and `/playground/live-transcription` (STT), with one line each saying what they
  cover. **No cross-feature imports, no re-implementation** (§2.3). Where the Workbench's own node
  inspector already shows a text-generation result, link out for the *free-form* exploration case
  rather than adding a second prompt editor.
- **Verify:** `pnpm admin:lint` (no cross-feature import); `pnpm admin:test`.

#### Task 11 — Playwright e2e + a11y pass
- **Agent:** T2 · sonnet-5 · medium
- **Files:** `apps/admin-console/tests/e2e/workbench.spec.ts`
- **Approach:** Follow `tests/e2e/playground.spec.ts` — `test.skip` stack guards from
  `./helpers/stack`, `loginAsAdmin`/`selectWorkingTenant` from `./helpers/auth`,
  `expectNoA11yViolations` from `./helpers/a11y`. Specs: nav entry visible for an admin with the
  ability and hidden without it; deep link from the Studio lands with the definition preselected;
  a run streams progress and reaches a terminal state; the sandbox watermark is present throughout;
  containment assertions from Task 9; axe clean in light and dark.
- **Verify:** `pnpm admin:test:e2e`. Paste output.

## 5. Acceptance Criteria

- [ ] **Design gate cleared before any screen code:** frame inventory + approval date in §7 (rule 12)
- [ ] `contracts/sandbox-mode.contract.md` exists and every claim carries a `file:line` into
      TASK-718's delivered code — **no sandbox behaviour is assumed**
- [ ] The Workbench lives at `(console)/(tenant)/playground/workbench` with `tier: '50-59'` and a
      **non-empty** `required` list matching the gateway guard, with the divergence commented
- [ ] `pnpm gen:model` · `pnpm gen:entity` · `pnpm gen:factory` report **no drift and schema coverage
      OK**; `pnpm gen:mapper` was **not** run (`git status` clean under
      `packages/domains/src/mappers/`)
- [ ] `prisma migrate diff --from-config-datasource --to-schema src/prisma/db_main --script` prints
      `-- This is an empty migration.` after the migration is applied to the shadow DB
- [ ] `WorkflowTestFixture` is in `TENANT_SCOPED_MODELS` and in `ResourceType` in **both**
      `audit.prisma` and `packages/domains/src/enums/generated/ResourceType.ts`
      (`resourceType.enum-parity.test.ts` green)
- [ ] `pnpm --filter @arcaai/domains build test` green (output pasted)
- [ ] `pnpm --filter @arcaai/applications build test` green (output pasted)
- [ ] `pnpm api:build` and `pnpm test:unit` green; a cross-tenant e2e proves a foreign fixture id
      returns **404, not 403**
- [ ] `pnpm --filter @arcaai/admin-console build lint test` green (output pasted)
- [ ] `pnpm admin:typecheck` green (output pasted)
- [ ] `pnpm admin:test:e2e` green for `tests/e2e/workbench.spec.ts` (output pasted)
- [ ] **axe: 0 violations** on the Workbench screen in light and dark, via `expectNoA11yViolations`
- [ ] **Manual pass recorded**: keyboard-only run-and-inspect, 200% zoom with no horizontal page
      scroll (rule 11 §11)
- [ ] Sandbox runs are **excluded by default** from real-data run surfaces at the query level, with
      an explicit include toggle; a test proves both directions
- [ ] A test asserts **no registry node type can produce a signed artifact**
- [ ] STT and text-generation quick tests are **linked, not duplicated** — `grep -rn "features/"
      apps/admin-console/src/features/workbench` shows no import from another feature module
- [ ] Live progress uses `useEventStream` (ticket-authenticated, direct-to-gateway); **no JWT appears
      in any URL**
- [ ] **Evidence rule:** actual command output pasted in §7 before this ticket is marked complete

## 6. Risks & Open Questions

| # | Risk / question | Handling |
|---|---|---|
| R1 | **The placement ruling itself.** design.md says the Workbench "extends the playground tier", but every existing tier-50-59 entry declares `required: []` because those screens are own-account planes with plain `@Authorize()` guards (`nav-config.ts:421-426`) | **Ruling: playground tier placement, ability-gated nav entry.** Placement follows design.md and inherits the `(tenant)` route guard plus the `isAdminTier` role check. The `required: []` convention is deliberately broken because the Workbench reads and executes tenant `WorkflowDefinition` rows — a resource ability, not an own-account action. Declaring `[]` would hide a real gate from the nav and diverge from the gateway. Rejected alternative: nesting it inside the Studio as a tab — it would fight the Studio's editor layout for the same viewport, and a run surface is not an editing surface |
| R2 | **BLOCKING if unmet — TASK-718 may not expose single-node execution.** Requirement 4 of §1 depends entirely on it | Task 2 §5 checks explicitly. If absent, the isolated-node panel is dropped and recorded as a gap; the Workbench does **not** simulate node execution client-side, which would produce results the interpreter would not |
| R3 | **BLOCKING if unmet — the run read model's `isSandbox` field is owned by TASK-723.** Task 9's exclusion guardrail needs one filter point | Task 9 coordinates rather than duplicating. If TASK-723 has not landed, raise the field as a requirement in its ticket; do not add a second sandbox marker, which would drift |
| R4 | **HUMAN-GATED — fixture PHI posture.** `WorkflowTestFixture.input` is a plain `JsonB` column. "Synthetic" is a contract, not an enforcement; an admin can paste a real transcript into it | The field header comments the contract, and the console labels the field "synthetic input — do not paste patient data". Whether this needs the Vault-Transit treatment `GoldenCase` uses (`harness.prisma:98-102`), or a `phi-redactor` (TASK-710) pass on write, is a **security decision** and is not taken here |
| R5 | Size: this ticket carries a full Prisma→domain→service→controller chain (Tasks 4–6) plus three console surfaces | M is the *intended* size. If Task 2 reveals that TASK-718 already carries a synthetic-input store, Tasks 4–6 collapse and M holds comfortably. If not, **this ticket is realistically L** — promote it rather than compressing the domain-layer work, which rule 03 makes hand-authored and unskippable |
| R6 | The interpreter's progress stream may replay on reconnect, like the SMR task stream does | Task 2 §4 requires the replay semantics to be recorded before `maxRetries` is chosen. `use-task-stream.ts` is the cautionary precedent |
| R7 | `payloadRef` may point at content the console is not permitted to resolve (PHI posture, `agent-trajectory.prisma:8-11`) | Pitfall 1: render an explicit "payload not available". Do not add a console-side decryption path |
| R8 | The Workbench and TASK-723's per-run trace both inspect a run and could diverge into two viewers | Deliberate split: the Workbench inspects the **live, in-flight sandbox** run; TASK-723 owns the **historical** run trace and the canvas overlay. Where the two want the same per-node panel, promote it into `packages/ui` or `@/shared` rather than copying — flag at build time |

## 7. Implementation Summary

*(Empty at authoring — filled during execution. Must include: the design-gate frame inventory and
approval date, the TASK-718 sandbox contract summary, the final placement ruling as built, and pasted
output for every command in §5.)*

## 8. Change History

| Date | Change | By |
|---|---|---|
| 2026-08-16 | Ticket authored | ticket-writer agent (Wave 2 Studio batch) |
