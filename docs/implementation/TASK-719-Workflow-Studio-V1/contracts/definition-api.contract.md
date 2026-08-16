# Definition API contract (TASK-719 Task 3)

Re-derived against the live tree on `feat/loop` at commit `718533453` (2026-08-16).

## Verdict: NOT YET DELIVERED — no controller, no application service

`find apps/api/src -iname "*workflow*"` returns only
`apps/api/src/modules/harness-admin/dto/workflow-action.request.ts` (an unrelated harness
action DTO — string content confirms it is about harness run actions, not `WorkflowDefinition`
CRUD). `find packages/applications/src -iname "*workflow*"` returns nothing. There is no
`WorkflowDefinitionService`, no `IWorkflowDefinitionService` token, no
`WorkflowDefinitionController`, no module registration in
`packages/domains/src/common/databaseServices/core/core.database.module.ts` for a
`WorkflowDefinitionRepository` (grep for "Workflow" in that file: no hit). TASK-715's header
table states the same fact directly: "Phase A — Database — done; Phases B–F not started."

## What IS delivered — the persistence floor (TASK-715 Phase A)

| Concern | file:line | Note |
|---|---|---|
| Table + columns | `packages/database/src/prisma/db_main/workflow-definition.prisma:44-116` | `WorkflowDefinition` model, standard field template |
| Lifecycle enum | `packages/domains/src/enums/generated/WorkflowDefinitionStatus.ts` | Generated from the Prisma enum |
| Generated model layer | `packages/domains/src/models/generated/core/WorkflowDefinitionModel.ts` | The one auto-generated layer (`gen:model`); entity/factory/mapper/repository are hand-authored per rule 03 and **do not exist yet** |
| OCC column | `workflow-definition.prisma:47` | `version Int @default(1) @map("_version")` — standard `_version` OCC counter exists on the table, so **when** the service/controller land, the console-wide `If-Match`/`versionFromEtag` pattern (`shared/api/http.ts`) applies unchanged |
| Graph column | `workflow-definition.prisma:66-69` | `graph Json @db.JsonB` + `graphChecksum String` — verbatim as authored, never executed directly (file header comment, `workflow-definition.prisma:6-9`) |
| Compiled config | `workflow-definition.prisma:72-79` | `compiledConfig Json?`, `compiledConfigChecksum String?`, `registryChecksum String?` — null until `PUBLISHED`, server-stamped, "never accepted from a request DTO — enforced by DTO whitelist, not by this column" (comment at `:75-76`) |
| Validation report column | `workflow-definition.prisma:81-82` | `validationReport Json?`, `needsReview Boolean @default(false)` — the persisted counterpart of `WorkflowValidationReport` (see `validation-report.contract.md`) |
| Active pointer | `workflow-definition.prisma:87-91` | `isActive Boolean @default(false)` — "the version the dispatcher resolves for new runs" |
| Lineage | `workflow-definition.prisma:59-64` | `slug`, `versionNumber`, `parentVersionId String?` (no `@relation` — lineage reads walk the column directly, per the file header) |
| Immutability posture | `workflow-definition.prisma:29-40` (file header) | PUBLISHED/DEPRECATED rows are **hard-immutable**, enforced by a service guard (`assertMutable`, not yet built) + DTO whitelist + checksum drift-detection — **deliberately no DB trigger**. This is a service-layer guarantee, so it does not exist as an executable invariant today |

## The path shape this ticket's client is written against (a plan, not a delivered route)

TASK-715 README §2.10 names the *route shape to copy* — the closest existing analogue,
`apps/api/src/modules/consultation-context-schema/consultation-context-schema.controller.ts`,
which is real, delivered code for a **different** resource:

```
:36  @Controller('admin/consultation-context-schemas')
:44  @Get()            :51 @Get(':id')        :60 @Get(':id/versions')
:72  @Post()           :84 @Patch(':id') + :85 @RequiresIfMatch() + :102 @ExpectedVersion()
:110 @Post(':id/publish')                     :128 @Post(':id/pin')
```

