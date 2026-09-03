# TASK-856 — Workflow Cloning (create a new workflow from an existing one, or from a platform template)

| | |
|---|---|
| **Status** | Review — implemented, all gates green, NOT merged |
| **Type** | feature |
| **Branch** | `task-workflow-cloning` (worktree `../hope-v2-cloning`), based on `dev-2.2` @ `80988d35a` |
| **Ticket number** | `TASK-856` — highest number present in `docs/implementation/` is `TASK-855`; a repo-wide `git grep -oE 'TASK-(85[6-9]\|8[6-9][0-9]\|9[0-9][0-9])' -- docs` returns nothing, so 856 is free. `docs/archive/` could not be listed (off-limits this sprint, and read permission is denied in this session) — archived tickets are strictly older/lower-numbered, so this does not put 856 at risk |
| **Layers touched** | `packages/domains` (repository read lane) → `packages/applications` (service + DTOs) → `apps/api` (2 routes) → `apps/admin-console` (Studio clone dialog) |
| **Migration** | **None.** See §3.0 |

---

## 1. Requirement Analysis

Owner's words:

> "tenant admin can manage workflows, including authoring them (composing nodes into a graph,
> the visual studio with the node palette), **even creating new by cloning workflows that
> already exist as templates**".

The authoring half already ships. **Cloning does not exist at all** — verified, see §2.

A *clone* is a **NEW workflow**: a new `(tenantId, slug)` lineage, `versionNumber` 1, `DRAFT`,
seeded from an existing definition's `graph`. It is categorically **not** a new *version*
(`create` with `parentVersionId`, which stays inside the SAME slug). Conflating the two is the
central hazard this ticket guards against: cloning into an existing slug would silently mint
version N+1 of a workflow the author did not intend to touch — and if that workflow is published
and live, the "clone" would land in the lineage that serves production traffic.

### Acceptance criteria

| # | Criterion |
|---|---|
| AC-1 | A tenant admin can clone any of **their own** definitions into a new slug, any status |
| AC-2 | A tenant admin can clone a **SYSTEM platform template** (PUBLISHED) into their own tenant |
| AC-3 | Cloning **another customer tenant's** id is indistinguishable from a miss — `404`, never `403` |
| AC-4 | The clone lands `DRAFT`, `isActive: false`, `versionNumber: 1`, with **no** copied compile artifacts |
| AC-5 | A slug already used by the caller tenant is refused `409` — never silently a new version |
| AC-6 | Cloning consumes the `maxWorkflowDefinitions` quota exactly as `create` does |
| AC-7 | The Studio offers cloning from the definitions list **and** exposes the platform template library |

---

## 2. Current State Evaluation

Verified against the tree at `80988d35a`.

| Fact | Evidence |
|---|---|
| No clone path exists anywhere in the workflow substrate | `git grep -niE "clone\|duplicate\|fromTemplate"` over `apps/api/src/modules/workflow-definition/`, `packages/applications/src/services/workflow-definition/` and `*.prisma` returns only unrelated prose |
| Authoring is ability-gated, **not** super-admin-gated | `workflow-definition.controller.ts` — class-level `@CanManage('WorkflowDefinition')`; `seed/01-policy.ts:285` grants `tenant-full-access` `manage:WorkflowDefinition` scoped to `${context.tenantId}`; there is no `isSuperAdmin` call in `workflow-definition.service.ts` |
| "New version" is not cloning | `workflow-studio-editor.tsx:177` `handleCreateNewVersion` re-POSTs the graph with `parentVersionId` — same slug, same lineage |
| A new workflow always starts EMPTY | `create-definition-form.tsx:34` always posts `graph: { version: 1, nodes: [], edges: [] }` |
| `create()` mints `max(versionNumber)+1` for the slug inside a transaction | `workflow-definition.service.ts:257-281` — so a create against an existing slug is a **new version**, not an error |
| `WorkflowDefinition` is **deliberately NOT** a SYSTEM-shared-read model | `packages/database/src/extensions/tenant-scope.ts:281-287` — "Deliberately NOT added to SYSTEM_SHARED_READ_MODELS … the SYSTEM-tenant platform-default rows reach a tenant via the **clone path**, not shared read" |
| …and the clone path it names **was never built** | `seed/21-workflow-definition.ts` creates exactly one SYSTEM row and clones nothing; `tenant.service.ts` provisions models, pipelines, departments and configs — **no** workflow provisioning |
| A brand-new tenant therefore owns **zero** workflow definitions | `tenant.service.ts:411-424` (TASK-815): golden-agent provisioning was deleted because "a new tenant **authors that binding in the Workflow Studio** rather than inheriting eighteen rows" |
| Reading a SYSTEM row through the extended client is impossible | `tenant-scope.ts:771-783` `mergeTenantIntoWhere` **throws** on any `tenantId` other than the caller's, for every model outside `SYSTEM_SHARED_READ_MODELS` |
| The sanctioned way to read SYSTEM-owned, non-shared-read rows is the unscoped `baseClient` with an explicit tenant pin | `tenant.service.ts:447-452` `provisionTenantDepartmentCatalog` — same shape, same justification |
| `Repository` reads (`findFirst`/`findAll`/`count`) accept **no** `tx`; only writes do | `packages/domains/src/common/repository.ts:109-141` vs `:50,171,208` |
| Clone-route precedent already exists in this repo | `roles.controller.ts:186` `POST :id/clone` + `role.service.ts:492` — clone is `@CanCreate`, the copy belongs to the **caller's** tenant, source may be SYSTEM |
| `ConflictException` (409) is the house duplicate-key response | `ITenantAllowedOriginService.ts:61` |

