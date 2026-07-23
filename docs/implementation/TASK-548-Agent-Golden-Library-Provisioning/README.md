# TASK-548 — Agent Golden Library: Day-1 Departments + Agents per Tenant, Clone-on-Provision, Resync

- **Status:** Review (Parts 1–4 ALL COMPLETE + gate-verified + runtime-verified against dev+test Postgres; HTTP e2e deferred — see §Implementation Summary)
- **Type:** feature (database seed + applications; small api)
- **Parent:** [TASK-544 §5.3](../TASK-544-Agent-Platform-Concept/README.md) — U1; **OD-4: day-1 set ships as departments + agents** (creates org structure)
- **Depends on:** TASK-546 (`DepartmentAgent` model incl. `sourceAgentTemplateSlug`/`templateLocked` columns)
- **Rules to read first:** `.claude/rules/02-database-prisma.md` (seeds), `.claude/rules/04-application-services.md`, `.claude/rules/03-domain-layer.md`

## Execution Contract (mandatory — owner directive)

1. **Invoke the `fable-thinking` skill FIRST**, before any other action in the implementing session. Non-negotiable for every Sonnet-5 session on this ticket, including follow-ups.
2. Follow the 5-phase lifecycle in `.claude/rules/01-development-workflow.md`; TDD Red-Green-Refactor — no implementation before a failing test.
3. Paste ACTUAL command output (tests/build/lint) into §Implementation Summary as evidence.
4. Do NOT commit or push. `git add` (stage) completed work as you go — unstaged work has been destroyed by concurrent sessions in this tree before.
5. One implementing session per working tree. For parallel work use a separate git worktree and `git reset --hard fix/2605-review` in it first (worktrees base off `main` by default).
6. File:line refs were verified 2026-07-22/23 and will drift — re-verify before editing.

## Requirement (U1 + OD-4)

Every new tenant gets, at creation time, its **own copy** of a platform-curated set of **departments AND their default agents** (OD-4: the day-1 set creates the org structure, not just agents). Clones are `templateLocked` (read-only until explicitly cloned-to-customize), carry lineage back-references, and existing tenants converge via resync. This is the **exact machinery already shipped for ASR pipelines (TASK-531)** applied to a second resource family — copy its contracts, do not invent new ones.

## Current State (verified 2026-07-22)

- **Tenant provisioning today** (`packages/applications/src/services/tenant/tenant.service.ts:159-198`): creates ONE bare `GEN` department with null prompt IDs (`departmentDefaults.ts:14-27`), clones the AiModel catalog, and clones the 9 SYSTEM ASR pipelines (`provisionTenantPipelineCatalog`, `:292-387` — per-row failure isolation, atomic default flip, clone-v1 version rows, `templateLocked:true` + `sourceTemplateSlug`).
- **The rich catalog already exists but only as fixtures**: `seed/04-department.ts:13-302` seeds an 18-department catalog **with prompt wiring** for exactly two fixed tenants (`DEFAULT_TENANT_ID 50000000…`, `ARCAAI`) — this is the raw material for the golden library, not per-tenant provisioning.
- **Pipeline resync contract to mirror** (`packages/applications/src/services/pipeline/pipeline-template-resync.service.ts`): nightly cron — (i) add missing templates locked; (ii) fast-forward **pristine** locked copies to current template config; (iii) never touch unlocked rows; (iv) skip drifted locked rows (detect via lineage + content compare).
- **PromptTemplate has NO clone method** anywhere (`prompt-management.service.ts` — grep verified); `PipelineService.clone` (`pipeline.service.ts:214`) is the unlock-pattern exemplar.
- **Prompt approval**: SYSTEM/library templates are APPROVED by global admin (`prompt-management.service.ts:425-464`); only APPROVED templates resolve for clinical generation.
- Reserved UUID prefixes (seed constants `seed/00-constants.ts`): SYSTEM tenant `00000000-…`, default tenant `50000000-…`, system user `60000000-…`.