No equivalent `admin/workflow-definitions` controller exists. Studio v1's Task 10 API client
(`apps/admin-console/src/features/workflow-studio/api/client.ts`) is written against the
**mirrored** path shape below, by direct analogy to the delivered
`consultation-context-schema` controller, and is marked in that file's own header comment as
unverified against a real server:

| Operation | Assumed path | OCC? | Mirrors |
|---|---|---|---|
| List | `GET admin/workflow-definitions` | no | `consultation-context-schema.controller.ts:44` |
| Read one | `GET admin/workflow-definitions/:id` | no | `:51` |
| List versions | `GET admin/workflow-definitions/:id/versions` | no | `:60` |
| Create draft | `POST admin/workflow-definitions` | no (new row) | `:72` |
| Autosave | `PATCH admin/workflow-definitions/:id` | **yes** — `If-Match` + `expectedVersion` | `:84-102` |
| Validate | `POST admin/workflow-definitions/:id/validate` | no (side-effect-free re-check; persists `validationReport` server-side per README §3.1 "Publish re-validates server-side… persists the report") | New — no existing analogue names a bare "validate" verb; `consultation-context-schema` only has publish |
| Publish | `POST admin/workflow-definitions/:id/publish` | no (status transition, not a compare-and-set on the head row — the `consultation-context-schema` publish exemplar's own comment, §2.3 of TASK-715's README, "publishing is not a compare-and-set on the head row") | `:110` |
| Registry | `GET admin/workflow-nodes` | no | `settings-catalog.controller.ts:24,31` (`GET admin/settings/catalog` precedent) |

**Every row in this table is an assumption pending TASK-715 Phases B–D**, not a verified
contract. Task 10's client file must carry a header comment saying exactly this, and its unit
tests exercise the client against a mocked `fetch`/`http.ts`, never a live server (LOCAL
INFRA IS DOWN regardless — Postgres/API are not running in this session).

## Graph JsonB shape — a real, cited gap

The `graph` shape the delivered validator engine consumes is `WorkflowGraph`
(`packages/workflow-contract/src/graph-model.ts:26-30`):

```ts
export interface WorkflowGraph {
  version: 1;
  nodes: WorkflowGraphNode[];  // { id, type, config }
  edges: WorkflowGraphEdge[];  // { id, from, fromPort, to, toPort }
}
```

**`WorkflowGraphNode` has no `position` field.** README §2.7/Task 3 approach text describes
the graph JsonB shape as including "node ids, edges, positions, per-node `config`" — the
delivered type does not have a `position: { x: number; y: number }` (or similar) field
anywhere in `@arcaai/workflow-contract`. Two readings are possible and neither can be resolved
from delivered code alone:

1. Canvas layout position is Studio-local UI state, never round-tripped to the server (the
   compiler/validator has no use for pixel coordinates, so this would be deliberate — a
   canvas-only concern that a `WorkflowGraphNode.config` object could carry as a
   Studio-reserved key, or that the console persists client-side only, e.g. via `localStorage`
   or a query param); or
2. `WorkflowDefinition.graph` really is meant to round-trip `position` and TASK-715/716 simply
   have not added the field yet because no UI existed to populate it.

**Recorded rather than guessed** (R3): Studio v1's graph store (Task 11) keeps
`position: { x: number; y: number }` on its **client-side** node model (React Flow requires
it) and, when serializing to the definition API's `graph` field, nests it under
`config.__position` (a Studio-reserved config key, namespaced so it cannot collide with a
registered node type's own schema fields) rather than inventing a top-level `position` field
the delivered `WorkflowGraphNode` type does not have. If TASK-715/716 add a first-class
`position` field later, this is a one-line change at the serialization boundary
(`api/client.ts`), not a store redesign. This choice, and the alternative, are also carried to
README §6 as an open question for the TASK-715/716 owners.

## Consequence for Studio v1's build order

Task 10 (API client) can be written and unit-tested (mocked transport) today. It **cannot** be
exercised against a live gateway — no controller exists to call, and separately, local infra
is down in this session. Autosave/publish/validate (Task 15) are therefore build-and-unit-test
only in this session; the Playwright e2e suite (Task 21) that would prove the round trip
against a running API is gated on both TASK-715 Phases B–D landing and local infra being back
up, and is recorded as not-run rather than fabricated.