**Consequence.** Own-tenant-only cloning would be an empty feature on day one for every new
tenant: they have nothing to clone. The SYSTEM template library is the thing that makes
"clone a template" real — and the tenant-scope extension's own comment says the clone path is
how those rows are *supposed* to reach a tenant.

---

## 3. Decisions

### 3.0 No Prisma migration

The feature needs no new column. `graph`, `slug`, `status`, `versionNumber` and `parentVersionId`
already express everything a clone is. An `isTemplate` flag was considered and **rejected**: the
platform library is already identifiable as "SYSTEM-tenant + PUBLISHED", and a boolean whose
value is derivable from two existing columns is a second source of truth plus an `ALTER TABLE`
for nothing. Provenance of the clone is recorded on the `ResourceCreated` sys-event (audited),
not on a new column.

### D-1 — What is clonable

**The caller tenant's own definitions (any status), plus the SYSTEM tenant's PUBLISHED,
ENABLED definitions. Nothing else, ever.**

- *Own tenant, any status* — forking your own draft to try a variant is the ordinary case, and
  a DRAFT is not a secret from its own author.
- *SYSTEM, PUBLISHED only* — this is the platform template library. Restricted to PUBLISHED
  because a SYSTEM DRAFT is unreleased platform work: a tenant seeing it would be reading the
  platform's workbench. `resourceStatus: ENABLED` excludes soft-deleted rows.
- *Another customer tenant* — **impossible by construction.** The source lookup is `tenantId IN
  [caller, SYSTEM]` and nothing widens it; a foreign id falls out as `NotFoundException` (404),
  the house 404-over-403 posture.

The SYSTEM read does **not** widen `SYSTEM_SHARED_READ_MODELS`. Adding `WorkflowDefinition`
there would reverse a recorded decision and leak SYSTEM rows into every tenant's `list()` —
where `getById` would then 404 them (`assertEqualTenants`), i.e. a list showing rows it cannot
open. Instead the read is a single, explicitly tenant-pinned repository method taking the
unscoped client, exactly as `provisionTenantDepartmentCatalog` does.

### D-2 — Copied vs reset

| Field | Clone | Why |
|---|---|---|
| `graph` | **copied verbatim** | It is the authored artifact. Silently rewriting a clinical workflow's node config is a worse failure than a visible one |
| `graphChecksum` | **recomputed** | Same bytes → same value, but derived, never trusted from the source row |
| `name` | caller-supplied (defaults to `"<source name> (copy)"`) | |
| `description`, `paletteKey` | copied | `paletteKey` is re-validated against the node registry (`assertKnownPaletteKey`), exactly as `create` does. Deliberately NOT entitlement-checked here: `assertPaletteEntitled` is publish-time-only by its own contract, and `create` does not call it either — a clone the tenant may not publish is refused at publish, where every other unentitled draft is |
| `validationReport`, `validatedAt` | **recomputed** by running `validate()` on the copied graph | A report produced under another tenant's config or an older node registry is a stale claim about a graph that now lives somewhere else |
| `compiledConfig`, `compiledConfigChecksum`, `registryChecksum` | **null** | Never copied. The interpreter's input contract is produced server-side at publish; carrying one over would hand a DRAFT a compile artifact it did not earn |
| `status` | **`DRAFT`** | A clone has been reviewed by nobody |
| `isActive` | **`false`** | Activation is a publish-time decision about a slug's live pointer |
| `versionNumber` | `1` (minted `max+1`, and the slug is proven free) | New lineage |
| `parentVersionId` | **`null`** | It means "branched within this slug" and `create()` enforces `parent.slug === dto.slug`. A clone is a different slug, so a cross-slug parent is structurally wrong, not merely unused |
| `publishedAt`, `deprecatedAt`, `needsReview` | reset (factory defaults) | |
| `tags` | **`[]`** | The SYSTEM template carries `['platform-default','summarization']`; copying that onto a tenant row asserts something false |