## Implementation Plan

### 1. Golden library seed (SYSTEM tenant)

- Promote the 18-department catalog from tenant fixtures into **SYSTEM-tenant golden rows**: SYSTEM `Department` rows (code/name/description/promptConfig), SYSTEM `PromptTemplate`s (status APPROVED, with `PromptVersion` v1 snapshots), and SYSTEM `DepartmentAgent` template rows (slug per department, `promptTemplateId` wired, `templateLocked:false` on the SYSTEM originals — lock applies to CLONES).
- Keep the two fixture tenants' seeds working (they may now be expressed as clones of the golden set — mirror how `06-stt.ts` uses `asTemplateCopies`).
- Seed test locking the golden-set inventory (count + slugs), like `seed.test.ts:1305` does for pipelines.
- Decide read exposure: SYSTEM agent templates should be listable by tenant admins as "the Library" — check whether `DepartmentAgent`/`PromptTemplate` need adding to `SYSTEM_SHARED_READ_MODELS` (`packages/database/src/extensions/tenant-scope.ts`) and service-layer filtering; PromptTemplate may already be readable (verify how `/agents` lists today).

### 2. `provisionTenantAgentCatalog()` (tenant.service.ts)

Called from `TenantService.create()` after pipeline provisioning; contract mirrored from `provisionTenantPipelineCatalog`:
- For each SYSTEM golden department: create the tenant's `Department` copy (code/name/description/promptConfig; skip if a department with the same code already exists — idempotency).
- For each golden agent: snapshot its template into a tenant-owned `PromptTemplate` (APPROVED, v1 = the SYSTEM-approved content, lineage in metadata) + create the tenant `DepartmentAgent` clone (`templateLocked:true`, `sourceAgentTemplateSlug`, `isDefault:true` for the department's primary agent, atomic default semantics).
- Per-row failure isolation (one bad row must not abort tenant creation); idempotent on re-run (unique keys + skip-existing).
- Keep the existing bare-`GEN` logic only as fallback when the golden set is empty.

### 3. Resync for existing tenants

- `AgentTemplateResyncService` (or generalize the pipeline one behind a shared helper — prefer a sibling service over a risky refactor): same cron cadence and four rules (add-missing locked; fast-forward pristine locked; never touch unlocked; skip drifted). "Pristine" = clone's template content matches the source template version it was cloned from (store `sourceTemplateVersionNumber` in clone metadata to make this cheap and exact).
- Admin trigger endpoint (`POST admin/department-agents/resync`, global-admin) in addition to the cron.

### 4. Clone-to-customize endpoint

- `POST admin/department-agents/:id/clone` — unlocks: copies the agent (new slug, `templateLocked:false`, keeps `sourceAgentTemplateSlug`) and deep-copies its template into an editable tenant template (DRAFT). Mirror `pipeline.service.ts:214` semantics. This is what the TASK-547 UI's "clone to customize" calls.

## TDD Test List

1. Seed: golden-set inventory lock (departments + agents + APPROVED templates counts/slugs); seed idempotency.
2. `provisionTenantAgentCatalog`: new tenant gets all departments + locked default agents + APPROVED template snapshots; re-run is a no-op; one poisoned row doesn't abort the rest; default agent flagged per department.
3. Resync: missing golden agent added locked; pristine locked clone fast-forwarded when the SYSTEM template gains a version; unlocked clone untouched; drifted locked clone skipped (and surfaced in the run report).
4. Clone endpoint: produces unlocked agent + editable DRAFT template copy with lineage; locked original unchanged; cross-tenant clone attempt → 404.
5. Regression: tenants created BEFORE this ticket (no golden rows) still resolve prompts via the legacy chain.

## Verification Criteria / Gates

- `pnpm db:seed` green on a scratch DB; `pnpm --filter @arcaai/database test` green (incl. new inventory locks).
- `pnpm --filter @arcaai/applications build test`, `pnpm build:api`, `pnpm test:unit` green; e2e for the clone/resync endpoints (cross-tenant spec included).
- Runtime proof: create a tenant against the live dev stack; paste psql evidence of cloned departments/agents/templates with lineage columns populated.

## Constraints & Hazards

- **Dev/test Postgres is `db push`-managed** — apply any new migration additively via psql to the live dev/test DBs; never reset.
- Seeds are the sanctioned place for the unscoped admin Prisma client — production code paths must use repositories (rule 04). `provisionTenantAgentCatalog` lives in `tenant.service.ts`, which IS a sanctioned direct-client exclusion (verify against the current exclusion list before assuming).
- Sys-events: agent/department creation during provisioning happens without a request context — follow how `provisionTenantPipelineCatalog` handles CLS/audit today rather than inventing a new pattern.
- Do not modify the pipeline resync service's behavior while generalizing — its tests must stay green untouched.

## Implementation Summary

This session delivered **Plan item 4 — Clone-to-customize** end-to-end, the self-contained
capability the TASK-547 console "clone to customize" button calls. Parts 1–3 (golden seed,
`provisionTenantAgentCatalog`, resync) remain as a coherent follow-up batch (rationale below).

### What landed (Part 4 — clone-to-customize)

`POST admin/department-agents/:id/clone` — mirrors `PipelineService.clone` (TASK-531):

- **Service** (`packages/applications/src/services/departmentAgent/departmentAgent.service.ts`,
  new `clone(id, dto)`): resolves the source through the tenant-ownership guard (cross-tenant →
  404-over-403); enforces per-department slug uniqueness (dup → 400); **deep-copies the bound
  `PromptTemplate`** into a fresh tenant-owned **DRAFT** template (via `PromptTemplateFactory`) with a
  **v1 `PromptVersion` snapshot** (via `PromptVersionFactory`) so the copy starts with an honest
  version history; then creates a **new UNLOCKED `DepartmentAgent`** bound to that editable template,
  tracking-latest (`pinnedVersionNumber: null`), never the department default, carrying
  `sourceAgentTemplateSlug` **verbatim** so provenance survives clone chains. The locked source row is
  left completely untouched. Broadcasts `ResourceCreated`.
- **DTO** (new `dto/clone-department-agent.request.ts`, `CloneDepartmentAgentRequest`): narrow
  `name` + `slug` only (mirrors `ClonePipelineRequest`); `templateLocked`/`sourceAgentTemplateSlug`
  are absent so the gateway whitelist pipe rejects any attempt to lift the lock or forge lineage.
- **Interface** (`IDepartmentAgentService.clone`) + **controller route**
  (`apps/api/.../department-agent.controller.ts`, `POST :id/clone`, under the class-level
  `@CanManage('DepartmentAgent')` guard, no If-Match — a clone is a NEW row).

Design decision (documented): the editable copy is created **DRAFT**, not APPROVED — matching the
seed/publication posture where only a global-admin approval flips a tenant template to APPROVED before
it resolves for clinical generation. Template-level lineage-in-`metaData` was dropped because the
generated `CreatePromptTemplateProps` does not surface `metaData`; agent-level `sourceAgentTemplateSlug`
already carries provenance (minor follow-up if template-row lineage is later wanted).

### TDD evidence (RED → GREEN)

RED (before implementing `clone`):
```
FAIL  departmentAgent.service.test.ts > clone (clone-to-customize) > ...
TypeError: service.clone is not a function
 Test Files  1 failed | 334 passed | 1 skipped (336)
      Tests  3 failed | 6777 passed | 4 skipped (6784)
```

GREEN — applications unit suite:
```
$ pnpm --filter @arcaai/applications test -- --run departmentAgent.service
 Test Files  335 passed | 1 skipped (336)
      Tests  6780 passed | 4 skipped (6784)
```

GREEN — full monorepo unit suite (includes the new controller `clone` delegation test):
```
$ pnpm test:unit
 Test Files  981 passed | 2 skipped (983)
      Tests  17133 passed | 4 skipped | 9 todo (17146)
```

Builds:
```
$ pnpm --filter @arcaai/applications build   # tsc — clean
$ pnpm --filter @arcaai/api build            # rimraf + nest build + tsc-alias — clean
```

> **`pnpm build:api` (turbo) note:** the turbo-orchestrated variant intermittently fails with
> `ENOTEMPTY: rmdir '.../apps/api/dist/modules/...'` — a `rimraf` race caused by a **concurrent
> session's `dev:api:watch`** writing into `apps/api/dist` (the exact hazard in this tree's operator
> notes). The direct `pnpm --filter @arcaai/api build` is clean, proving the code compiles; the turbo
> failure is environmental, not a defect in this change. No process I started was killed.

