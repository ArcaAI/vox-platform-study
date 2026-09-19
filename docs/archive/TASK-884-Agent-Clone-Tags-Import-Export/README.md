# TASK-884 — Agent capabilities: clone, key:value tags with tag-based selection, and agent import/export

| | |
|---|---|
| **Status** | Review |
| **Type** | feature |
| **Programme** | TASK-870 configuration governance, wave 3b, lane F |
| **Branch** | `task-884-agent-clone-tags-import-export` (worktree `../hope-v2-task-884`) |
| **Base** | `3227be8d6` (`dev-2.2` with waves 1–3a and the residue lane merged) |
| **Owner decisions implemented** | #2 (clone), #4 (import/export/sync), #6 (key:value tags replace the retired visit-type condition) |

---

## Requirement Analysis

Three owner decisions, one subject. Restated as what the platform must be able to do:

| Owner decision | What it asks for | What it forbids |
|---|---|---|
| **#2 — clone** | An agent can be cloned from a SYSTEM template *or from any existing agent visible to the tenant* | — |
| **#6 — tags** | Tenant admins align agents by **`key:value` tags**; developers branch inside workflows | **No tenant-managed conditions** (department, visit type). TASK-882 retired the `(task, visitType) → prompt` binding and left a named seam |
| **#4 — import/export** | Tenant admins import/export agents as JSON; an admin managing several tenants promotes/syncs among **their own** tenants; the platform admin builds in Global and promotes into SYSTEM; **only** the platform admin manages SYSTEM | — |

Two posture rules cut across all three (rules 04 / 05 / 09):

