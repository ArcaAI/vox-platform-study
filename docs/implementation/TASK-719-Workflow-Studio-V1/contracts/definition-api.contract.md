# Definition API contract (TASK-719 Task 3 — re-derived 2026-08-16, TASK-734 pass)

**Supersedes the original 2026-08-16 (commit `718533453`) version of this file** — that version
predates TASK-734 ("workflow substrate second pass"), which delivered the controller/service
this file assumed did not exist. Re-derived against `feat/loop` HEAD `3c6505a68`. Original text
kept at the bottom for history.

## Verdict: DELIVERED — controller, service, and DTOs are real

| Concern | file:line |
|---|---|
| Controller | `apps/api/src/modules/workflow-definition/workflow-definition.controller.ts` — `@Controller('admin/workflow-definitions')` (global prefix ⇒ `/api/v1/admin/workflow-definitions`), class-level `@CanManage('WorkflowDefinition')` |
| Service | `packages/applications/src/services/workflow-definition/workflow-definition.service.ts` (411 lines) — `WorkflowDefinitionService implements IWorkflowDefinitionService` |
| Module registration | `apps/api/src/modules/workflow-definition/workflow-definition.module.ts`, `packages/applications/src/services/workflow-definition/workflow-definition.service.module.ts` |
| Domain quartet | `packages/domains/src/{entities,factories,mappers,repositories}/generated/core/WorkflowDefinition*.ts` — hand-authored per rule 03 |
| Table | `packages/database/src/prisma/db_main/workflow-definition.prisma` (unchanged from the prior pass — Phase A was already done) |

## The real route table (verified against the controller, not assumed)

| Operation | Route | OCC? | Notes |
|---|---|---|---|
| Create draft | `POST admin/workflow-definitions` | no (new row) | Body: `CreateWorkflowDefinitionRequest`. 201; 400 on shape-broken graph; 409 on `maxWorkflowDefinitions` quota |
| List | `GET admin/workflow-definitions` | no | `PaginatedQuery` (`page`, `limit`) → `PaginatedWorkflowDefinitionResponse` — caller-tenant scoped only |
| Read one | `GET admin/workflow-definitions/:id` | no | 404 (cross-tenant or missing, indistinguishable) |
| List versions | `GET admin/workflow-definitions/:id/versions` | no | Every row in the `(tenantId, slug)` lineage, most recent first; 404 same as above |
| Autosave / edit | `PATCH admin/workflow-definitions/:id` | **yes** — `@RequiresIfMatch()` + `@ExpectedVersion()` | 428 missing `If-Match`, 412 on drift, 400 if row is PUBLISHED/DEPRECATED or the replaced `graph` fails shape/engine validation. Header overrides body `expectedVersion` (controller `:96-104`) |
| Delete | `DELETE admin/workflow-definitions/:id` | no | Soft delete |
| Validate | `POST admin/workflow-definitions/:id/validate` | **no** — confirmed NOT `@RequiresIfMatch()` | Re-runs shape+engine+DRAFT-rule-catalogue validation, persists `validationReport`, advances DRAFT→VALIDATED iff the engine gate is clean. DRAFT rule-catalogue findings never block this. 400 if row is PUBLISHED/DEPRECATED |
| Publish | `POST admin/workflow-definitions/:id/publish` | **no** — confirmed NOT a CAS | Body: `PublishWorkflowDefinitionRequest { activate?: boolean }` (default `true`). 400 if the engine gate is not clean (cycle / unregistered node type / malformed shape) — the SOLE publish-blocking predicate; DRAFT rule-catalogue findings never block publish |
| Registry | `GET admin/workflow-nodes` | no | See `registry.contract.md` — separate controller, `@CanRead`, not `@CanManage` |

**This table is no longer an assumption.** Every row is read directly off
`workflow-definition.controller.ts` (Task 10's client must be re-pointed at this table, not the
prior session's mirrored-from-`consultation-context-schema` guess — the guess turned out
correct on paths, but the OCC posture of `validate`/`publish` and the request/response bodies
below were not previously verifiable and are now pinned).

## Why `validate` and `publish` carry no `If-Match` (confirmed from the service, not inferred)

- `validate()` (`workflow-definition.service.ts:256-285`) calls
  `workflowDefinitionRepository.updateWithVersion(id, entity, entity.version)` — it CASes
  against the version it JUST read inside the same request, not a client-supplied one. A
  concurrent editor's autosave between the client's last read and this validate call can still
  land; the controller doc comment (`workflow-definition.controller.ts:24-27`) states this is
  deliberate: "validate is idempotent re-computation (not a CAS: it can run any number of
  times)". The Studio does not need to send `If-Match` for Validate, and must not synthesize one.
- `publish()` (`:287-324`) calls plain `.update(id, entity)` — no version check at all. Comment
  at `:314-315`: "Publish is not a CAS… an unrelated concurrent metadata edit must not 412 the
  publish." The Studio's publish button therefore sends only the request body
  (`{ activate?: boolean }`), no `If-Match`, no `expectedVersion`.

