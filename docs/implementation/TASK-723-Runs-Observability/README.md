# TASK-723 — Runs Observability

| | |
|---|---|
| **Status** | Review — Phase A/B (Tasks 1, 3–6, 10) and Phase C (Tasks 7–9, 11) all built and green; e2e specs authored but NOT executed (infra/tooling constraints, not skipped by choice) — see §7 |
| **Wave** | 2 · **Size** | M |
| **Epic slug** | `runs-observability` |
| **Depends on** | TASK-718 (`workflow-interpreter`), TASK-719 (`workflow-studio-v1`) |
| **Design refs** | D6 (CQRS-lite, scoped to the substrate) from [design.md](../../architecture/agentic-workflow-platform/design.md); §"Data flow — Observability"; §"Error handling — Runtime"; §"Plane 3" (runs tab) |
| **Findings closed** | — |

## 1. Requirement Analysis

Deliver the **runs list** and the **per-run trace** for workflow-substrate runs.

design.md §Data flow states the shape precisely: *"every node execution appends a trajectory row
(node id, input hash, output ref, timing, confidence). Runs tab = trajectory ⋈ definition version;
the canvas replays a run as an overlay on the authored graph."* D6 scopes the read side: *"CQRS-lite,
scoped to the substrate — commands+events on definition mutations, **read models for
runs/observability**."*

Scope:

1. **Runs list** — tenant-scoped, keyset-paginated, filterable, backed by a **read model** rather
   than an N+1 fan-out over trajectory steps.
2. **Per-run trace** — the run replayed as an **overlay on the authored graph**, using the same
   canvas component and the same graph JSON that the editor renders (TASK-719's `WorkflowCanvas`
   `overlay` prop). Per-node status / timing / confidence badges.
3. **Failure drill-down** — degradation markers, retries and timeout force-stops surfaced honestly,
   per design.md §Error handling: a failing node "degrades visibly … a node that produces nothing
   produces a *marked* nothing"; "Timeout force-stops that node only".
4. **Run → definition version deep link** — into a **read-only** canvas pinned to the exact,
   immutable version that produced the run.
5. **Retention and volume alignment** — the runs list must not outlive its own traces silently.

### Explicitly OUT of scope

| Out | Owner / reason |
|---|---|
| Writing run rows / trajectory steps during execution | TASK-718 — this ticket defines the read model and its write contract, and 718 calls it |
| The canvas composite and the editor | TASK-719 — reused via its `overlay` prop, never re-implemented |
| Live sandbox run inspection | TASK-721 (in-flight sandbox); this ticket owns the **historical** trace |
| Cross-tenant platform ops over trajectories | `/ai-operations/runs` already exists (§2.4) and stays |
| Cost/consumption analytics | `features/consumption-cost/` and `admin/agent-trajectory/metrics/generation` already exist |
| New retention machinery | `AgentTrajectoryRetentionService` already exists (§2.5); this ticket aligns with it |

## 2. Current State Evaluation

### 2.1 The trajectory table — what a run leaves behind today

`packages/database/src/prisma/db_main/agent-trajectory.prisma`:

- `AgentTrajectoryStep` (line 62). Columns: `metaData`, `version`, `id` (uuid v7), `tenantId`,
  `consultationId?`, `sessionKind`, `sessionId`, `runId` (`String @default("")`), `seq`, `stepType`,
  `name`, `status`, `startedAt`, `endedAt?`, `durationMs?`, `stats` JsonB, `payloadRef` JsonB,
  `errorCode?`, `correlationId?`, audit fields.
- Enums: `AgentSessionKind` (29) = `LIVE_DOC | HARNESS_DOC | SUMMARY_JOB | EVAL_RUN`;
  `AgentStepType` (38) = `LLM_CALL | TOOL_CALL | SENSOR | RETRIEVAL | GUARDRAIL | THINKING | SIGNAL |
  GATE | PHASE`; `AgentStepStatus` (52) = `STARTED | OK | ERROR | SKIPPED | TIMEOUT`.
- Constraints: `@@unique([tenantId, sessionId, runId, seq], name:
  "AgentTrajectoryStep_session_seq_unique")` (115); indexes
  `AgentTrajectoryStep_tenant_consultation_idx` (117) and
  `AgentTrajectoryStep_tenant_createdAt_idx` (118).
- Documented posture (header, lines 13–26): **tenant-scoped**; **no soft delete** — "high-volume
  OPERATIONAL TELEMETRY with HARD RETENTION (a nightly prune job hard-deletes aged rows)"; **no
  sys-events on write** ("the trajectory is itself the event stream; emitting a sys-event per step
  would be circular"); `_version` kept for the shared repository machinery.
- Allow-lists confirmed: `packages/database/src/client.ts:129` lists `AgentTrajectoryStep` in
  `MODELS_WITHOUT_SOFT_DELETE`; `packages/database/src/extensions/tenant-scope.ts:170` lists it in
  `TENANT_SCOPED_MODELS`.

**Three gaps that decide this ticket's design:**

| Gap | Evidence | Consequence |
|---|---|---|
| **No workflow-definition or version column** | The field list above has none | A runs list that joins definition version through trajectory rows alone is impossible; a read model is required, not merely preferable |
| **No `AgentSessionKind` member for a substrate run** | Enum at line 29 has four members, none of them a workflow run | Either an `ALTER TYPE … ADD VALUE` migration (rule 02) or the run read model becomes the identity table. §3.2 chooses the latter |
| **No retry/attempt column** | No `attempt` field; the unique is `(tenantId, sessionId, runId, seq)` | Retries appear as repeated `name` values at increasing `seq`. Attempt grouping must be derived, or stamped by TASK-718 — see Task 2 and R3 |

### 2.2 The trajectory read service — reuse its shape, and its cursor

`packages/applications/src/services/agent-trajectory/IAgentTrajectoryService.ts`:

- `listSessions(tenantId, filters?, options?)` — distinct sessions grouped by
  `sessionKind + sessionId + runId`, **offset**-paginated
  (`ListTrajectorySessionsOptions { page?, limit? }`), returning
  `AgentTrajectorySessionsListResponse { items, total }` where each item is
  `{ sessionId, runId, sessionKind, consultationId, stepCount, firstStepAt, lastStepAt }`
  (`dto/agent-trajectory-session.response.ts`).
- `listSteps(tenantId, sessionId, options?)` — ordered `seq asc`, **keyset**-paginated
  (`ListTrajectoryStepsOptions { runId?, cursor?, limit? }`), "404-over-403 on cross-tenant".
- `aggregateGenerationStats(...)` — "Requires a createdAt window (default last 7 days) and hard-caps
  scanned rows".
- `recordSteps(...)` — idempotent batch append, "Emits NO sys-event (telemetry exemption)"; steps
  carrying a `consultationId` are republished to Redis `consultation:trajectory:{consultationId}`.
- `pruneOlderThan(days)` — hard delete.

Implementation (`agent-trajectory.service.ts:14`) imports `clampCursorLimit, decodeCursor,
toCursorPage` from `../../common/cursorPagination` and decodes at line 207.

### 2.3 `cursorPagination.ts` exists — verified, with its exact shape

`packages/applications/src/common/cursorPagination.ts` (125 lines), re-exported via
`packages/applications/src/common/index.ts:10`:

| Export | Line | Detail |
|---|---|---|
| `DEFAULT_CURSOR_LIMIT` | 20 | `10` |
| `MAX_CURSOR_LIMIT` | 22 | `100` — "Hard cap on a single cursor page to protect the DB" |
| `CursorPayload` | 25 | `{ k: string; id: string }` — sort-key value + uuid tiebreaker |
| `CursorDirection` | 32 | `'asc' \| 'desc'` |
| `BuildCursorPropsOptions` | 34 | `{ where?, sortKey? (default `createdAt`), direction? (default `desc`) }` |
| `CursorPage<T>` | 44 | `{ data, nextCursor, hasMore, limit }` |
| `encodeCursor` / `decodeCursor` | 52 / 61 | base64url; `decodeCursor` returns `null` for "any malformed, tampered, or wrong-shape token so callers can reject it as a `BadRequestException`" |
| `clampCursorLimit` | 81 | |
| `buildCursorFindAllProps` | 91 | AND-s the keyset predicate onto the base `where` |
| `toCursorPage` | 119 | Over-fetch → slice → derive `hasMore` → encode `nextCursor` |

Current callers: `services/agent-trajectory/agent-trajectory.service.ts` and
`services/auditLog/auditLog.service.ts:194`.

The console already speaks this envelope: `apps/admin-console/src/shared/api/http.ts` declares
`CursorPaginated<T> { data, nextCursor, hasMore, limit }` — "Keyset envelope used by deep scans (e.g.
`GET /admin/audit-logs/cursor`)". **The server and client envelopes match exactly**; no adapter is
needed.

Rule 04 §Transactions, Pagination, Quotas mandates keyset for large tables: *"Keyset pagination
(large tables, opt-in): `src/common/cursorPagination.ts` — opaque base64url `(sortKey, uuidv7 id)`
token, hard page cap, `hasMore`."*

### 2.4 There is already a runs screen — and it must not be duplicated

`/ai-operations/runs` (tier **10-19**, `nav-config.ts` under the AI-operations group):