**Node-level bindings — the leak check.** A graph node can carry `promptTemplateId` /
`promptVersionNumber` (`node-prompt-binding.ts:36-37`) and `documentTemplateId` /
`documentVersionNumber` (`workflow-definition.service.ts:100-101`). Neither `PromptTemplate` nor
`DocumentTemplate` is in `SYSTEM_SHARED_READ_MODELS`, and both reach a tenant as **per-tenant
clones with different ids** (`seed/07-prompt-template.ts:822`). So:

- **Own-tenant source** — every id in the graph is already the caller's; the tenant authored it.
  Nothing to check.
- **SYSTEM source** — a copied `promptTemplateId` would point at a SYSTEM row the destination
  tenant *cannot read*. That is a dangling reference the tenant can neither resolve nor repair
  from the Studio.

  We **refuse** it: cloning a SYSTEM template whose graph carries `promptTemplateId` or
  `documentTemplateId` is a `400` naming the offending nodes. Chosen over the alternatives
  because stripping the binding silently mutates a clinical graph, and copying it verbatim ships
  a broken reference that only surfaces later, further from the person who could fix it. It
  never fires on the shipped platform default (its generation node binds by `taskKey`, resolved
  through the tenant→SYSTEM cascade — `seed/21-workflow-definition.ts:113`), so the guard costs
  nothing today and closes the class before a bound SYSTEM template ever ships.

### D-3 — Slug collision

**The caller supplies `targetSlug`; a slug already present for the tenant is `409 Conflict`.**

Not derived (`<slug>_copy`, `_copy_2`) because the slug is the workflow's **public address** —
`POST /api/v1/workflows/:slug/invoke` (TASK-722). A machine-invented public identifier is a
naming decision that belongs to the tenant, and `create` already demands an explicit slug;
deriving one here would be a second, inconsistent convention. The Studio's clone dialog pre-fills
`<source>_copy` client-side, so the ergonomics are unchanged.

The check is **mandatory, not cosmetic**: without it a clone into an existing slug becomes
version N+1 of that lineage (§2), which is precisely the outcome a clone must not produce. The
existence check spans **all** statuses and soft-deleted rows — the `(tenantId, slug,
versionNumber)` unique index does, so a "free" slug that isn't would surface as a raw DB error.

### D-4 — Quota

**Cloning runs the identical `maxWorkflowDefinitions` precheck as `create`** — kill-switch-gated
`isEnforcementEnabled()`, then `assertQuantityQuota(tenantId, 'maxWorkflowDefinitions', count)`
→ `QuotaExceededException` (409). A clone writes a row; a create path that skips the quota is a
quota bypass with extra steps.

---

## 4. Implementation Plan

Layer order per `01-development-workflow.md`.

| # | Layer | Change |
|---|---|---|
| 1 | `packages/domains` | `WorkflowDefinitionRepository.findCloneSource(id, tenantId, client)` and `.findSystemTemplates(client)` — explicit `tenantId IN [caller, SYSTEM]` / `tenantId = SYSTEM` pins, taking the client as a parameter (the `findMaxVersionNumber(…, tx)` shape) |
| 2 | `packages/applications` | `CloneWorkflowDefinitionRequest` DTO; `WorkflowDefinitionResponse`-returning `clone(sourceId, dto)` on the service + interface; `listTemplates()`; barrels |
| 3 | `apps/api` | `POST admin/workflow-definitions/:id/clone`, `GET admin/workflow-definitions/templates` — **declared before `@Get(':id')`** or `:id` swallows `templates` |
| 4 | `apps/admin-console` | `cloneWorkflowDefinition` / `listWorkflowTemplates` client fns, hooks, query keys, and a `CloneDefinitionDialog` reachable from the definitions list (row action + a "Start from a template" affordance) |
| 5 | artifacts | Routes changed ⇒ regenerate **all five**: `api:build`, `api:route-manifest`, `api:openapi`, `api:portal`, `vox-node gen:admin` |