- A **cross-tenant id is 404** (404-over-403). A **privilege failure on SYSTEM is 403** — SYSTEM's existence is not a secret, since every tenant reads its templates through the shared-read cascade, so a 404 there would conceal nothing and mislead the caller about *why* the push failed.
- **Funding derives from the row that supplied a credential.** An agent carries no credential at all (the model row decides the engine, the tenant's `AiProviderConnection` decides the key), so nothing here can copy one — which is also what makes an exported bundle safe to hand to a person.

### The one idea underneath all four verbs

Clone, export, import and sync are one mechanism seen from four angles: *take an agent version that exists somewhere and land a **DRAFT** of it somewhere else, copying **values** and re-resolving or **refusing** every reference.* That is the `AgentPromotionService` discipline, applied to an agent.

| | Source | Target | Crosses a tenant boundary? |
|---|---|---|---|
| `clone` | a SYSTEM template, or any agent visible to the tenant | the caller's tenant (a SUPER_ADMIN may name another) | only for that super-admin case |
| `exportBySlug` | the same | a JSON file | potentially — so the bundle carries no id, no tenant and no credential |
| `importBundle` | a JSON file | the caller's tenant | yes — every reference is re-resolved against what the **caller** can see |
| `syncToTenants` | the caller's **own** agent | other tenants the caller manages | yes |

---

## Current State Evaluation

| Piece | Before this ticket |
|---|---|
| `Agent.tags String[] @default([])` | Existed since TASK-863. **Nothing read it**, nothing validated it, and the seeded rows carried a bare vocabulary (`stt`, `llm`, `transcription`) |
| `AgentAssignment` | One row per `(tenantId, scope, scopeId, task)` — the unique key made a second row at a tier impossible |
| `AgentService` | create / update / validate / publish / **newVersion** / deprecate. `newVersion` already branches a SYSTEM template into a new tenant lineage — a partial clone with no provenance record, no slug freedom and no reference re-resolution |
| `AgentPromotionService` | Promotes **WorkflowDefinition** versions between tenants under an elevated tenant-less context. Its copy discipline is the model this ticket follows; its table is not reused (see *Decisions*) |
| `PromptResolutionService.resolve` | Carried the TASK-882 seam comment where the retired `(task, visitType) → prompt` tier used to sit |
| Console `features/agents` | List + `DetailDrawer`; the only assignment UI was a single "Set as tenant default" button that assigned the open agent's own slug |

---

## Implementation Plan (executed)

1. **Contract** — the portable-bundle envelope + the `key:value` tag grammar in `@arcaai/workflow-contract` (zero runtime deps, so pure predicates only).
2. **Schema + domain** — `Agent` lineage columns, `AgentAssignment.selectorKey` + its uniqueness key, hand-authored entity/factory edits, `gen:model` for the model layer, repository reads.
3. **Applications** — tag validation on the write DTOs; clone/export/import/sync on `AgentService`; the selector-aware cascade; the `PromptResolutionService` seam.
4. **API** — four routes on `AgentAdminController`, two carrying an `AUTH-NOTE`.
5. **Seed** — the platform's own agent tags converted to `key:value`.
6. **Console** — tag column + facet, import action, export button, assignment tag selector.

---

## Implementation Summary

### Deliverable 1 — Clone (owner #2)

`POST /api/v1/admin/agents/:slug/clone` → `AgentService.clone`. The source resolves as "the caller's own lineage (any status — a draft is clonable), else a SYSTEM template (PUBLISHED only, since a SYSTEM draft is unreleased platform work — the line `newVersion` already draws)". Anything else is 404.

- Reusing the source slug in the same tenant is a 400: that would be a new *version*, which `POST :id/versions` already is.
- A **same-tenant** clone keeps every binding **including the eval gate** — the golden set is still that tenant's, so stripping it would be a loss with no reason behind it.
- A **cross-tenant** clone (SUPER_ADMIN only, `tenantId` in the body) re-resolves the model **by slug** in the target and refuses a tenant-owned prompt template or MCP binding with a named 409.
- Provenance is recorded on the created row (see the SQL below). `parentVersionId` stays **null**: it means "the previous version of *this* lineage", and a clone starts a different one.

### Deliverable 2 — Tags (owner #6)

- **Grammar** (`AGENT_TAG_PATTERN`, `agentTagProblems`): lower-case `key:value`, one colon, key 1–32 / value 1–64 chars, at most 24 tags, no duplicates. A **bare key is refused** and the message shows the pair it should have been. Reads are not re-validated, so rows written before the grammar stay listable — they simply cannot be *selected*, which is the honest outcome.
- **Selector on the assignment**: `AgentAssignment.selectorKey` is the canonical (de-duplicated, sorted, comma-joined) selector, `''` = unqualified, and it is **part of the uniqueness key** — so a tier holds the unqualified row plus one row per selector, and a tag-qualified write can never overwrite the unqualified one.
- **Cascade**: tier order is untouched (department → tenant → SYSTEM). *Within* a tier, rows whose selector is a **subset** of the request's tags are candidates, most specific first, unqualified last. A request carrying **no** tags therefore sees exactly the one unqualified row each tier always had — behaviour is byte-identical for every existing caller.
- **`PromptResolutionService`**: the TASK-882 seam is filled by a tag-selected agent tier above all three capability chains. It is deliberately **not** the shape of the tier it replaced: no condition table and no axis of its own — the tags select an *agent* through the ordinary cascade, and the prompt is whatever that agent's instruction already binds. It engages only when the request carried tags **and** a tag-qualified assignment matched, and the selected agent's template must be APPROVED (the same governance every other tier answers to). Any failure degrades to the ordinary chain rather than taking out a clinical generation call.

### Deliverable 3 — Import / export (owner #4)

`packages/workflow-contract/src/portable-bundle.ts` is generic over `kind` (`agent` | `workflow`) so lane G reuses the envelope: `kind`, `schemaVersion`, `exportedAt`, `source { tenantKind, slug, version }`, `payload`. A bundle **newer** than the importer is refused outright, never partially applied.

What the agent payload does with each reference:

| On the row | In the bundle | On import |
|---|---|---|
| `modelId` | `modelSlug` | re-resolved against the importer's visible catalogue; unresolvable ⇒ 409 `MODEL_NOT_RESOLVABLE` naming every failing slug |
| `fallbackModelIds[]` | `fallbackModelSlugs[]` | same, in order |
| `instruction.promptTemplateId` | `promptTemplateRef` — `{kind:'system', id, name}` or `{kind:'tenant', name}` | a SYSTEM id is genuinely portable and keeps its **version pin**; a tenant template is re-resolved **by name** and the pin is dropped (lineages are per-tenant); unresolvable ⇒ 409 `PROMPT_TEMPLATE_NOT_RESOLVABLE` |
| `instruction.evalGate` | **stripped**, with a note | the target binds its own |
| `tools[].mcpServerId` | carried verbatim | must be an ENABLED server visible to the importer; else 409 `MCP_SERVER_NOT_RESOLVABLE` |
| every server-owned column | **absent** — and a hand-edited payload carrying one is refused | an import always lands a DRAFT |

`source.tenantKind` is a **kind, not a tenant id**. The server derives only `'system'` and `'tenant'`: deriving `'global'` would mean naming `50000000-…` in a runtime path, which is exactly the smell rule 00 exists to catch. The enum value stays for a client that already knows it is the playground.

### Deliverable 4 — Sync among own tenants (owner #4)

`POST /admin/agents/:slug/sync`. The source must be the caller's **own** agent (a SYSTEM template is already visible everywhere → 404). Authorization is `PolicyEngine.buildAbility({userId, tenantId: target})` requiring `manage:Agent`, checked for **every** target *before* anything is read or written.

- A customer tenant the caller does not manage → **404**.
- SYSTEM, when the caller does not manage it → **403** naming the rule.
- Only SYSTEM-owned prompt-template and MCP bindings cross the boundary; a tenant-owned one is a named 409 *before* any write.
- Every target commits in **one** transaction: "half the tenants got it" is a state no operator can reason about, and per-target commits would make a mid-sequence 409 permanent for the tenants already written.
- The Global → SYSTEM promotion path is untouched — `POST /admin/agent-promotions` still owns it, and this route does not duplicate it.

### Deliverable 5 — Route documentation

All four routes carry `@ApiTags('admin-agents')` (already in `apps/api/src/openapi/tags.ts` — no taxonomy change needed), a summary, a description and at least one 4xx. No `@ApiExclude*`. No new API-key or service-account scope: the controller's existing class-level `@ForbidApiKey()` + `@RequiredSvcScopes('svc:admin:agent:manage')` cover them.

---

## Intended SQL (migration NOT authored — see *Handoffs*)

The Prisma schema is committed; no folder was created under `packages/database/src/prisma/db_main/migrations/`. Author it on a shadow database per rule 02, named `task_884_agent_clone_lineage_and_assignment_selector`.

```sql
-- 1. Cross-lineage provenance for a CLONE / SYNC / IMPORT. Data, not relations: a cross-tenant
--    FK would put a navigable path from one tenant's row into another's. Not indexed — nothing
--    queries BY them; they are read back on the row that carries them.
ALTER TABLE "core"."Agent"
  ADD COLUMN "sourceAgentId"       TEXT,
  ADD COLUMN "sourceTenantId"      TEXT,
  ADD COLUMN "sourceSlug"          TEXT,
  ADD COLUMN "sourceVersionNumber" INTEGER;

-- 2. The tag selector, and the uniqueness key that lets a tier hold one row per selector.
ALTER TABLE "core"."AgentAssignment"       ADD COLUMN "selectorKey" TEXT NOT NULL DEFAULT '';
ALTER TABLE "core"."AgentAssignmentChange" ADD COLUMN "selectorKey" TEXT NOT NULL DEFAULT '';

DROP INDEX "core"."AgentAssignment_scope_task_unique";
CREATE UNIQUE INDEX "AgentAssignment_scope_task_selector_unique"
  ON "core"."AgentAssignment" ("tenantId", "scope", "scopeId", "task", "selectorKey");
```

Notes for whoever applies it:

- Every existing `AgentAssignment` row gets `selectorKey = ''`, which is exactly the unqualified assignment the cascade already served — **no data migration is needed and no behaviour changes on apply**.
- The replaced index has the same NULL-`scopeId` quirk as the original (Postgres treats NULLs as distinct, so TENANT-scope rows were never really constrained by it). That is pre-existing and deliberately **not** fixed here.
- `AgentAssignmentChange` is WORM at the DB layer via a `BEFORE UPDATE OR DELETE` trigger; `ADD COLUMN` is DDL and is unaffected by it.
- `packages/database/src/prisma/db_main/agent.prisma` already carries two objects that `migrate diff` reports as permanent drift (the `agent_immutability_guard` trigger and the partial unique index `Agent_tenant_slug_active_unique`); that is pre-existing and documented in the file header.

---

## Verification criteria → evidence

### Per deliverable

| # | Route / behaviour | Where | Test that proves it | Owner rule it enforces |
|---|---|---|---|---|
| 1 | `POST admin/agents/:slug/clone` | `apps/api/src/modules/agent-admin/agent-admin.controller.ts:220` | `agent-admin.controller.test.ts` "addresses clone / export / sync by the lineage SLUG" | #2 |
| 1 | Clone from a SYSTEM template, DRAFT, full provenance | `packages/applications/src/services/agent/agent.service.ts:461` | `agent.portability.task884.test.ts` "clones a SYSTEM template into the caller tenant as a DRAFT" | #2 |
| 1 | Foreign source slug → **404** | `agent.service.ts:703` (`resolveVisibleSource`) | "404s on a source the tenant cannot see" | 404-over-403 |
| 1 | Cross-tenant clone → **403** for a tenant admin | `agent.service.ts:468` | "403s when a tenant admin tries to clone into another tenant" | only the platform admin crosses tenants |
| 1 | Model re-resolved by slug in the target, else 409 | `agent.service.ts:926` (`resolveModelIdForTarget`) | "lets a SUPER_ADMIN clone into another tenant, re-resolving the model by SLUG" + "refuses with MODEL_NOT_RESOLVABLE" | values, never dangling references |
| 1 | Eval gate survives a same-tenant clone | `agent.service.ts:852` (`writeCopy`) | "keeps the eval gate on a SAME-TENANT clone" | PHI pointers never leave a tenant — and never leave *within* one |
| 2 | `key:value` grammar; bare key refused | `packages/workflow-contract/src/agent-schemas.ts:802,824` | `agent-tags.task884.test.ts` "REFUSES a bare key, and says what the pair should look like" | #6 |
| 2 | Tags validated on create / update / clone / import | `agent.service.ts:690` (`assertTagGrammar`) | "replaces the tags when asked, and REFUSES a bare key"; "refuses a bundle whose tags are not `key:value`" | #6 |
| 2 | Tag-qualified assignment matched **before** the unqualified one | `agent-assignment.service.ts:55,99` | `agent-assignment.service.test.ts` "a tag-qualified assignment is matched BEFORE the unqualified one at the same scope" | #6 |
| 2 | Untagged request unchanged | same | "a request with NO tags resolves exactly what it always did" | no regression on the existing cascade |
| 2 | Tier order still outranks the selector | same | "the TIER order still outranks the selector" | tenant → department → SYSTEM (rule 09) |
| 2 | Selector is part of the row's identity | `agent-assignment.service.ts:262` (`canonicalSelector`) | "addresses the row by (tier, SELECTOR): a qualified write never overwrites the unqualified assignment" | #6 |
| 2 | `PromptResolutionService` seam | `prompt-resolution.service.ts:593,663` | `prompt-resolution.agent-tags.task884.test.ts` (8 cases) | #6 — replaces the visit-type condition, adds no new one |
| 3 | Bundle envelope | `packages/workflow-contract/src/portable-bundle.ts:100,159` | `portable-bundle.task884.test.ts` (8 cases incl. "never carries a tenant id — only a tenant KIND") | #4 |
| 3 | `GET admin/agents/:slug/export` — values only, models by slug | `agent-admin.controller.ts:202`; `agent.service.ts:504` | "emits a values-only bundle: the model by SLUG, no ids, no tenant id, no credential" | #4; credentials never exported |
| 3 | Eval gate stripped on export, with a note | `agent-bundle.ts` `instructionForExport` | "STRIPS the eval gate and says so, and carries a SYSTEM template by id but a tenant one by NAME" | PHI pointer never leaves the tenant |
| 3 | `POST admin/agents/import` — resolve or refuse | `agent-admin.controller.ts:177`; `agent.service.ts:555` | "names the model slugs this tenant cannot see"; the three 409 cases | #4 |
| 3 | Import lands a DRAFT with the lineage half of the provenance | `agent.service.ts:616` | "creates a DRAFT in the caller tenant and records the LINEAGE half" | a copy never becomes a live agent silently |
| 4 | `POST admin/agents/:slug/sync` | `agent-admin.controller.ts:250`; `agent.service.ts:634` | "lands one DRAFT per target, each carrying the full provenance" | #4 |
| 4 | Unmanaged target → **404**, and nothing written | `agent.service.ts:828` (`assertManagesAgentsIn`) | "404s — never 403 — for a target the caller does not manage, and writes NOTHING" | 404-over-403 |
| 4 | SYSTEM target without the right → **403** | same | "403s — not 404s — when the target is SYSTEM" | only the platform admin manages SYSTEM |
| 4 | Non-portable bindings refused before any write | `agent.service.ts:795` (`assertPortableAcrossTenants`) | "refuses a tenant-owned prompt template with a NAMED 409"; "refuses a non-SYSTEM MCP tool binding" | references are re-resolved or refused |
| 4 | Unwired `PolicyEngine` fails closed | `agent.service.ts:828` | "fails CLOSED when the authorization engine is unwired" | never write cross-tenant on an unanswered question |
| 5 | Tag / summary / description / 4xx on all four routes | `agent-admin.controller.ts:177-277` | `api:openapi:check` (orchestrator handoff) | rule 05 §Documentation Surface |
| 5 | `AUTH-NOTE` on the two routes whose gate is imperative | `agent-admin.controller.ts:232,263` | `agent-admin.controller.test.ts` "carries the AUTH-NOTE marker on the two routes" | rule 05 §Imperative Privilege Checks |
| console | Tag column + AND-joined facet filter | `apps/admin-console/src/features/agents/components/agents-screen.tsx` | `agents-portability.task884.test.tsx` (3 tag cases) | #6 |
| console | Import on the list | same | "POSTs the parsed file to admin/agents/import"; "never reaches the gateway when the file is not JSON" | #4 |
| console | Export on the detail | `apps/admin-console/src/features/agents/components/agent-detail.tsx` | "GETs the bundle for the OPEN VERSION" | #4 |
| console | Tag selector in the assignment editor | same | "sends the parsed selectorTags"; "omits selectorTags entirely when the box is empty" | #6 |

### Gate output (actual)

```
$ pnpm --filter @arcaai/workflow-contract test
 Test Files  38 passed (38)
      Tests  1548 passed (1548)
$ pnpm --filter @arcaai/workflow-contract build         -> DTS ⚡️ Build success

$ pnpm --filter @arcaai/database test
 Test Files  2 failed | 76 passed (78)
      Tests  8 failed | 1725 passed (1733)      # the 8 pre-existing failures, unchanged
$ pnpm gen:model:check    -> check: no drift — 181 generated file(s) match the committed files.
$ pnpm gen:entity:check   -> no drift — 102 file(s); Schema coverage OK: 100 entity artifact(s) cover every persisted column of 104 Prisma model(s)
$ pnpm gen:factory:check  -> no drift — 102 file(s); Schema coverage OK

$ pnpm --filter @arcaai/domains build   -> tsc, clean
$ pnpm --filter @arcaai/domains test
 Test Files  156 passed | 2 skipped (158)
      Tests  1892 passed | 2 skipped | 9 todo (1903)

$ pnpm --filter @arcaai/applications build  -> tsc, clean
$ pnpm --filter @arcaai/applications test
 Test Files  657 passed | 1 skipped (658)
      Tests  11594 passed | 4 skipped (11598)
$ pnpm --filter @arcaai/applications lint   -> 229 problems (0 errors, 229 warnings)

$ pnpm --filter @arcaai/api typecheck  -> tsc --noEmit, clean
$ pnpm --filter @arcaai/api test
 Test Files  277 passed | 2 skipped (279)
      Tests  4177 passed | 4 skipped (4181)
$ pnpm --filter @arcaai/api lint       -> 70 problems (5 errors, 65 warnings)
                                          # the 5 errors are the pre-existing e2e-spec ones

$ pnpm --filter @arcaai/admin-console build lint test
 build: ✓ Compiled successfully
 lint:  clean (--max-warnings 0)
 test:  Test Files 257 passed (257) / Tests 2273 passed (2273)
```

**Count reconciliation** (base → this branch):

| Suite | Base | Now | Delta |
|---|---|---|---|
| workflow-contract | 36 files / 1531 | 38 / 1548 | +2 files (`portable-bundle.task884`, `agent-tags.task884`), +17 tests |
| domains | 156 / 1892 | 156 / 1892 | unchanged — entity edits are covered by the reconciler + coverage check |
| applications | 655 / 11542 (654 pass + 1 fail file; 11538 pass + 4 fail) | 657 / 11594 | +2 files (`agent.portability.task884` 35, `prompt-resolution.agent-tags.task884` 8), +52 tests — the balance is the 6 tag cases added to the rewritten `agent-assignment.service.test.ts` and the 3 wiring/AUTH-NOTE cases elsewhere |
| api | 277 / 4172 | 277 / 4177 | +5 tests in the existing `agent-admin.controller.test.ts` |
| admin-console | 256 / 2265 | 257 / 2273 | +1 file (`agents-portability.task884`), +8 tests |
| database | 8 failed / 1725 passed | 8 failed / 1725 passed | unchanged — the seed tag change pins nothing |

`@arcaai/vox` was not touched (no SDK call was added), so its suite was not run.

---

## Decisions worth recording

1. **`AgentPromotion` rows are NOT written for a sync.** Its `list()`/`getById()` are the workflow-promotion feed and compute *workflow* drift; agent rows there would make that list wrong. The audit trail a sync leaves is the immutable provenance columns on each created row plus a `ResourceCreated` sys-event carrying both tenant ids — which is what `AuditLog` persists. Reversing this is a small change if the owner wants one feed.
2. **A tenant-owned prompt template / MCP server does not cross a tenant boundary** — it is refused, not deep-copied. `AgentPromotionService` deep-copies prompt templates because a *workflow* binds several and dropping them would gut the graph; an agent binds at most one, the target's own admin binds it deliberately, and a second deep-copy pipeline is a second governance surface. Export/import is the path for that case.
3. **`selectorKey` is a derived scalar, not a `String[]`.** Prisma cannot put a list field in `@@unique`, and the selector must be in the uniqueness key for a tier to hold one row per selector.
4. **The prompt-resolution tier engages only on a NON-EMPTY matched selector.** A match on the tier's unqualified row is the tier's ordinary default, which the chains below already serve; engaging there would change resolution for tagged requests that meant nothing by it.
5. **The server never derives `source.tenantKind === 'global'`** — that would mean naming `50000000-…` in a runtime path (rule 00).

---

## Handoffs

| # | To | What |
|---|---|---|
| H-1 | **Orchestrator — artifact regeneration** | Four new routes ⇒ regenerate and commit **all five** artifacts: `pnpm api:build && pnpm api:route-manifest && pnpm api:openapi && pnpm api:portal && pnpm --filter @arcaai/vox-node gen:admin`, then `api:openapi:check` / `api:portal:check` / `gen:admin:check`. Not run here (artifact generators are out of lane scope). The `admin-agents` tag already exists; no `tags.ts` change |
| H-2 | **Orchestrator — migration** | The SQL above is authored but **not** applied and **no migration folder was created**. Author it on a shadow database per rule 02 (`task_884_agent_clone_lineage_and_assignment_selector`), prove the empty diff, then `pnpm db:push` the dev DB. Until then the e2e suite will fail against an unmigrated database |
| H-3 | **Orchestrator — e2e** | The depth cases are proven at the SERVICE (35 cases in `agent.portability.task884.test.ts`), which is where the decisions are made and which this lane can actually run. No e2e spec file was added, so nothing unrunnable was committed. If a wire-level spec is wanted, the three cases to cover are: a foreign source slug → 404 on clone/export; `tenantId` in a clone body from a tenant admin → 403; a sync target the caller does not manage → 404 while a SYSTEM target → 403. The route-authz matrix covers the four routes automatically once H-1 regenerates the manifest |
| H-4 | **Lane G (TASK-885)** | `packages/workflow-contract/src/portable-bundle.ts` is generic over `kind` and already declares `'workflow'`. Reuse `portableBundleProblems` / `buildPortableBundle` verbatim; the payload shape and its problems belong to that kind's owner (`agent-bundle.ts` is the exemplar) |
| H-5 | **Owner** | A console affordance for `clone` was **not** added (deliverable 1 named no console requirement, and the existing "Branch as my agent" button covers the SYSTEM-template case through `newVersion`). If a first-class Clone button is wanted, `useCloneAgent` is already wired |
| H-6 | **Owner / lane G** | Cloning or exporting a **SYSTEM template** cannot read its fallback chain: `AgentModelFallback` is plain tenant-scoped (not shared-read), so a tenant sees none. This is pre-existing — `newVersion` has had it since TASK-863 — and the fix is either adding the model to `SYSTEM_SHARED_READ_MODELS` or reading the chain through an elevated path. Not changed here because it widens a tenant-scope allow-list |

---

## Change History

| Date | Change |
|---|---|
| 2026-09-06 | Contract layer: `portable-bundle.ts` (generic envelope, refuses a newer `schemaVersion` outright) and the `key:value` agent tag grammar in `agent-schemas.ts`. `35f5cb086` |
| 2026-09-06 | Schema + domain: four `Agent` provenance columns, `AgentAssignment.selectorKey` + the widened uniqueness key, `AgentAssignmentChange.selectorKey`, `findAllForScope` / `findForScopeSelector`. `gen:model` run; entity/factory hand-authored and reconciled. `c06f4a122` |
| 2026-09-06 | Applications: clone / export / import / sync on `AgentService`; the selector-aware cascade; the `PromptResolutionService` tag-selected tier at the TASK-882 seam. `ebc4080a5` |
| 2026-09-06 | API: the four portability routes, two carrying an `AUTH-NOTE`. `f553a43fe` |
| 2026-09-06 | Console: tag column + facet, import action, export button, assignment tag selector; seeded agent tags converted to `key:value`. `6e69dfd23` |
| 2026-09-06 | A SYSTEM sync target answers **403**, not 404 — its existence is not a secret, so a 404 would conceal nothing and mislead. |