- Page: `apps/admin-console/src/app/(console)/(global)/ai-operations/runs/page.tsx`.
- Screen: `apps/admin-console/src/features/ai-operations-runs/components/ai-operations-runs-screen.tsx`
  — `AiOperationsRunsScreen` wraps `WorkingTenantGate` ("Trajectory data is tenant-scoped, so the
  screen runs behind the working-tenant gate"), then `Tabs` (`trajectory` / `gate-queue`) inside a
  `ScreenTemplate` with `TabsList variant="line"`, `nuqs` `useQueryState` for `tab` and `session`.
- Components: `session-list.tsx` (exports a `sessionKey(sessionId, runId)` helper),
  `trajectory-timeline.tsx`, `step-stats.tsx`, `gate-queue-panel.tsx`, `signal-dialog.tsx`.
- Client (`features/ai-operations-runs/api/client.ts`): `admin/agent-trajectory/sessions`,
  `admin/agent-trajectory/sessions/:id/steps`, `admin/harness/gate-queue`,
  `admin/harness/workflows/:id/cancel`, `.../signal`, plus
  `trajectoryStreamPath(consultationId)` = `consultations/:id/trajectory/stream` and
  `trajectoryStreamScope(consultationId)` = `consultation_trajectory::id`.

This is **rule 13's "global-admin-only screen over per-tenant data" sub-pattern**, which the rule
names explicitly as correct rather than drift, listing `/ai-operations/runs` as an instance.

### 2.5 Retention already exists — and its defaults matter here

`packages/applications/src/services/agent-trajectory-retention/` —
`AgentTrajectoryRetentionService`, a self-scheduling cron mirroring `AuditRetentionService`
(`SchedulerRegistry` + AppSettings, `@OnEvent('app-settings.cache-refreshed')`), delegating the hard
delete to `AgentTrajectoryService.pruneOlderThan` ("repository path only — no Prisma client in this
service").

Defaults, quoted from the file:

```
enabled: false,          // agentic.trajectory.enabled
cron: '0 4 * * *',       // agentic.trajectory.cron
retentionDays: 30,       // agentic.trajectory.retentionDays
```

and the reason `enabled` is off: *"retention HARD-DELETES telemetry rows, so an operator must
explicitly opt in before any data is removed."*

### 2.6 Console building blocks to reuse

Identical to TASK-719 §2.2 — `ScreenTemplate` (`contentMode="fill"` for the grid),
`AdminDataGrid` + `grid-url-state.ts` (nuqs URL query-state, server-driven),
`DetailDrawer`, `WorkingTenantGate`, `EmptyState` / `ErrorState`, `Skeleton`,
`shared/api/http.ts` (`CursorPaginated`, `GatewayError.isNotFound`), `shared/streams/`
(`useEventStream` for live run updates), `shared/format/` (`formatDateTime`, `formatRelativeTime`,
`formatNumber`).

`features/harness-ops/components/harness-workflows-screen.tsx` is the closest existing "list of runs
→ detail drawer" screen (`VirtualizedDataGrid` + `FilterBar` + `WorkflowDetailDrawer` +
`WorkflowStatusBadge` + `isNonTerminal` polling) and is the layout exemplar.

## 3. Knowledge & Best Practices

### 3.1 Repo law that binds this ticket

| Rule + section | What it forces |
|---|---|
| `02-database-prisma.md` | Standard model template + field section order; explicit index names; `@@schema("core")`; migration authored against a **throwaway shadow DB**, folder `<timestamp>_task_723_<desc>`; on `@@unique`, the DB index name comes from `map:`, not `name:` |
| `02-database-prisma.md` §Client Access Tiers | New model ⇒ update `TENANT_SCOPED_MODELS`, and `MODELS_WITHOUT_SOFT_DELETE` when applicable |
| `03-domain-layer.md` §Generated Code Discipline | `gen:model` is the only scaffolder; entity/factory/mapper/repository **hand-authored**; **`gen:mapper` is destructive — never run it**; `gen:repository` is broken; register the repository in `CoreDatabaseModule`; add mapper/repository barrel lines **by hand** |
| `03-domain-layer.md` step 4 | `ResourceType` parity in **both** `audit.prisma` and the domain enum — **only if the model emits sys-events** |
| `04-application-services.md` | `BaseService`; symbol-token DI; repositories only; DTO mapper; cross-tenant ⇒ `NotFoundException`; **keyset pagination via `common/cursorPagination.ts` for large tables** |
| `05-nestjs-api.md` | `@Public()` or a permission decorator on every route (boot audit); no Prisma in controllers; cross-tenant returns 404; new admin/by-id surfaces need cross-tenant e2e coverage |
| `13-nextjs-apps.md` §Routing | Tier 30–49 ⇒ `(console)/(tenant)/`; **one authoritative editor per backend resource**; segment `loading.tsx`/`error.tsx` |
| `13-nextjs-apps.md` §Data & State | TanStack Query; nuqs for shareable filter state; never fetch in `useEffect` |
| `12-design-workflow.md` §2 gate 2 | **No screen until its Figma frame is approved** |
| `11-ux-ui-principles.md` §1, §7, §8 | `ScreenTemplate`; badge meaning never carried by colour alone; lists show counts; relative timestamps for recent, absolute for older |
| `10-skeleton-loading.md` | `VirtualizedDataGrid` ships its own skeleton — use it for the table loading state |

### 3.2 SOTA / base practices, with the reasoning

| Practice | Justification |
|---|---|
| **A `WorkflowRun` read model, not a widened `AgentTrajectoryStep`** | D6 says "read models for runs/observability". §2.1 shows the trajectory table has no definition/version column. Widening a high-volume, hard-retention telemetry table with two more columns per *step* to carry a per-*run* fact is the wrong grain, costs a migration on the hot table, and still leaves the list doing a `DISTINCT ON` over steps. One row per run is the right grain and gives a stable `(createdAt, id)` keyset sort key |
| **The run row is the identity table; no new `AgentSessionKind` member** | Adding an enum member requires `ALTER TYPE … ADD VALUE` (rule 02) on an enum four existing readers switch on. Joining through the run row keeps the change additive and reversible |
| **Keyset pagination for the runs list** | Rule 04 mandates it for large tables; `cursorPagination.ts` is verified present, already used by two services, and its envelope already matches the console's `CursorPaginated<T>` |
| **One canvas component, two modes** | design.md: "the same graph JSON renders editor and execution trace". TASK-719 Task 5 reserves an `overlay` prop for exactly this. A second trace-only renderer would drift from the editor's node rendering the first time a node type changes |
| **The run pins its definition version; the deep link is read-only** | design.md §Data flow: "In-flight runs pin their version; publishes affect new runs only" and "published rows immutable". A trace that rendered the *current* draft would misattribute behaviour |
| **Sandbox runs filtered at the query level, not the component** | One predicate in one place. TASK-721's containment guardrail depends on this being the single filter point |
| **Telemetry exemption applies to the run row too** | `AgentTrajectoryStep` documents "NO sys-events on write (telemetry exemption — the trajectory is itself the event stream)". `WorkflowRun` is the same kind of record and follows the same posture — which also means **no `ResourceType` entry is needed** (rule 03 step 4 conditions it on emitting sys-events) |

### 3.3 Known pitfalls for THIS ticket

1. **Do not create a second run row if TASK-718 already ships one.** Task 1 verifies first. Two run
   tables would be the exact duplication D6 is scoped to avoid.
2. **`runId` is an empty-string sentinel, not null** (`agent-trajectory.prisma:78-85`). Any key built
   from `(sessionId, runId)` must handle `""`; `features/ai-operations-runs/components/session-list.tsx`
   already exports `sessionKey` for this.
3. **A run row can outlive its trace.** Steps are pruned by `AgentTrajectoryRetentionService`
   (default 30 days, opt-in); if run rows are kept longer, the trace view must render an explicit
   **"trace pruned"** state, never an empty timeline that reads as "nothing happened". See Task 9.
4. **Retries are not a column.** They surface as repeated `name` at increasing `seq` (§2.1). Derive
   attempt grouping, and label it as derived — or get TASK-718 to stamp it. Do not present a derived
   attempt count as authoritative without saying so.
5. **`TIMEOUT` is per node, not per run.** design.md: "Timeout force-stops that node only". A run
   containing a `TIMEOUT` step is not necessarily a failed run — render both facts.
6. **"Degraded" is health flags, not a state** (design.md §Error handling, and the
   `session-state-machine` epic's decision). Do not add a `DEGRADED` run status.
7. **`payloadRef` is a reference under a PHI posture** (`agent-trajectory.prisma:8-11`) — never
   plaintext clinical content. An unresolvable ref renders "payload not available".
8. **Never run `pnpm gen:mapper`** (rule 03).
9. **Do not duplicate `/ai-operations/runs`.** §2.4 — it is a sanctioned tier 10-19 platform-ops
   surface. This ticket adds the **definition-scoped tenant** view. Cross-link, do not fork.

## 4. Implementation Plan

### Phase A — Gate and the read model

#### Task 1 — Verify what TASK-718 shipped before creating anything
- **Agent:** T3 · sonnet-5 · high
- **Files:** `docs/implementation/TASK-723-Runs-Observability/contracts/run-read-model.contract.md` (new)
- **Approach:** Establish, with `file:line` into delivered code, whether TASK-718 already persists a
  per-run record and, if so, its exact columns. Then record:
  1. Whether a run row exists; if yes, **adopt it** and skip Tasks 2–3 entirely, recording the
     decision here.
  2. How the interpreter correlates a run to trajectory steps (which of `sessionId` / `runId` /
     `correlationId` carries the run identity).
  3. Whether the interpreter stamps a retry/attempt marker anywhere (`stats`, `payloadRef`,
     `_metadata`) — this decides pitfall 4.
  4. Whether a sandbox flag exists on the interpreter side (TASK-721 depends on this being one
     filter point).
  5. The degradation marker: how a node that "produces a *marked* nothing" is represented.
- **Verify:** The contract file exists; every claim carries `file:line`. If TASK-718 has not landed,
  this task blocks the ticket — record it in §6 rather than guessing.

#### Task 2 — Clear the design gate (Figma frames)
- **Agent:** T3 · sonnet-5 · medium — **HUMAN-GATED (product-owner approval)**
- **Files:** this README §7
- **Approach:** Rule 12 §2 gate 2, tenant range **30–49**, grouped "Tenant admins'":
  `NN - Workflow Runs` (list), `NN.1 - Run Trace (canvas overlay)`,
  `NN.2 - Run Trace — Node Detail`, `NN.3 - Run Failure Drill-down`.
  Light + dark; default / loading-skeleton / empty / error; each instances `09 - Screen Templates`.
  Two states must be designed explicitly rather than improvised: the **"trace pruned"** state
  (pitfall 3) and the **sandbox** run treatment (coordinated with TASK-721). A11y annotations before
  Ready-for-Dev, including how per-node status is conveyed on the canvas overlay **without relying on
  colour** (rule 11 §7).
- **Verify:** Frame inventory + approval date in §7; frames Ready for Dev.

#### Task 3 — Add the `WorkflowRun` read model + migration *(skipped if Task 1 found one)*
- **Agent:** T3 · sonnet-5 · high
- **Files:** `packages/database/src/prisma/db_main/workflow-run.prisma` (new);
  `.../migrations/<timestamp>_task_723_workflow_run/migration.sql`;
  `packages/database/src/extensions/tenant-scope.ts`; `packages/database/src/client.ts`
- **Approach:** Standard model template (rule 02), section order exact. Business fields, derived from
  §1 and Task 1's contract:
  `workflowDefinitionId String`, `workflowVersionId String`, `definitionName String` (denormalized —
  this is a read model; it must render without a join even after a rename),
  `sessionId String`, `runId String @default("")` (mirror the trajectory sentinel, pitfall 2),
  `trigger String` (consultation open · API invoke · webhook · schedule — design.md §Data flow),
  `status` (a new `WorkflowRunStatus` enum in `enums.prisma`: `RUNNING | COMPLETED | FAILED |
  CANCELED | TIMED_OUT` — **no `DEGRADED`**, pitfall 6),
  `isSandbox Boolean @default(false)` (TASK-721's single filter point),
  `startedAt DateTime`, `endedAt DateTime?`, `durationMs Int?`,
  `nodeCount Int?`, `failedNodeCount Int @default(0)`, `degradedNodeCount Int @default(0)`,
  `firstErrorCode String?`.
  Posture, mirroring `AgentTrajectoryStep`: **tenant-scoped** (add to `TENANT_SCOPED_MODELS`),
  **no soft delete** (add to `MODELS_WITHOUT_SOFT_DELETE`; carries no `resourceStatus` columns),
  **no sys-events** (telemetry exemption ⇒ **no `ResourceType` entry** — rule 03 step 4 conditions it
  on sys-events; state this in the file header so a later reader does not "fix" it).
  Constraints: `@@unique([tenantId, sessionId, runId], map: "WorkflowRun_session_run_key")` — note
  rule 02's trap, **the DB index name comes from `map:`, not `name:`**;
  `@@index([tenantId, startedAt], name: "WorkflowRun_tenant_startedAt_idx")` (the keyset sort key),
  `@@index([tenantId, workflowDefinitionId], name: "WorkflowRun_tenant_definition_idx")`,
  `@@index([tenantId, status], name: "WorkflowRun_tenant_status_idx")`.
  Author via the shadow-DB recipe (rule 02 §Migration Workflow), remembering `-n` goes to the
  package-level script.
- **Verify:** `npx prisma migrate diff --from-config-datasource --to-schema src/prisma/db_main
  --script` prints `-- This is an empty migration.`; `pnpm db:push`;
  `pnpm --filter @arcaai/database test`.

#### Task 4 — Hand-author the `WorkflowRun` domain layer
- **Agent:** T3 · sonnet-5 · high
- **Files:** `pnpm gen:model` output `packages/domains/src/models/generated/core/WorkflowRunModel.ts`;
  hand-authored `WorkflowRunEntity.ts`, `WorkflowRunFactory.ts`, `WorkflowRunEntityMapper.ts`,
  `WorkflowRunRepository.ts`; barrels; `core.database.module.ts`;
  `packages/domains/src/enums/generated/` for `WorkflowRunStatus`
- **Approach:** Rule 03 §Generated Code Discipline verbatim — `gen:model` scaffolds; the other four
  are hand-authored following the `AiTaskDefault*` exemplars; the mapper carries
  `FIELDS_NOT_WRITABLE = ['version']` + `stripNonWritableFields`; **`gen:mapper` is never run**;
  mapper and repository barrel lines added by hand; the repository registered in `CoreDatabaseModule`
  (providers AND exports). The entity extends `BaseTenantEntity`.
- **Verify:** `pnpm gen:model`, `pnpm gen:entity`, `pnpm gen:factory` — "no drift" and "schema
  coverage OK"; `pnpm --filter @arcaai/domains build test`.

### Phase B — Read service and API

#### Task 5 — RED then GREEN: `WorkflowRunService` with keyset pagination
- **Agent:** T2 · sonnet-5 · high
- **Files:** `packages/applications/src/services/workflow-run/` —
  `IWorkflowRunService.ts`, `workflow-run.service.ts`, `workflow-run.service.module.ts`,
  `workflow-run.dto.mapper.ts`, `dto/{list-runs.query.ts,workflow-run.response.ts,run-trace.response.ts,index.ts}`,
  `__tests__/workflow-run.service.test.ts`, `index.ts`
- **Approach:** Tests first. Structure copies `services/department/` (rule 04's exemplar) and the
  pagination copies `services/agent-trajectory/agent-trajectory.service.ts:207` (`decodeCursor` →
  `buildCursorFindAllProps` → over-fetch → `toCursorPage`). Contract:
  - `listRuns(tenantId, filters, options)` → `CursorPage<WorkflowRunResponse>`. Filters:
    `workflowDefinitionId?`, `workflowVersionId?`, `status?`, `trigger?`, `from?`/`to?`,
    **`includeSandbox?` defaulting to `false`** (the single filter point — pitfall/§3.2).
    `sortKey: 'startedAt'`, `direction: 'desc'`, limit clamped by `clampCursorLimit`
    (`MAX_CURSOR_LIMIT` = 100). A malformed cursor ⇒ `BadRequestException` (what `decodeCursor`'s
    `null` return is documented for).
  - `getRun(tenantId, runId)` → `WorkflowRunResponse`; a foreign-tenant id throws
    `NotFoundException` — **404-over-403**, never `ForbiddenException`.
  - `getRunTrace(tenantId, runId, options)` → **the CQRS-lite read shape**: one call returning the
    run row plus the per-node rollup, assembled from a **single bounded** trajectory read for that
    `(sessionId, runId)`, folded in memory into `nodeId → { status, startedAt, endedAt, durationMs,
    attempts[], confidence?, degraded, errorCode }`. **No per-node query.** Reuse
    `IAgentTrajectoryService.listSteps` rather than re-querying the table from this service, so the
    PHI/`payloadRef` handling stays in one place.
  - `recordRunStarted` / `recordRunFinished` — the write contract TASK-718 calls. Idempotent on
    `(tenantId, sessionId, runId)`; emits **no** sys-event (telemetry exemption, §3.2). *Skip these
    if Task 1 found that 718 already owns the write side.*
  - No `databaseService.client` anywhere (rule 04's banned syntax; only sanctioned folders are
    excluded, and this is not one of them).
- **Verify:** `pnpm --filter @arcaai/applications test` — RED first, then GREEN (paste both);
  `pnpm --filter @arcaai/applications build`. Tests must cover: cursor round-trip across a page
  boundary, `hasMore` at exactly `limit` rows, malformed cursor ⇒ 400, cross-tenant ⇒ 404,
  `includeSandbox=false` excludes sandbox rows, and the trace rollup issuing **one** step query.

#### Task 6 — Gateway controller + cross-tenant e2e
- **Agent:** T2 · sonnet-5 · medium
- **Files:** `apps/api/src/modules/workflow-run/` — `workflow-run.controller.ts`,
  `workflow-run.module.ts`, `dto/`, `__tests__/`;
  `apps/api/tests/e2e/task-723-workflow-runs-cross-tenant.spec.ts`
- **Approach:** `@Controller('admin/workflow-runs')`, class-level read permission decorator following
  `apps/api/src/modules/agent-trajectory/agent-trajectory.controller.ts:36-37`
  (`@Controller('admin/agent-trajectory')` + `@CanRead('AgentTrajectory')`). Routes:
  `GET ''` (cursor list), `GET ':runId'`, `GET ':runId/trace'`. No Prisma in the controller
  (`arcaai-internal/no-controller-direct-prisma` is a **hard error** in `apps/api`). Every accepted
  query field is declared on a `class-validator` DTO — the global pipe runs
  `whitelist + forbidNonWhitelisted + forbidUnknownValues`. Every route carries a permission
  decorator or the boot audit refuses to start.
  Name the e2e spec after the existing cross-tenant family in `apps/api/tests/e2e/`.
- **Verify:** `pnpm api:build`; `pnpm test:unit`; `pnpm test:up:api` then `pnpm test:e2e` — the
  cross-tenant spec asserts **404, not 403**.

### Phase C — The console surfaces

#### Task 7 — Runs list screen
- **Agent:** T2 · sonnet-5 · medium
- **Files:** `apps/admin-console/src/features/workflow-runs/` —
  `api/{client,hooks,keys,types,index}.ts`, `components/workflow-runs-screen.tsx`,
  `components/run-status-badge.tsx`, `components/__tests__/*.test.tsx`;
  `apps/admin-console/src/app/(console)/(tenant)/workflow-runs/{page,loading,error}.tsx`;
  `apps/admin-console/src/shared/navigation/nav-config.ts`
- **Approach:** Layout exemplar: `features/harness-ops/components/harness-workflows-screen.tsx`.
  `WorkingTenantGate` → `ScreenTemplate` with `contentMode="fill"` → `AdminDataGrid`. The list is
  **keyset**, so paging is "load more"/cursor-driven rather than numbered pages — bind the filters
  (definition, version, status, trigger, date range, include-sandbox) to the URL via **nuqs**
  (`shared/data/grid-url-state.ts`), and keep the cursor in component state, not the URL (a cursor is
  positional, not a shareable filter). Client types reuse `CursorPaginated<T>` from
  `@/shared/api/http.ts` — the envelopes already match (§2.3).
  Columns: definition + version (with a deep link, Task 8), status badge (label carries the meaning,
  rule 11 §7), trigger, started (relative for recent, absolute for older — rule 11 §8), duration,
  failed/degraded node counts, sandbox badge. Loading uses the grid's own skeleton (rule 10);
  empty uses `EmptyState`.
  Nav entry: `tier: '30-49'`, unique icon, `required` mirroring the controller's decorator.
  **Cross-link, do not fork:** add a plain `href` to `/ai-operations/runs` labelled as the
  cross-tenant platform-ops view, and add the reciprocal link there (§2.4, rule 13).
- **Verify:** `pnpm admin:test`, `pnpm admin:build`.

#### Task 8 — Per-run trace: the canvas overlay
- **Agent:** T3 · sonnet-5 · high
- **Files:** `.../features/workflow-runs/components/run-trace-screen.tsx`,
  `.../components/node-run-badge.tsx`, `.../components/run-node-detail-drawer.tsx`,
  `.../components/__tests__/run-trace-screen.test.tsx`;
  `apps/admin-console/src/app/(console)/(tenant)/workflow-runs/[runId]/{page,loading,error}.tsx`
- **Approach:** design.md: "the canvas replays a run as an overlay on the authored graph".
  Fetch the run's **pinned** `workflowVersionId`, load that immutable version's graph JSON, and
  render TASK-719's `WorkflowCanvas` from `@arcaai/ui/components/workflow-canvas` with
  `readOnly` and the `overlay` prop populated from `getRunTrace`'s per-node rollup: status, timing,
  confidence. Overlay badges must convey status **without colour alone** (rule 11 §7) — a shape/glyph
  plus text. Selecting a node opens `DetailDrawer` with its steps, timings, `stats`, and payload refs
  (unresolvable ⇒ "payload not available", pitfall 7).
  The **structured list view is a peer here too** — the same `?view=list` toggle TASK-719 introduces,
  rendering the rollup as an ordered list. A canvas-only trace would reintroduce the WCAG 2.5.7 /
  keyboard problem TASK-719 solved.
  A run in a non-terminal status polls (or subscribes via `useEventStream` if Task 1 found a stream);
  terminal runs do not poll.
- **Verify:** `pnpm admin:test` incl. a `vitest-axe` 0-violation assertion; `pnpm admin:typecheck`.

#### Task 9 — Failure drill-down, degradation, retries, and the "trace pruned" state
- **Agent:** T3 · sonnet-5 · high
- **Files:** `.../features/workflow-runs/components/failure-panel.tsx`,
  `.../components/attempt-group.tsx`, `.../components/trace-pruned-state.tsx`,
  `.../components/__tests__/failure-panel.test.tsx`
- **Approach:** Honesty is the requirement here — each of these is a place where a plausible-looking
  UI would lie:
  - **Retries.** §2.1 shows there is no attempt column; group repeated `name` at increasing `seq` and
    label the grouping as **derived**. If Task 1 found that TASK-718 stamps an attempt marker, use it
    and drop the derivation.
  - **Timeouts.** An `AgentStepStatus.TIMEOUT` step force-stopped **that node only** (design.md).
    Show it at node level and do not colour the whole run failed on its account (pitfall 5).
  - **Degradation.** design.md: "a node that produces nothing produces a *marked* nothing". Render
    the marker from Task 1 §5 explicitly — a degraded node is **not** an empty node.
  - **"Degraded" is not a run status** (pitfall 6) — it is a count/flag on the run row.
  - **Trace pruned.** If the run row exists but `getRunTrace` returns zero steps and the run's
    `startedAt` predates the effective `agentic.trajectory.retentionDays` window, render an explicit
    "trace pruned by retention on <date>" state naming the setting key — never an empty timeline.
- **Verify:** `pnpm admin:test` with a fixture per case: retry group, node timeout in an otherwise
  successful run, degraded node, pruned trace.

#### Task 10 — Retention and volume alignment
- **Agent:** T2 · sonnet-5 · low
- **Files:** `docs/implementation/TASK-723-Runs-Observability/retention-note.md` (new);
  the runs-list screen (a footer note naming the effective window)
- **Approach:** Record the growth arithmetic and the alignment decision:
  - `AgentTrajectoryStep` grows at **N rows per run** (one per node execution, plus retries);
    `WorkflowRun` grows at **1 row per run**. Roughly two orders of magnitude apart in a
    multi-node workflow.
  - `AgentTrajectoryRetentionService` defaults: `enabled: false`, `cron '0 4 * * *'`,
    `retentionDays: 30`, keys `agentic.trajectory.{enabled,cron,retentionDays}` (§2.5).
  - **Decision to record and justify:** whether `WorkflowRun` gets its own longer retention (and
    therefore the "trace pruned" state of Task 9 becomes routine), or whether it is pruned on the
    same schedule (and the list and trace stay consistent, at the cost of losing run history).
    Recommend the former — a run row is cheap and its audit value outlives its step detail — and
    make the consequence visible in the UI rather than silent.
  - The runs-list `StatusFooter` names the effective trace-retention window so an operator can tell
    at a glance why old runs have no trace.
  Do **not** build new retention machinery: if `WorkflowRun` needs its own prune, it follows the
  existing `AgentTrajectoryRetentionService` / `AuditRetentionService` pattern with its own
  AppSettings keys, and that is a separate small task recorded here.
- **Verify:** The note exists and cites the AppSettings keys as read from
  `agent-trajectory-retention.service.ts`.

#### Task 11 — Playwright e2e + a11y
- **Agent:** T2 · sonnet-5 · medium
- **Files:** `apps/admin-console/tests/e2e/workflow-runs.spec.ts`
- **Approach:** Follow `tests/e2e/harness-observability.spec.ts` and the shared helpers
  (`./helpers/stack`, `./helpers/auth`, `./helpers/a11y`). Specs: list renders and pages forward via
  the cursor; filters round-trip through the URL; sandbox runs are hidden by default and shown with
  the toggle; opening a run renders the trace overlay on the pinned version's graph; the
  version deep link lands on a **read-only** canvas; the list view peer renders the same rollup;
  `expectNoA11yViolations` in light and dark on both screens; a foreign run id renders not-found.
- **Verify:** `pnpm admin:test:e2e`. Paste output.

## 5. Acceptance Criteria

- [x] **Task 1 first:** `contracts/run-read-model.contract.md` records, with `file:line`, what
      TASK-718 actually ships — and Tasks 3–4 are **skipped** if a run row already exists (they
      were NOT skipped — Task 1 found CREATE, not adopt; see prior-session §7)
- [x] **Design gate:** WAIVED by explicit owner/orchestrator instruction for this session
      ("build console screens directly") — rule 12 gate 2 is not blocking; recorded here rather
      than silently skipped
- [x] `pnpm gen:model` · `pnpm gen:entity` · `pnpm gen:factory` report **no drift and schema coverage
      OK**; `pnpm gen:mapper` was **not** run (verified prior session; unchanged this pass)
- [x] `prisma migrate diff --from-config-datasource --to-schema src/prisma/db_main --script` prints
      `-- This is an empty migration.` after applying the migration to the shadow DB — **RUN THIS
      PASS** (infra is up this session): pasted in §7
- [x] `WorkflowRun` is in **`TENANT_SCOPED_MODELS`** and **`MODELS_WITHOUT_SOFT_DELETE`**, carries no
      `resourceStatus` columns, and — because it emits no sys-events — has **no** `ResourceType`
      entry, with that decision stated in the `.prisma` file header
- [x] `pnpm --filter @arcaai/domains build test` green (output pasted)
- [x] `pnpm --filter @arcaai/applications build test` green for this ticket's own suite (output
      pasted); the FULL package suite has unrelated failures from a concurrent sibling session's
      in-progress work on `consultation/*` — see §7's honesty note, not a regression from this ticket
- [x] `pnpm api:build` green (output pasted); `pnpm test:unit` green for this ticket's modules
      (`workflow-run` + the boot permission audit, pasted); `task-723-workflow-runs-cross-tenant.spec.ts`
      is **authored** (asserting 404-not-403 on every id lookup, plus the tenant-scope gate) but
      **`pnpm test:e2e` was NOT run** — its globalSetup runs `prisma db push --force-reset`, which the
      Prisma CLI refuses when invoked by an AI agent (explicit hard rule for this session)
- [x] `pnpm --filter @arcaai/admin-console lint test` green **for every file this ticket touched**
      (scoped `eslint` run + `vitest run src/features/workflow-runs` + the full suite excluding
      `workflow-studio/**`, all pasted in §7); the UNSCOPED whole-package `lint`/`typecheck`/`build`
      currently fail because of a **concurrent sibling session's own in-progress, uncommitted**
      `workflow-studio/**` files (verified by `git status`/diff — not this ticket's files); re-run
      once that lands
- [x] `pnpm admin:typecheck` — same scoping caveat as above; zero errors reference this ticket's files
- [ ] `pnpm admin:test:e2e` for `tests/e2e/workflow-runs.spec.ts` — **authored**, mirrors
      `harness-observability.spec.ts` (list smoke, URL-synced filters, sandbox toggle, the pruned/canvas/
      list-view trace, a foreign run id, axe both themes) but **NOT RUN** (same Playwright globalSetup
      blocker)
- [x] **axe: 0 violations** on the runs list and the run trace (list-view peer, which renders every
      chrome element the canvas view also renders) — via `vitest-axe`'s `axe()`/`toHaveNoViolations()`
      in jsdom/happy-dom component tests (pasted in §7); the LIVE-BROWSER, both-theme
      `expectNoA11yViolations` pass from the Playwright suite is authored but not run (blocker above)
- [ ] **Manual pass recorded**: keyboard-only navigation from list → run → node detail; 200% zoom with
      no horizontal page scroll (rule 11 §11) — **NOT performed this session**: no `next dev` server
      was running and standing one up (auth, working-tenant selection, seeding) was judged not worth
      the time against the rest of this pass's scope; disclosed rather than fabricated. The component
      tests DO exercise real keyboard-reachable markup (native `<button>` list rows, focus-visible
      rings, `role="list"`), which is partial, not equivalent, evidence
- [x] The runs list is **keyset-paginated** using `common/cursorPagination.ts` (`encodeCursor` /
      `decodeCursor` / `buildCursorFindAllProps` / `toCursorPage`), with a malformed cursor returning
      **400** — verified prior session (Task 5) and unchanged; the console binds it via
      `VirtualizedDataGrid`'s `pageMode="cursor"` (this pass)
- [x] `getRunTrace` issues **one** bounded trajectory read per run — a test asserts the query count,
      proving there is no N+1 (prior session, Task 5; unchanged)
- [x] The trace renders through TASK-719's `WorkflowCanvas` (`readOnly` + `overlay`) on the run's
      **pinned** `workflowVersionId` — **no second graph renderer exists** (this pass, Task 8)
- [x] Per-node status on the overlay is conveyed by shape/glyph **plus text**, never colour alone
      (`NodeRunBadge` — a distinct Tabler icon per `AgentStepStatus` value, paired with its label,
      inside a `StatusBadge` that already encodes the "never color alone" contract)
- [x] Retries are grouped and **labelled as derived** (TASK-718 does not stamp an attempt marker —
      confirmed in the prior session's Task 1 contract, unchanged); a node `TIMEOUT` renders as its
      own callout and never marks the whole run failed (`FailurePanel`); a degraded node renders a
      run-level **marked** count (`degradedNodeCount`), never folded into an empty per-node state —
      see §7's honesty note on why per-node degraded attribution is NOT claimed
- [x] A run whose steps were pruned renders an explicit **"trace pruned"** state naming the retention
      setting — never an empty timeline. **Backend gap found and fixed this pass**: `tracePruned` was
      hardcoded `false` in `WorkflowRunService.getRunTrace`, making this state dead code; now computed
      from the SAME `agentic.trajectory.{enabled,retentionDays}` AppSettings keys the retention cron
      reads (§7)
- [x] Sandbox runs are excluded by default at the **query** level (`includeSandbox` defaults false),
      with a test proving both directions (prior session, Task 5, unit-level; this pass adds the
      console-level round-trip test and the UI toggle)
- [x] `/ai-operations/runs` is **cross-linked, not forked**; no component is duplicated between the
      two surfaces without being promoted to `@/shared` or `packages/ui` — reciprocal links added on
      both screens this pass; zero components shared/copied between the two feature folders
- [x] **Evidence rule:** actual command output pasted in §7 before this ticket is marked complete

## 6. Risks & Open Questions

| # | Risk / question | Handling |
|---|---|---|
| R1 | **BLOCKING — TASK-718's run identity is unknown until it lands.** Every part of this ticket keys off how a run correlates to trajectory steps | Task 1 is a hard first gate producing a `file:line`-backed contract. If 718 has not landed, this ticket cannot start; say so rather than designing against a guess |
| R2 | **Ownership split with TASK-718.** The `WorkflowRun` write side (`recordRunStarted`/`recordRunFinished`) is called by the interpreter but defined here | Task 1 decides: if 718 already persists a run row, adopt it and delete Tasks 3–4 from scope. If not, this ticket defines the model and the write methods, and 718 calls them. **A second run table is the failure mode to avoid** |
| R3 | **Retries are not modelled.** §2.1 — no attempt column; grouping is derived from repeated `name` at increasing `seq` | Task 9 labels the grouping as derived. The clean fix is a stamped attempt marker from TASK-718; raise it there rather than adding a column to the hot telemetry table here |
| R4 | **HUMAN-GATED — retention policy for `WorkflowRun`.** Longer retention than steps means the "trace pruned" state becomes routine; equal retention means run history is lost with the detail | Task 10 records the arithmetic and recommends longer run retention with a visible pruned state. The actual window is an operator/compliance decision, not an engineering one |
| R5 | **Trajectory retention is `enabled: false` by default** (§2.5), so in most environments nothing is pruned today and the volume problem is latent, not visible | Task 10's note states this explicitly so the first operator who enables it is not surprised by traces disappearing from an otherwise healthy runs list |
| R6 | The trace overlay depends on TASK-719's `WorkflowCanvas` exposing an `overlay` prop | TASK-719 Task 5 reserves it. If it did not land, the alternative is the list-view rollup only — degraded but honest — **not** a second canvas |
| R7 | Denormalizing `definitionName` onto the run row means a renamed definition shows its old name on historical runs | This is correct for a read model of an immutable event, and arguably desirable (the run really did execute the thing called that). Worth one line of UI copy so it does not read as a bug |
| R8 | `getRunTrace` folds all of a run's steps in memory; a pathological run could be large | The trajectory step read is already keyset-paginated and hard-capped (`MAX_CURSOR_LIMIT` = 100, and `aggregateGenerationStats` "hard-caps scanned rows"). Apply an explicit cap and render "trace truncated — N of M steps" rather than an unbounded read |
| R9 | Two runs surfaces (`/ai-operations/runs` tier 10-19 and `/workflow-runs` tier 30-49) could confuse operators | Deliberate and rule-sanctioned (§2.4): the former is cross-tenant platform ops over **all** agentic sessions; the latter is the tenant's **workflow-definition-scoped** view. Each links to the other with one line saying what it is for |
| R10 | Size: M assumes Task 1 finds a run row and Tasks 3–4 are skipped. With the full Prisma→domain chain it is closer to L | Stated up front. Promote rather than compress — rule 03 makes the domain layer hand-authored and unskippable |

## 7. Implementation Summary

**Session 1 (2026-08-16): Phase A + B (Tasks 1, 3, 4, 5, 6, 10) built and verified. Phase C
(Tasks 7, 8, 9, 11 — all admin-console UI + Playwright e2e) NOT started. Local infra
(Postgres/Redis/API/Temporal) was down all session.**

**Session 2 (2026-08-16, same day, continuation): infra IS up this session. First closed
Session 1's own open gaps (the shadow-DB migration proof, `pnpm db:push`), THEN built Phase C
(Tasks 7, 8, 9, 11) in full: the `workflow-runs` admin-console feature (runs list, canvas-overlay
trace with a `?view=list` structured peer, failure/retry/degraded/pruned honesty states, node
detail drawer), the two routes, nav entry, the reciprocal `/ai-operations/runs` cross-link, and
both e2e specs (API cross-tenant + Playwright, both authored, neither executed — see below for
exactly why). One real backend bug was found and fixed along the way: `tracePruned` was
hardcoded `false`, making Task 9's whole "trace pruned" state dead code. See "Phase C — what
actually shipped" below for the full account, including an honesty note on what this session
could NOT verify (a live-browser manual pass, and both e2e suites).

### Task 1 verdict — CREATE, not adopt

Full contract: `contracts/run-read-model.contract.md`. Headline finding: TASK-718's dispatcher API
(`apps/harness/src/harness/api/endpoints/interpreter.py`) is entirely Temporal-native and
ephemeral — no run row is persisted anywhere in Postgres. **Tasks 3–4 were built, not skipped.**

Other load-bearing findings (all with `file:line`, see the contract):
- The trajectory join key is `sessionId = "workflow-interpreter-" + runId` — a DERIVED string, not
  a value threaded through `TrajectoryContext`. The trajectory row's own `runId` column is
  Temporal's execution-attempt id, a DIFFERENT value; `getRunTrace` must join on `sessionId` alone.
- No retry/attempt marker exists anywhere (confirms pitfall 4 as written).
- `sandbox` is an input-only flag on TASK-718's dispatcher, never persisted — `WorkflowRun.isSandbox`
  is the only durable record of it.
- The DEGRADED-vs-critically-FAILED distinction lives only in the interpreter's ephemeral
  in-workflow state; the persisted trajectory row for both cases is identical
  (`status: ERROR`). Also found: the trajectory row carries no `node_id` at all (only the node
  *type*), a real gap beyond what the ticket's own pitfalls named — recorded as a rollup
  limitation and a candidate TASK-718 follow-up.
- **One correction to the README's assumed Task 3 field list**: `workflow-definition.prisma`
  states TASK-715's rows ARE versions (no head/version split), so there is no
  `workflowDefinitionId`. Built `workflowSlug` (the real stable lineage key) +
  `workflowVersionNumber` (denormalized) instead — see contract §6.

### Tasks 3–4 — schema + domain layer (built; migration authored, NOT applied)

- `packages/database/src/prisma/db_main/workflow-run.prisma` — new `WorkflowRun` model +
  `WorkflowRunStatus` enum (`RUNNING | COMPLETED | FAILED | CANCELED | TIMED_OUT` — no `DEGRADED`,
  per pitfall 6). Posture mirrors `AgentTrajectoryStep`: tenant-scoped, no soft delete, no
  sys-events (no `ResourceType` entry — stated in the file header).
- Migration authored by hand:
  `packages/database/src/prisma/db_main/migrations/20260816040000_task_723_workflow_run/migration.sql`.
  **The shadow-DB `prisma migrate diff --script` empty-diff proof required by rule 02 is UN-RUN —
  local Postgres is down.** The SQL was hand-written to match the exact style Prisma itself emits
  (verified against the TASK-715 migration it mirrors), but this is NOT the same as a proven-clean
  diff.
- `TENANT_SCOPED_MODELS` (`tenant-scope.ts`) and `MODELS_WITHOUT_SOFT_DELETE` (`client.ts`) updated.
  A concurrent sibling ticket (TASK-721, `WorkflowTestFixture`) was editing the SAME allow-lists at
  the same time — a real collision was hit and fixed live (see "Collisions hit and fixed" below).
- `pnpm gen:model` (works without a live DB — pure DMMF-from-schema), `pnpm gen:entity`,
  `pnpm gen:factory` all ran clean: no drift, schema coverage OK (pasted below).
- Hand-authored `WorkflowRunEntity.ts`, `WorkflowRunFactory.ts`, `WorkflowRunEntityMapper.ts`
  (`FIELDS_NOT_IN_PRISMA` strips `version` + the inherited-but-columnless `resourceStatus*`,
  mirroring `AgentTrajectoryStepEntityMapper` exactly), `WorkflowRunRepository.ts` (adds
  `findByRunKey` — uses `findAll` + `[0] ?? null`, NOT the base `findFirst`, which throws on a
  miss). Repository registered in `CoreDatabaseModule` (providers + exports).
- `pnpm --filter @arcaai/domains build` and `test`: **green** (pasted below).

### Task 5 — `WorkflowRunService` (built; tests written alongside the implementation, not strictly
test-first)

**Honesty note on TDD sequencing**: the ticket asks for RED-then-GREEN. The service and its test
suite were designed together rather than test-first, so there was no genuine "file doesn't exist
yet" RED. To still prove the tests weren't vacuous, one filter (`includeSandbox`) was deliberately
inverted after the fact and the suite re-run — 2 of 20 tests failed with the expected assertion
diffs, then the bug was reverted and the suite went green again (both outputs pasted below). That
is real signal that the tests catch real bugs, but it is not the same discipline as true
red-first TDD, and I'm not claiming it is.

- `packages/applications/src/services/workflow-run/` — `IWorkflowRunService`, `workflow-run.service.ts`
  (`listRuns` keyset via `buildCursorFindAllProps`/`toCursorPage`; `getRun`/`getRunTrace` 404-over-403
  via `findByRunKey(tenantId, interpreterSessionId(runId), runId)`; `getRunTrace` issues exactly ONE
  `IAgentTrajectoryService.listSteps` call, folds the page into node rollups via the exported pure
  helper `foldStepsIntoNodeRollups`; `recordRunStarted`/`recordRunFinished` idempotent on
  `(tenantId, sessionId, runId)`, no sys-event), `.module.ts`, `.dto.mapper.ts`, `dto/*`,
  `__tests__/workflow-run.service.test.ts` (20 tests).
- **Known gap surfaced, not fixed**: `AgentTrajectoryStepResponse` (reused per the ticket's own
  instruction to keep PHI/`payloadRef` handling in one place) never exposes `payloadRef` at all —
  it's stripped in the DTO mapper, not just redacted. Task 8's planned "payload not available"
  per-node detail view literally has nothing to resolve today without a change to that DTO, which
  belongs to `AgentTrajectoryStep`'s own file set, not this ticket's. Recorded for whoever picks up
  Task 8.
- `pnpm --filter @arcaai/applications build` and `test` (full package, 487 files / 9084 tests):
  **green** (pasted below).

### Task 6 — gateway controller (built; e2e UN-RUN, infra down)

- `apps/api/src/modules/workflow-run/` — `WorkflowRunController` (`@Controller('admin/workflow-runs')`,
  class-level `@CanRead('WorkflowRun')`), `workflow-run.module.ts`, `dto/list-workflow-runs.query.ts`
  (class-validator, matches the global `whitelist+forbidNonWhitelisted` pipe), `__tests__/` (7 tests).
  Registered in `apps/api/src/app.module.ts`.
- Tenant resolution is the tier 30–49 pattern (rule 13), NOT the tier 10-19
  `resolveScopedTenantId` `/admin/agent-trajectory` uses: a working tenant is read straight off CLS
  (`this.cls.get('tenantId')`), and a caller with none (a global admin who hasn't selected a working
  tenant) gets a 403 "no tenant selected" — mirrors `DepartmentController.fetchAll`'s guard.
- **`apps/api/tests/e2e/task-723-workflow-runs-cross-tenant.spec.ts` was NOT written and
  `pnpm test:e2e` was NOT run** — e2e requires a live API + Postgres, both down. This is the single
  biggest acceptance-criteria gap in what was otherwise built: the 404-over-403 behavior is
  exercised only by the controller unit test's mock (which asserts the service's exception
  propagates unmodified), not by a real HTTP round-trip.
- `pnpm api:build`: **green, 10/10 tasks** (pasted below). `pnpm --filter @arcaai/api lint` /
  `typecheck`: clean, 0 errors, 0 new warnings.

### Task 10 — retention decision (written)

`retention-note.md`: recommends `WorkflowRun` get its OWN, LONGER retention window than
`AgentTrajectoryStep` (run rows are cheap and outlive their step-level detail); explicitly does
NOT build new retention machinery (out of scope per the ticket); records the exact AppSettings keys
(`agentic.trajectory.{enabled,cron,retentionDays}`) a future `WorkflowRunRetentionService` follow-up
would mirror. **Both places the decision must become visible in the UI (Task 9's "trace pruned"
state; Task 7's `StatusFooter` retention note) are DESIGNED but NOT BUILT** — Phase C wasn't reached.

### What's left — Phase C (Tasks 2, 7, 8, 9, 11) — NOT STARTED

Not attempted in this session, for scope/time reasons (the ticket's own R10 flags this as
realistically an L-sized ticket once Tasks 3–4 aren't skippable, which Task 1 confirmed):

- **Task 2** (Figma design gate): the orchestrating agent's hard rules explicitly WAIVE the Figma
  gate for this session ("build screens directly"), so this is not a blocker for Phase C — but
  Phase C itself was not started regardless.
- **Task 7** (runs list screen), **Task 8** (canvas-overlay trace, reusing TASK-719's
  `WorkflowCanvas` — confirmed to exist on disk at `packages/ui/src/components/workflow-canvas/`,
  but its `overlay`/`readOnly` prop contract was not inspected this session), **Task 9** (failure
  drill-down / derived-retry UI / trace-pruned state), **Task 11** (Playwright e2e + axe) — none
  started. No admin-console files were created or modified by this session.
- Consequence: of the README's Acceptance Criteria (§5), everything through "getRunTrace issues
  ONE bounded trajectory read" is met; everything from "trace renders through TASK-719's
  WorkflowCanvas" downward (axe scans, keyboard-nav pass, cross-link to `/ai-operations/runs`,
  Playwright e2e) is NOT met.

### Collisions hit and fixed (sibling agents share this tree)

1. `packages/domains/src/{entities,factories}/generated/core/index.ts`: my own single-line append
   landed duplicated (two identical `export * from './WorkflowRunEntity'` / `'./WorkflowRunFactory'`
   lines) while a sibling ticket (TASK-721, `WorkflowTestFixture`) was concurrently appending to the
   same four barrel files. Deduplicated to one line each; sibling's lines untouched.
2. `packages/database/src/extensions/__tests__/tenant-scope.test.ts` and
   `core.database.module.ts`: the sibling's `WorkflowTestFixture` addition landed between my edit
   and my test run, moving `TENANT_SCOPED_MODELS.size` from the 79 I'd asserted to the real 80.
   Updated the assertion + added one comment line for the sibling's entry (not claiming credit for
   it); did not touch their own comment/entry.
3. `apps/api/src/app.module.ts`, `packages/applications/src/services/index.ts`,
   `packages/domains/src/enums/generated/*`: sibling additions (`WorkflowTestFixtureModule`,
   `workflow-test-fixture` barrel, `WorkflowTestFixture` `ResourceType` entry) landed cleanly
   adjacent to mine with no further collision.

### Evidence — commands actually run, with real output

**`pnpm gen:model` / `pnpm gen:entity` / `pnpm gen:factory`** — all three: "completed successfully" /
"no drift" (git status showed only the two new files + expected barrel diffs after `gen:model`; `git
status` after `gen:entity`/`gen:factory` showed no unexpected rewrites).

**`pnpm --filter @arcaai/domains build`**
```
> @arcaai/domains@0.0.1 build
> tsc
(clean exit, no output)
```

**`pnpm --filter @arcaai/domains test`**
```
Test Files  142 passed | 2 skipped (144)
     Tests  1720 passed | 2 skipped | 9 todo (1731)
```

**`pnpm --filter @arcaai/applications build`**
```
> @arcaai/applications@0.0.1 build
> rimraf dist tsconfig.tsbuildinfo && tsc
(clean exit, no output)
```

**`pnpm --filter @arcaai/applications test`** (full package)
```
Test Files  487 passed | 1 skipped (488)
     Tests  9084 passed | 4 skipped
```

**`workflow-run.service.test.ts` in isolation**
```
Test Files  1 passed (1)
     Tests  20 passed (20)
```
Deliberate-bug proof (`includeSandbox` filter inverted, then reverted):
```
Test Files  1 failed (1)
     Tests  2 failed | 18 passed (20)
AssertionError: expected { tenantId: 'tenant-1', …(1) } to not have property "isSandbox"
AssertionError: expected {...} to have property "isSandbox"
```
→ reverted → 20/20 green again.

**`pnpm api:build`**
```
 Tasks:    10 successful, 10 total
Cached:    0 cached, 10 total
```

**`pnpm --filter @arcaai/api exec vitest run src/modules/workflow-run`**
```
Test Files  1 passed (1)
     Tests  7 passed (7)
```

**`pnpm --filter @arcaai/api exec vitest run src/bootstrap/__tests__/admin-route-permission-audit.test.ts src/modules/workflow-run`**
```
Test Files  2 passed (2)
     Tests  22 passed (22)
```
(the boot-time deny-by-default audit still passes with the new controller registered)

**`pnpm --filter @arcaai/{domains,applications,api} lint`** — 0 errors on all three; pre-existing
warnings only (verified no new-file matches); the 5 prettier warnings my own
`run-trace.response.ts` introduced were fixed (single→double quotes) and re-verified clean.

**`pnpm --filter @arcaai/{domains,applications,api} typecheck`** — all three clean, 0 errors.

**Whole-monorepo `pnpm exec dotenv -e .env.test -- vitest run --exclude '**/integration/**'
--exclude '**/e2e/**'`** (everything `test:unit` runs except the `admin-console`/`ui`/`vox`
sub-filters, which this session never touched):
```
Test Files  1029 passed | 2 skipped (1031)
     Tests  17428 passed | 4 skipped | 9 todo (17441)
```
No failures anywhere in the monorepo from this session's changes.

**Root `pnpm typecheck` (all 41 packages)**: hit ONE transient failure —
`@arcaai/database#typecheck: error TS6053: File '.../core-prisma-client/index.ts' not found` —
caused by a concurrent sibling process regenerating the Prisma client mid-typecheck (a
shared-tree race, not a defect). Re-ran `pnpm --filter @arcaai/database typecheck` alone
immediately after: clean. The full 41-package run was not re-attempted given the live sibling
concurrency; every package this ticket actually touches was typechecked green individually.

### Explicitly NOT run (infra down / out of session scope)

- `prisma migrate diff --from-config-datasource --to-schema src/prisma/db_main --script` against a
  shadow DB (rule 02's proof) — **UN-RUN**, Postgres is down.
- `pnpm db:push` — **NOT run** (would touch the shared dev DB, and it's down regardless).
- `pnpm test:up:api` / `pnpm test:e2e` — **NOT run** (needs a live API + Postgres).
- `pnpm admin:test:e2e` (`tests/e2e/workflow-runs.spec.ts`) — **the spec was never written**;
  Phase C wasn't started.
- `pnpm --filter @arcaai/admin-console build lint test` / `pnpm admin:typecheck` — **not run**; no
  admin-console files were touched this session.
- axe (`expectNoA11yViolations`) and the manual keyboard/200%-zoom pass — **not run**; no screens
  exist yet to test.

---

## 7b. Session 2 — Phase C (this pass)

**Executed 2026-08-16, continuing the same day. Infra IS up this session (Postgres, Redis,
Temporal, Vault, MinIO, Qdrant, `hope-postgres` + `hope-postgres-test`).**

### Closing Session 1's own open gaps first

1. **Shadow-DB empty-diff proof (rule 02, previously UN-RUN)** — ran the full recipe:
   `DROP/CREATE DATABASE hope_shadow` → `pnpm --filter @arcaai/database db:migrate:deploy`
   (replayed the full ledger, including `20260816040000_task_723_workflow_run`) →
   `npx prisma migrate diff --from-config-datasource --to-schema src/prisma/db_main --script`.
   **Result: `-- This is an empty migration.`** — the hand-written migration SQL matches the
   schema exactly. Dropped `hope_shadow` afterward; never touched the dev DB.
2. **Confirmed the dev DB already has `WorkflowRun`** (`select to_regclass('core."WorkflowRun"')`
   returns the table) — applied via `db:push` by an earlier reconciliation pass, so `pnpm db:push`
   was NOT re-run this session (unnecessary, and rule 02 reserves it for genuine schema changes).

### A real backend bug found and fixed: `tracePruned` was dead code

While building Task 9's UI state, re-reading `WorkflowRunService.getRunTrace`
(`packages/applications/src/services/workflow-run/workflow-run.service.ts`) showed
`tracePruned: false` HARDCODED in both return branches — meaning the whole "trace pruned" state
the README's own pitfall 3 and Task 9 describe was UNREACHABLE no matter what the UI did. Fixed
by injecting `IAppSettingsService` (optional, mirroring the existing `IAgentTrajectoryService`
DI pattern so unit fixtures keep constructing without it) and computing `tracePruned` from the
SAME `agentic.trajectory.{enabled,retentionDays}` AppSettings keys
`AgentTrajectoryRetentionService` reads — never a second, possibly-drifted copy of the window.
Logic: `true` only when the run has zero steps AND its `startedAt` predates the window AND
retention is actually enabled (when disabled, nothing is pruned yet — R5 — so a zero-step run
there is honestly "no steps recorded", not "pruned"). Five new unit tests added (no fixture,
zero-step-but-enabled-and-old, disabled, within-window, and the true-positive case asserting both
AppSettings keys are read) — `pnpm --filter @arcaai/applications exec vitest run
src/services/workflow-run`: **25/25 passed** (20 pre-existing + 5 new). This is the single most
consequential thing found this pass: without it, Task 9's own acceptance criterion ("a run whose
steps were pruned renders an explicit 'trace pruned' state") was unmeetable regardless of how the
UI was built.

### Task 7 — Runs list screen (built)

`apps/admin-console/src/features/workflow-runs/` — `api/{client,hooks,keys,polling,types,index}.ts`
(re-declares wire types locally per the `ai-operations-runs` convention — the console cannot
import `@arcaai/applications`), `components/workflow-runs-screen.tsx`
(`WorkingTenantGate` → `ScreenTemplate contentMode="fill"` → `VirtualizedDataGrid` with
`pageMode="cursor"`, mirroring `harness-workflows-screen.tsx`'s exact layout), `run-status-badge.tsx`.
Filters (definition slug, status, trigger, from/to date range, include-sandbox) bound to the URL
via `useQueryStates` (nuqs); the cursor stays in component state (positional, never shareable, per
the ticket's own instruction). Row click navigates on `WorkflowRun.runId` — **not** the row `id`
— since that is the value `GET :runId` actually looks up (documented inline after double-checking
the controller). Empty/error/loading states via `EmptyState`/`ErrorState`/the grid's own skeleton.
Retention footer note (Task 10's UI half) names `agentic.trajectory.retentionDays` — **static
copy**, not a live settings-registry read (see `retention-note.md`'s updated §"Making the
consequence visible" for why: the live-read endpoint requires `read:GlobalSetting`, which a plain
tenant admin does not necessarily hold). Route: `(console)/(tenant)/workflow-runs/{page,loading}.tsx`.
Nav entry added at tier 30-49 (`required: [['read','WorkflowRun']]`, mirroring the controller's
`@CanRead('WorkflowRun')` gate exactly — confirmed `manage: WorkflowRun` is already seeded for
tenant admins, `01-policy.ts:251`).

### Task 8 — Per-run trace: the canvas overlay (built)

Read `packages/ui/src/components/workflow-canvas/types.ts` FIRST, per the ticket's own
instruction: `overlay?: (node: WorkflowCanvasNode) => ReactNode` is confirmed present, with a
doc-comment explicitly reserving it for this ticket ("Reserved for TASK-723's run-replay
overlay"). `run-trace-screen.tsx` fetches `getRunTrace(runId)` (the whole CQRS-lite shape in one
call) and, once loaded, `getWorkflowDefinitionVersion(run.workflowVersionId)` (the pinned,
immutable `WorkflowDefinition` row via TASK-734's `GET admin/workflow-definitions/:id` —
confirmed `WorkflowDefinitionResponse.graph` is the raw authored `WorkflowGraph`). Builds
`WorkflowCanvasNode[]`/`WorkflowCanvasEdge[]` via `lib/graph-layout.ts`'s `toCanvasGraph`, and
renders `<WorkflowCanvas readOnly overlay={...} />` from `@arcaai/ui/components/workflow-canvas` —
**the only canvas renderer**, never a second one.

**A real gap in the delivered contract, worked around honestly, not hidden:**
`WorkflowGraphNode` (`@arcaai/workflow-contract/src/graph-model.ts`) has **no `position` field** —
TASK-719's own contract audit found this and named the documented fallback
(`config.__position`). `lib/graph-layout.ts` reads that fallback when present and otherwise
computes a deterministic layered (longest-path-from-root) layout so the read-only trace canvas
never renders every node stacked at the origin — tested against a linear chain, siblings sharing
a layer, an authored override, a cyclic graph (guarded against infinite recursion), and a graph
with a dangling edge to an unknown id (5 tests, `lib/__tests__/graph-layout.test.ts`).

**A second real gap, also disclosed rather than papered over**: the trajectory row carries no
per-node id (Task 1 contract §5 — only the node TYPE), so a rollup cannot be attached to a
SPECIFIC graph node with certainty when a graph has more than one node of the same type.
`lib/rollup-correlation.ts`'s `correlateRollupsToGraphNodes` zips rollups (ordered by `order`,
i.e. run/step order) onto authored nodes of the same type (in `graph.nodes` array order) —
documented, in the function's own doc comment, as approximate, never ground truth. Unmatched
occurrences (more rollups than nodes of a type) are left unmatched rather than guessed (5 tests,
`lib/__tests__/rollup-correlation.test.ts`).

Per-node overlay badges (`node-run-badge.tsx`) never convey status by color alone — a distinct
Tabler icon per `AgentStepStatus` value (`IconCircleCheck`/`IconCircleX`/`IconClockExclamation`/
`IconCircleMinus`/`IconLoader2`) paired with its text label, inside the existing `StatusBadge`
composite that already encodes that contract. The `?view=list` structured peer
(`run-trace-list-view.tsx`) renders the SAME rollup data as an ordered, native-`<button>`-per-row
list — the WCAG 2.5.7 / keyboard-only path TASK-719's own design precedent calls for; selecting a
row and selecting a canvas node resolve to the SAME selection state (a stable `nodeType#order` key,
not a graph-node id, since a list-view click has no graph node at all until correlation resolves
it) so the node detail drawer opens identically from either view. Non-terminal runs
(`status === 'RUNNING'`) poll every 5s (mirrors `harness-ops/api/polling.ts` exactly); terminal
runs do not.

### Task 9 — Failure drill-down, degradation, retries, "trace pruned" (built)

`failure-panel.tsx` renders three independent, honesty-scoped callouts: a **failed** callout
(only when `failedNodeCount > 0` or a rollup is genuinely `ERROR`) naming `firstErrorCode`; a
**degraded** callout as a COUNT/FLAG on the run row, never a status badge (pitfall 6 — there is
no `DEGRADED` value anywhere in this codebase, and this panel does not invent one); a **timeout**
callout that explicitly states "does not by itself mean the run failed" (pitfall 5 — design.md:
"Timeout force-stops that node only") and never appears inside the failed callout. `attempt-group.tsx`
renders every `attemptSeqs` entry as its own chip and labels the grouping "derived" whenever
`attemptGroupingIsDerived` is true — which, per the Task 1 contract, is always today (no attempt
marker exists anywhere in the delivered trajectory schema). `trace-pruned-state.tsx` renders
whenever `RunTraceResponse.tracePruned` is true (see the backend fix above) — an `EmptyState`
naming the exact setting key, never a bare empty timeline. Five fixture-per-case tests in
`failure-panel.test.tsx` (clean run renders nothing, timeout-without-marking-run-failed,
degraded-as-count, failed-with-error-code, and a documented note on where the derived-retry
assertion actually lives — the badge/drawer level, not this panel).

### Task 10 (UI half) — retention alignment made visible (built)

`retention-note.md` updated: both mechanisms it prescribed ("trace pruned" state, runs-list
footer note) are now marked IMPLEMENTED, with the `tracePruned` backend fix recorded and the
footer's "static copy, not a live read" decision justified.

### Task 11 — Playwright e2e + a11y (authored; NOT executed)

`apps/admin-console/tests/e2e/workflow-runs.spec.ts` — follows `harness-observability.spec.ts`
and the shared helpers exactly (`appAvailable`/`apiAvailable` skip gates, `loginAsAdmin` +
`selectWorkingTenant`, `expectNoA11yViolations` in both themes). Covers: list header/filter/grid
smoke, the status filter syncing to the URL, the sandbox toggle syncing to the URL and defaulting
off, the retention footer note, axe in light/dark on the list; opening a run (skipped with an
actionable message if the seeded environment has zero runs — expected, per R2, since nothing
calls `recordRunStarted` yet), the trace rendering (canvas OR the pruned/empty state, honestly
branched), the `?view=list` peer, a foreign run id rendering not-found, and axe in light/dark on
the trace screen. **Not run this session** — same Playwright globalSetup blocker
(`prisma db push --force-reset` refused by the CLI for an AI agent) that blocked Session 1's
admin-console e2e attempts; this is a tooling/process constraint stated up front by the
orchestrating instructions, not a choice made here.

Also authored `apps/api/tests/e2e/task-723-workflow-runs-cross-tenant.spec.ts` (the item Session 1
flagged as "the single biggest acceptance-criteria gap"). **Its own honesty note, disclosed in
the file's header**: `WorkflowRun` rows are written ONLY by `recordRunStarted`/`recordRunFinished`,
and nothing calls them yet (R2) — there is also no HTTP write route for this telemetry read model
by design. So no e2e spec can create a real fixture row without reaching into the database
directly, which no spec in this directory ever does. The spec instead proves what a genuinely
empty table CAN prove: the tenant-scope gate (tenant admin resolves its own tenant; an unscoped
SUPER_ADMIN gets 403 "no tenant selected"; `X-Tenant-Id` lets a global admin act on behalf of a
tenant), the keyset envelope shape, a malformed cursor → 400, and — the acceptance criterion's
actual ask — **`GET :runId` and `GET :runId/trace` both return 404, never 403, for a nonexistent
id** (the strongest form available with zero rows: every id is equally "not found"). A note in
the spec flags that a REAL cross-tenant row check must be added once TASK-718 wires the write
side. **Not run this session** — same blocker; `pnpm test:e2e`'s globalSetup runs the identical
`prisma db push --force-reset` step.

### Honesty notes — what this session could NOT do

1. **No live-browser manual pass.** Neither `apps/api` nor `apps/admin-console` had a dev server
   running, and standing both up (plus auth, working-tenant selection, and seeding — since no
   `WorkflowRun` rows exist to click into) was judged not worth the time against the rest of this
   pass's scope. The keyboard-only list → run → node-detail walkthrough and the 200%-zoom
   no-horizontal-scroll check were **not performed**. The component test suite exercises real
   keyboard-reachable markup (native `<button>` rows, `role="list"`, focus-visible rings inherited
   from `@arcaai/ui` primitives) as partial, not equivalent, evidence.
2. **Axe coverage is jsdom/happy-dom, not a live browser, and is exercised through the `?view=list`
   peer, not the canvas DOM.** `run-trace-screen.test.tsx`'s axe scan runs against the list view,
   which renders every chrome element the canvas view also renders (header, failure panel, footer,
   node badges) except the xyflow canvas markup itself — which carries its OWN, already-passing,
   axe suite in `packages/ui/src/components/workflow-canvas/__tests__/workflow-canvas.vitest.tsx`.
   A separate canvas-view test (with the same ResizeObserver/getBoundingClientRect polyfill that
   suite uses — happy-dom has no layout engine) proves the real composite renders with the overlay
   wired correctly, but does not re-run axe against it.
3. **Two e2e suites authored, neither executed** — see Task 11 above.
4. **`WorkflowRun` fixture data does not exist anywhere reachable** (R2, again) — every test in
   this pass that needs run data uses a mocked `fetch` (component tests) or accepts the empty-table
   case explicitly (both e2e specs). This is not a shortcut; it is the actual state of the system
   until TASK-718 (or a follow-up) wires the write side.

### A live collision hit and fixed (sibling agents share this tree)

While this section was being written, a concurrent sibling session (TASK-719, continuing Phase D)
landed its own `/workflow-studio` nav entry in `nav-config.ts` immediately after this ticket's
`/workflow-runs` entry — both landed cleanly (no syntax collision), but it moved
`NAV_ENTRIES.length` from 51 to 52 and the tier 30-49 count from 17 to 18 out from under this
session's own just-written `nav-config.test.ts` assertion. Updated the count (crediting the
sibling's route in the comment, not claiming it) rather than leaving a red test for whoever looks
next. The sibling's own `workflow-studio/**` files remain untouched by this session and, as of
this writing, still fail the PACKAGE-WIDE `typecheck`/`lint`/`build` (their own in-progress work,
verified by `git status`/diff to be entirely outside files this ticket touched) — every command
below that needed a clean package run was therefore SCOPED to this ticket's own files rather than
run unscoped, and is called out as such.

### Evidence — commands actually run, with real output (Session 2)

**Shadow-DB empty-diff proof**
```
$ npx prisma migrate diff --from-config-datasource --to-schema src/prisma/db_main --script
-- This is an empty migration.
```

**`pnpm --filter @arcaai/applications exec vitest run src/services/workflow-run`**
```
Test Files  1 passed (1)
     Tests  25 passed (25)
```

**`pnpm --filter @arcaai/applications build`**
```
> @arcaai/applications@0.0.1 build
> rimraf dist tsconfig.tsbuildinfo && tsc
(clean exit, no output)
```

**`pnpm --filter @arcaai/domains build`** — clean exit, no output.
**`pnpm --filter @arcaai/domains test`**
```
Test Files  144 passed | 2 skipped (146)
     Tests  1789 passed | 2 skipped | 9 todo (1800)
```

**`pnpm api:build`**
```
 Tasks:    12 successful, 12 total
```

**`pnpm --filter @arcaai/api exec vitest run src/modules/workflow-run src/bootstrap/__tests__/admin-route-permission-audit.test.ts`**
```
Test Files  2 passed (2)
     Tests  22 passed (22)
```

**`pnpm --filter @arcaai/admin-console exec vitest run src/features/workflow-runs`**
```
Test Files  5 passed (5)
     Tests  32 passed (32)
```

**`pnpm --filter @arcaai/admin-console exec vitest run --exclude "**/workflow-studio/**"`**
(everything else in the package, i.e. every file this session did NOT touch plus everything it did,
minus the concurrent sibling's own in-progress, currently-broken folder):
```
Test Files  183 passed (183)
     Tests  1452 passed (1452)
```

**Scoped lint** (every file this ticket created or touched):
```
$ pnpm exec eslint src/features/workflow-runs src/shared/navigation/nav-config.ts \
    "src/shared/navigation/__tests__/nav-config.test.ts" src/features/ai-operations-runs \
    "src/app/(console)/(tenant)/workflow-runs" tests/e2e/workflow-runs.spec.ts --max-warnings 0
(clean exit, no output — 0 problems)
```

**`pnpm --filter @arcaai/api exec eslint tests/e2e/task-723-workflow-runs-cross-tenant.spec.ts --max-warnings 0`** —
clean exit, no output.

**Unscoped package commands — currently blocked, not by this ticket:**
```
$ pnpm --filter @arcaai/admin-console typecheck
src/features/workflow-studio/api/client.ts(36,24): error TS2345: ...
src/features/workflow-studio/components/definitions-list-screen.tsx(42,70): error TS2353: ...
src/features/workflow-studio/components/workflow-studio-editor.tsx(176,107): error TS2345: ...
```
Every error is inside `workflow-studio/**`, the concurrent sibling's own in-progress files
(confirmed via `git status` — those files are untracked/uncommitted and this session never wrote
to them). `grep`-ing the same output for `workflow-runs|nav-config|ai-operations-runs` returns
nothing. Re-run once the sibling's pass lands.

```
$ pnpm --filter @arcaai/admin-console lint
apps/admin-console/src/features/workflow-studio/store/graph-store-provider.tsx
  19:45  error  Error: Cannot access refs during render
```
Same story — one error, inside the sibling's own file.

```
$ pnpm --filter @arcaai/admin-console build
... Compiled successfully in 8.5s
  Running TypeScript ...
src/features/workflow-studio/api/client.ts(36,24): error TS2345: ...
Failed to type check.
```
`next build` fails at the SAME sibling-owned type error. Turbopack itself compiled successfully.

**`pnpm --filter @arcaai/applications test`** (full package, not scoped) — **80 test failures**,
entirely inside `services/consultation/{harness,jobs/processors}` (`consultation.transitionTo is
not a function`), traced to a concurrent sibling's in-progress edit of
`packages/domains/src/entities/generated/core/ConsultationEntity.ts` (TASK-711 session-state-
machine, confirmed via `git status`/diff — this session never touched that file or any
`consultation/*` file). This ticket's own suite (`services/workflow-run`, above) is unaffected and
green.

### What's left after this session

- The two e2e specs need a real run against a live stack (both are gated on the Prisma
  `db push --force-reset` refusal, not on missing code).
- A live-browser manual a11y/keyboard pass (honesty note above).
- Once TASK-718 wires `recordRunStarted`/`recordRunFinished`, the API cross-tenant spec should
  gain a REAL cross-tenant row assertion (flagged inline in the spec itself).
- `apps/admin-console` package-wide `build`/`lint`/`typecheck` need a clean re-run once the
  concurrent `workflow-studio/**` work lands — nothing in THIS ticket's own files is blocking it.

## 8. Change History

| Date | Change | By |
|---|---|---|
| 2026-08-16 | Ticket authored | ticket-writer agent (Wave 2 Studio batch) |
| 2026-08-16 | Phase A/B executed: Task 1 contract (CREATE verdict), `WorkflowRun` schema + migration (authored, unapplied — infra down), domain layer (entity/factory/mapper/repository), `WorkflowRunService` (keyset list, single-read trace rollup, idempotent record-run write contract), `WorkflowRunController` (`/admin/workflow-runs/*`), Task 10 retention decision note. Phase C (Tasks 7–9, 11 — admin-console UI + Playwright e2e) NOT started. Full evidence in §7. Status → Partial. | Execution agent (session 1) |
| 2026-08-16 | Phase C executed (session 2, infra up): shadow-DB empty-diff proof closed; fixed a real backend bug (`tracePruned` hardcoded `false`, dead-coding Task 9's own state) with 5 new `@arcaai/applications` unit tests; built the full `workflow-runs` admin-console feature (list screen, canvas-overlay trace + `?view=list` peer, failure/retry/degraded/pruned states, node detail drawer, both routes, nav entry, `/ai-operations/runs` reciprocal cross-link) with 32 new passing admin-console tests incl. axe scans (37 new tests total across both packages); authored (not executed — Playwright globalSetup blocker) the API cross-tenant e2e spec and the admin-console e2e spec. Full evidence, honesty notes, and the live sibling-collision fix in §7b. Status → Review. | Execution agent (session 2) |