### TDD test list (RED first, each for the right reason)

Applications (`workflow-definition.service.clone.task856.test.ts`):

| # | Test |
|---|---|
| T-1 | clones an own-tenant source into a new slug: `DRAFT`, `versionNumber` 1, `isActive` false, graph copied, `ResourceCreated` broadcast carrying the source id |
| T-2 | drops the source's compile artifacts — `compiledConfig` / `compiledConfigChecksum` / `registryChecksum` null, `publishedAt` null, `tags` empty |
| T-3 | clones a SYSTEM PUBLISHED template into the caller tenant (source read via the SYSTEM lane; new row's `tenantId` is the caller's) |
| T-4 | a foreign tenant's id → `NotFoundException` (404-over-403), nothing written |
| T-5 | a target slug already in use → `ConflictException`, nothing written |
| T-6 | the `maxWorkflowDefinitions` quota is enforced when enforcement is on, and skipped when off |
| T-7 | a SYSTEM template whose graph carries `promptTemplateId` → `BadRequestException` naming the node; the same graph from an own-tenant source clones fine |
| T-8 | a source graph that fails the shape/engine gate → `BadRequestException`, nothing written |
| T-9 | `listTemplates()` returns only SYSTEM PUBLISHED rows |

API (`workflow-definition.controller.test.ts` additions): the two routes delegate to the service
and are covered by the generated authz matrix once the manifest is regenerated.

Admin console (`__tests__/clone-definition-dialog.test.tsx`): pre-fills `<source>_copy`,
validates the slug pattern client-side, surfaces the gateway error, and calls the mutation with
the entered values.

### Verification criteria

`pnpm --filter @arcaai/applications test` · `pnpm test:unit` ·
`pnpm --filter @arcaai/admin-console build lint test` · the five artifact `:check` gates.

---

## 5. Implementation Summary

Delivered in the house layer order. No Prisma migration, no schema change, no seed change.

### Files changed

| File | Change |
|---|---|
| `packages/domains/src/repositories/generated/core/WorkflowDefinitionRepository.ts` | `findCloneSource(id, tenantId, client)` — `tenantId IN [caller, SYSTEM]`, SYSTEM narrowed to the existing `PUBLISHED_AND_ACTIVE` predicate; `findSystemTemplates(client)` — the library list, same predicate. Both take the UNSCOPED client explicitly (the `findMaxVersionNumber(…, tx)` shape) |
| `packages/applications/src/services/workflow-definition/dto/clone-workflow-definition.request.ts` | **new** — `targetSlug` (required, `WORKFLOW_NODE_ID_PATTERN`), `name?`, `description?`. `@ApiProperty`/`@ApiPropertyOptional` on every field. No `graph`, no `paletteKey`, no `tenantId` |
| `…/dto/index.ts` | barrel |
| `…/IWorkflowDefinitionService.ts` | `clone()` + `listTemplates()` on the interface, with the throw contract |
| `…/workflow-definition.service.ts` | `clone()`, `listTemplates()`, `assertNoUnresolvableCatalogBindings()` |
| `apps/api/src/modules/workflow-definition/workflow-definition.controller.ts` | `GET templates` (declared **above** `GET :id`) and `POST :id/clone` |
| `apps/admin-console/src/features/workflow-studio/components/clone-definition-dialog.tsx` | **new** — presentational dialog, both entry modes |
| `…/components/definitions-list-screen.tsx` | per-row **Clone** action, header **Start from template**, and an empty-state that now leads with the template path |
| `…/components/index.ts`, `…/api/{types,keys,client,hooks}.ts` | client fn, query key leaf, `useCloneWorkflowDefinition`, `useWorkflowTemplates(enabled)` |
| `apps/api/route-manifest.json`, `apps/api/openapi.json`, `apps/admin-console/src/server/api-docs/openapi.{admin,business}.json`, `packages/vox-node/src/resources/admin/**` | regenerated (routes changed) |

