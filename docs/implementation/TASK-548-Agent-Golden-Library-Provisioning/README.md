# TASK-548 — Agent Golden Library: Day-1 Departments + Agents per Tenant, Clone-on-Provision, Resync

- **Status:** In Progress (Part 4 clone-to-customize COMPLETE + gated; Parts 1–3 golden seed / provisioning / resync remain — scoped follow-ups)
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

### Remaining (Parts 1–3) — deliberately deferred as one follow-up batch

Provisioning and resync are **meaningless until the golden library exists**, and the golden seed is the
large, DB-gated piece that cannot be verified this session without a **prohibited dev/test-DB reset**
(hard rule 3). They belong together in a follow-up with a scratch DB:

1. **Golden library seed** — promote the 18-department fixture catalog (`seed/04-department.ts`,
   `seed/07-prompt-template.ts`) into **SYSTEM-tenant** golden rows: SYSTEM `Department`s, SYSTEM
   APPROVED `PromptTemplate`s (+ `PromptVersion` v1), SYSTEM `DepartmentAgent` template rows
   (`templateLocked:false` on the originals); express the two fixture tenants as clones
   (`06-stt.ts asTemplateCopies` pattern); add a seed inventory-lock test (`seed.test.ts:1305` style);
   decide `SYSTEM_SHARED_READ_MODELS` exposure for the "Library" list.
2. **`provisionTenantAgentCatalog()`** in `tenant.service.ts` — mirror `provisionTenantPipelineCatalog`
   (per-row isolation, idempotent skip-existing, atomic default flip, `templateLocked:true` clones,
   APPROVED template snapshots). Requires two **append-only** constructor injections
   (`DepartmentAgentRepository`, `PromptVersionRepository`) touching the **7** `new TenantService(...)`
   test call sites. Keep bare-`GEN` as the empty-golden-set fallback.
3. **`AgentTemplateResyncService`** (+ nightly cron + `POST admin/department-agents/resync`) — a
   **sibling** of `stt/pipeline/pipeline-template-resync.service.ts` (do NOT modify that service): four
   rules — add-missing-locked, fast-forward-pristine-locked, never-touch-unlocked, skip-drifted; store
   `sourceTemplateVersionNumber` in clone metadata for cheap pristine detection.

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