This is a real behavioral divergence from the ticket's own Task 15 approach text, which says
"Publish re-validates server-side" (true) but implicitly groups publish with the autosave OCC
discipline (not true). Task 15's autosave/publish hook must branch: PATCH goes through
`patchWithEtag` + `OccConflictAlert`; `validate`/`publish` are plain `postJson` calls with no
ETag handling — attempting `If-Match` on either would be a client bug, not a safety net.

## Request/response DTOs (verified fields — supersedes the prior "assumed" table)

`CreateWorkflowDefinitionRequest` (`create-workflow-definition.request.ts`): `slug` (matches
`WORKFLOW_NODE_ID_PATTERN`, `/^[a-z0-9_]{2,48}$/`), `name` (≤160), `description?` (≤2000),
**`paletteKey` (required — the ticket's own Task 3 approach text did not name this field; it is
mandatory on create)**, `graph` (`Record<string, unknown>`, the `WorkflowGraph` shape — see
below), `parentVersionId?`.

`UpdateWorkflowDefinitionRequest` (`update-workflow-definition.request.ts`): `name?`,
`description?`, `graph?` (replaces + re-validates the whole graph — no partial-graph patch
exists), `expectedVersion?` (only consulted when `If-Match` is absent — the header wins per
controller `:101-102`). **No `paletteKey` on update** — it is set once at create and never
edited (confirmed: absent from this DTO's field list).

`WorkflowDefinitionResponse` (`workflow-definition.response.ts`) — the full row, 22 fields:
`id`, `tenantId`, `slug`, `name`, `description`, `paletteKey`, `versionNumber`,
`parentVersionId`, `status` (`'DRAFT'|'VALIDATED'|'PUBLISHED'|'DEPRECATED'`), `graph`,
`graphChecksum`, `compiledConfig` (null until PUBLISHED), `compiledConfigChecksum`,
`registryChecksum`, `validationReport`, **`needsReview: boolean`** ("true when a published row
is out of sync with the running node registry (checksum drift)" — a field the original contract
draft did not anticipate at all; the Studio's definitions-list screen (Task 16) should surface
it, e.g. a badge, since it means a PUBLISHED row may no longer match the live node registry),
`validatedAt`, `publishedAt`, `deprecatedAt`, `isActive`, `resourceStatus`, `createdAt`,
`updatedAt`, `version` (the OCC counter — this is what `versionFromEtag` reads off the `ETag`
the `ETagInterceptor` derives), `tags`.

## Graph JsonB shape — the "no `position` field" gap is CLOSED (2026-08-20)

`WorkflowGraphNode` (`packages/workflow-contract/src/graph-model.ts`) now carries `position?: {
x: number; y: number }` as a first-class, optional sibling of `config` — a real, own-purpose
type (`WorkflowNodePosition`), not a nested-in-`config` workaround. `workflowGraphProblems`
validates it when present (must be a plain object with finite numeric `x`/`y`); absent stays
valid (a graph authored before this field existed, or built entirely through the list/tree
editor, carries none). The Studio's serializer (`lib/graph-serialization.ts`) writes it there
directly and reads it back the same way; it still reads the legacy `config.__position` nesting
as a FALLBACK for a graph already saved under the old scheme, but never writes that shape again.
`apps/admin-console/src/features/workflow-runs/lib/graph-layout.ts` (the read-only run-trace
canvas) was updated the same way: `node.position` first, the legacy key as fallback, then the
deterministic layered layout.

This also fixes a real, previously-live defect the old fallback carried: `compileNode`/
`compileGate` (`compiler.ts`) copy `node.config` verbatim into `CompiledNode.config`, so nesting
layout under `config.__position` meant every compile leaked Studio's own canvas-layout
bookkeeping into the interpreter's input contract (`compiledConfig`) — harmless in practice
(the interpreter ignores unknown config keys) but a real coupling violation. `position` living
outside `config` closes that path entirely; `CompiledNode.config` never sees it.

## Consequence for Studio v1's build order (updated)

Task 10 (API client) is now written against the REAL route table above. It CAN be exercised
against a live gateway (controller + service are real); it was NOT exercised in THIS session —
local infra was not brought up as part of this pass, and no route/screen exists yet to drive it
end-to-end (Phase D was the scope of this pass). The Playwright e2e suite (Task 21) remains
gated on the app being served at :5176 and the gateway at :8868 simultaneously, per the
program's known blocker on `prisma db push --force-reset` inside Playwright's `globalSetup`.

---

## Superseded original text (2026-08-16, commit `718533453`) — history only

<details>
<summary>Original "NOT YET DELIVERED" verdict, kept for the record</summary>

At that commit `find apps/api/src -iname "*workflow*"` returned only an unrelated harness DTO,
and no `WorkflowDefinitionService`/controller/module existed. The route table in that version
was an assumption mirrored from `consultation-context-schema.controller.ts`, explicitly marked
unverified. All of that is now stale — see the verdict above. (For the record: the mirrored
path guesses for list/read/versions/create/publish/registry all turned out correct; the OCC
posture of validate/publish, the mandatory `paletteKey` on create, and the `needsReview` field
could not have been guessed and are new information from this pass.)

</details>