### Tests added

| File | Cases |
|---|---|
| `packages/applications/…/__tests__/workflow-definition.clone.task856.test.ts` | 12 — T-1…T-9 plus the name default, the event provenance, and the own-tenant half of the binding guard |
| `apps/api/…/__tests__/workflow-definition.controller.test.ts` | +4 — route metadata for both routes, the `templates`-before-`:id` **declaration-order** assertion, and delegation |
| `apps/admin-console/…/__tests__/clone-definition-dialog.test.tsx` | 9 — pre-fill, submit, client-side slug refusal, server-error surfacing, template picker, skeleton loading, empty library, axe |

### Notes for the next reader

- **Route declaration order is load-bearing.** `@Get('templates')` sits above `@Get(':id')`; a
  test asserts the prototype ordering, because nothing else can catch a reorder.
- **The slug check is fused with the version mint**, inside the transaction. That is not a style
  choice: `create`'s `max + 1` is exactly what would silently turn a clone into version N+1.
- The SYSTEM binding guard (`assertNoUnresolvableCatalogBindings`) is inert against today's data
  — the shipped platform default binds by `taskKey`, not by row id. It exists so the failure
  class is closed before a bound SYSTEM template ever ships.
- **Not run here:** `pnpm test:e2e` (needs a live gateway on :8968 plus seeded infra). The two new
  routes are covered automatically by `task-776-route-authz-matrix.spec.ts` via the regenerated
  manifest; that sweep still needs one live run before merge.

### Evidence

| Gate | Result |
|---|---|
| RED — applications | `12 failed (12)` · every failure `TypeError: service.clone is not a function` / `service.listTemplates is not a function` |
| GREEN — applications (file) | `Test Files 1 passed (1)` · `Tests 12 passed (12)` |
| RED — api controller | `Tests 4 failed \| 14 passed (18)` · `controller.clone is not a function`, `controller.fetchTemplates is not a function` (HEAD controller restored to prove it) |
| GREEN — api controller | `Tests 18 passed (18)` |
| RED — admin console | `Failed to resolve import "../clone-definition-dialog"` |
| GREEN — admin console (file) | `Tests 9 passed (9)` |
| `pnpm --filter @arcaai/applications test` | `Test Files 645 passed \| 1 skipped (646)` · `Tests 10967 passed \| 4 skipped (10971)` — baseline 10955, +12 |
| `pnpm --filter @arcaai/domains test` | `Test Files 158 passed \| 2 skipped (160)` · `Tests 1881 passed \| 2 skipped \| 9 todo (1892)` |
| `pnpm test:unit` | exit 0 · `Test Files 1338 passed \| 2 skipped (1340)` · `Tests 22668 passed \| 4 skipped \| 9 todo (22681)` |
| `pnpm --filter @arcaai/admin-console build` | `Tasks: 10 successful, 10 total` |
| `pnpm --filter @arcaai/admin-console lint` | clean (`--max-warnings 0`) |
| `pnpm --filter @arcaai/admin-console test` | `Test Files 262 passed (262)` · `Tests 2314 passed (2314)` |
| lint — applications / domains / api | `0 errors` each (186 / 14 / 65 pre-existing warnings, none in a file this ticket touched) |
| `pnpm api:openapi:check` | OK — every served route documented or deliberately excluded; quality ratchet not regressed |
| `pnpm api:portal:check` | `no drift (admin 635 ops, business 188 ops)` |
| `pnpm --filter @arcaai/vox-node gen:admin:check` | `no drift (52 areas, 413 routes, 377 schemas)` |

One lint finding was fixed rather than suppressed: the dialog originally re-seeded its fields in
a `useEffect`, which `react-hooks/set-state-in-effect` rejects. It now adjusts state during
render against a seed key — React's documented pattern for this, and one render instead of two.

---

## 6. Change History

| Date | Change |
|---|---|
| 2026-09-02 | Ticket opened. Current state verified against `80988d35a`; decisions D-1…D-4 + §3.0 recorded before any code was written |
| 2026-09-03 | Implemented across domains → applications → api → admin-console, TDD. D-2 corrected during implementation: the clone re-validates `paletteKey` against the node registry but does NOT entitlement-check it, because `assertPaletteEntitled` is publish-time-only by its own contract and `create` does not call it either — the plan had over-specified this |