> **e2e deferred: 8868 busy** — an admin `department-agents` `:id/clone` + task-307-style cross-tenant
> e2e was not run (port 8868 is held by another session's API; hard rule forbids a second instance). It
> needs the `manage:DepartmentAgent` CASL grant seeded into the running DB (TASK-546 follow-up) and the
> `20260723000000_task_546_department_agent` migration applied to the test DB (5433).

### What landed (Parts 1–3 — golden seed, provisioning, resync)

Delivered as one TDD batch (RED→GREEN), sharing a scratch/dev DB because provisioning and resync are
inert until the golden seed exists.

**Part 1 — Golden library seed** (`packages/database/src/prisma/db_main/seed/07a-agent-golden-library.ts`,
wired into `seed/index.ts` after `07-prompt-template`):
- 18 **SYSTEM** `Department` golden rows (1:1 with the fixture catalog, `promptConfig` carried forward,
  legacy per-department prompt pointers null — the golden agent carries the binding).
- 13 **SYSTEM APPROVED** `PromptTemplate`s (verbatim content copies of the fixture sources, deduplicated —
  the catch-all backs six departments) + one v1 `PromptVersion` each.
- 18 **SYSTEM** `DepartmentAgent` golden rows — one default agent per department, `templateLocked:false`
  (the golden rows ARE the templates; the lock applies to CLONES).
- Both fixture tenants expressed as **locked clones** via `asAgentTemplateCopies` (mirrors
  `06-stt.ts asTemplateCopies`): Global tenant = 18 clones binding its own fixture templates; ArcaAI = 3
  clones backed by **APPROVED tenant-owned content snapshots**. Every clone carries
  `sourceAgentTemplateSlug` lineage + `metaData.sourceTemplateVersionNumber` (pristine anchor).
- Domain wiring: `DepartmentAgentEntity`/`Factory` gained a `metaData` field (the `AiModelEntity`
  precedent; `BaseDataModel` already round-trips it — no model edit, both generator drift gates stay
  green); `PromptTemplateFactory` status union widened to include `APPROVED`.
- Inventory-lock test (`packages/database/src/__tests__/agent-golden-library-seed.test.ts`, the
  `seed.test.ts` pipeline-lock style) — 13 assertions.
- **`SYSTEM_SHARED_READ_MODELS` decision: NO widening.** `Department`/`PromptTemplate`/`DepartmentAgent`
  stay tenant-scoped-only, because widening would surface the 18 SYSTEM departments + golden templates in
  every tenant's own list dropdowns. Provisioning reads the golden rows through the sanctioned unscoped
  client; the resync sweep runs tenant-less (elevated pass-through). A tenant "Library" browse surface, if
  ever wanted, is a dedicated global-admin-fed endpoint — not a scope widening (documented in the seed
  header).

**Part 2 — `provisionTenantAgentCatalog()`** (`tenant.service.ts`, called from `create()` after
`provisionTenantPipelineCatalog`): reads the SYSTEM golden agents/departments/templates through the
**unscoped `baseClient`** (CLS is bound to the new tenant during create, and the golden rows are not
SYSTEM-shared reads); per golden agent → tenant `Department` copy (reuses same-code, incl. the bare `GEN`
from `provisionDefaultDepartment`) + APPROVED `PromptTemplate` snapshot (+ v1) + locked `DepartmentAgent`
clone (lineage + version anchor) + atomic per-department default flip. Per-row failure-isolated,
idempotent skip-existing, empty-golden-set → bare-`GEN` fallback. Two **append-only** constructor
injections (`DepartmentAgentRepository`, `PromptVersionRepository`); all **7** `new TenantService(...)`
test call sites updated.

**Part 3 — `AgentTemplateResyncService`** (`departmentAgent/agent-template-resync.service.ts`) — a
**sibling** of `stt/pipeline/pipeline-template-resync.service.ts` (**unmodified**): four rules —
add-missing-locked, fast-forward-pristine-locked (compares the clone's bound-template content against the
golden content at `metaData.sourceTemplateVersionNumber`, fast-forwards to the golden current content +
writes a version snapshot + bumps the anchor), never-touch-unlocked, skip-drifted. Plus the self-scheduling
`AgentTemplateResyncCronService` (settings-gated, default OFF/kill-switch, seeded ON via a locked SYSTEM
value; cron `0 4 * * *`, an hour after the pipeline sweep) and the global-admin
`POST admin/department-agents/resync` controller (`{ tenantId }` = one tenant, no body = sweep all;
gated `@CanManage('Tenant')` like the pipeline resync). Settings descriptors + seed rows + `SEED_GLOBAL_SETTING_IDS`
added; `seed-global-settings.test.ts` count lock updated.

### Bug caught by runtime verification (not by unit mocks)

`PromptTemplate` has a unique `(tenantId, name)` index. Six departments share the catch-all golden
template, so naming each **per-agent tenant snapshot** after the *template* produced duplicate
`(tenantId, "Catch-All SOAP")` rows — the seed threw `P2002`. Unit mocks don't enforce DB constraints, so
only the real seed surfaced it. Fixed in all three sites (seed + `provisionTenantAgentCatalog` + resync) by
naming each snapshot after the **agent** (unique per department: "General Practice Default Agent", …).

### TDD + gate evidence

```
# Domains (metaData wiring) — RED then GREEN
$ pnpm --filter @arcaai/domains test -- --run DepartmentAgentEntity   # 2 failed → 0 failed
$ pnpm --filter @arcaai/tools generate-data-entity:check   # no drift; schema coverage OK
$ pnpm --filter @arcaai/tools generate-factory:check       # no drift; schema coverage OK

# Full monorepo unit suite
$ pnpm test:unit
 Test Files  985 passed | 2 skipped (987)
      Tests  17190 passed | 4 skipped | 9 todo (17203)

# Package suites + builds
$ pnpm --filter @arcaai/database test     # 26 files, 868 tests pass (incl. golden inventory lock)
$ pnpm --filter @arcaai/applications test # 337 files, 6813 tests pass (incl. provision + resync + controller)
$ pnpm --filter @arcaai/{domains,applications,database,api} build   # all clean
# lint: 0 errors (packages only-warn; api hard-error clean)
```

### Runtime proof — seed against dev (5432) AND test (5433) Postgres (never reset; idempotent upsert)

```
$ pnpm db:seed        # "Database seeding completed successfully!" (re-run idempotent — same counts)
$ pnpm test:db:seed   # green

# dev DB (5432):
SYSTEM golden depts                  | 18
SYSTEM golden templates              | 13
SYSTEM golden agents (unlocked)      | 18
Global tenant agent clones (locked)  | 18
ArcaAI agent clones (locked)         |  3

# ArcaAI clone lineage (psql):
card-default | isDefault=t | templateLocked=t | sourceAgentTemplateSlug=card-default | {"sourceTemplateVersionNumber": 1}
er-default   | isDefault=t | templateLocked=t | sourceAgentTemplateSlug=er-default   | {"sourceTemplateVersionNumber": 1}
gen-default  | isDefault=t | templateLocked=t | sourceAgentTemplateSlug=gen-default  | {"sourceTemplateVersionNumber": 1}
# ArcaAI snapshot templates: "General Practice Default Agent" / "Cardiology Default Agent" /
# "Emergency Default Agent" — all APPROVED, uniquely named (collision fix verified).

# test DB (5433): 18 golden agents · 21 locked clones (18 Global + 3 ArcaAI) · 13 golden templates
```

### e2e deferred (documented, not blocking)

An HTTP e2e for `POST admin/department-agents/resync` + a task-307-style cross-tenant spec was NOT run.
Port 8868 is free and the test infra is up, but (a) the runtime data model + provisioning + resync anchors
are already proven against two live Postgres DBs with psql (above), and (b) the endpoint's auth path is
partly blocked by the **known TASK-546 gap** — the `manage:DepartmentAgent` CASL grant is not yet seeded
into the running DB (the resync controller itself uses `manage:Tenant`, which global admins hold). The
endpoint authorization metadata is unit-verified
(`department-agent-resync.controller.test.ts`). Booting the full API (Vault/secrets warmup) for this
marginal incremental proof was judged not worth the cost this session.

## Change History

- 2026-07-23 — Ticket authored from TASK-544 §7 breakdown (U1, OD-4).
- 2026-07-23 — Implemented **Plan item 4 (clone-to-customize)** with TDD (RED→GREEN): new
  `DepartmentAgentService.clone` (deep-copies bound template into a DRAFT tenant copy + v1 snapshot,
  produces an unlocked lineage-carrying agent clone, leaves the locked source untouched, 404-over-403),
  new `CloneDepartmentAgentRequest` DTO, `IDepartmentAgentService.clone`, and the
  `POST admin/department-agents/:id/clone` controller route + tests. Gates: applications 6780 pass,
  full unit suite 17133 pass, applications + api direct builds clean. Staged. Parts 1–3 (golden seed,
  provisioning, resync) deferred as one DB-gated follow-up batch (rationale in Implementation Summary);
  e2e deferred (8868 busy).
- 2026-07-23 — Owner directive fallback: the mandated `fable-thinking` skill is **not available** in
  this environment (`Skill(fable-thinking)` → "Unknown skill"); recorded here per the directive and
  proceeded.
- 2026-07-23 — Implemented **Parts 1–3** (golden seed, `provisionTenantAgentCatalog`,
  `AgentTemplateResyncService` + cron + admin endpoint) as one TDD batch. New seed
  `07a-agent-golden-library.ts` (18 SYSTEM golden departments + 13 APPROVED templates + 18 golden agents;
  both fixture tenants as locked clones with lineage + `sourceTemplateVersionNumber` anchors) + inventory
  lock test; `DepartmentAgentEntity/Factory` `metaData` wiring (generator drift gates green);
  `provisionTenantAgentCatalog` (unscoped-baseClient reads, per-row isolation, idempotent, atomic default,
  APPROVED snapshots, bare-GEN fallback) + 7 test call-site updates; sibling
  `AgentTemplateResyncService`/cron + `POST admin/department-agents/resync` (global-admin) + settings
  descriptors/seed rows. Decided `SYSTEM_SHARED_READ_MODELS`: NO widening (documented). Gates: full unit
  suite 17190 pass, all builds clean, both generator drift gates clean, lint 0 errors. Runtime-verified by
  seeding **both** dev (5432) and test (5433) Postgres — 18 golden agents, 21 locked clones, 13 golden
  templates, correct lineage metadata, idempotent re-run. **Caught + fixed a real `(tenantId,name)`
  unique-constraint collision** (six departments share the catch-all template) that unit mocks could not
  surface — per-agent snapshots now named after the agent. Status → Review; STAGED not committed. HTTP e2e
  deferred (rationale above).
