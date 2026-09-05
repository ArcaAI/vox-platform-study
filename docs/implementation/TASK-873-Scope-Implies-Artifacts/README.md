# TASK-873 — Service-account scope alignment, dead admin-console feature folders, API artifact regeneration

| | |
|---|---|
| **Status** | Review — complete in the worktree, awaiting the orchestrator's merge into `dev-2.2` |
| **Type** | bugfix / refactor |
| **Program** | Lane C of [TASK-870](../TASK-870-Configuration-Governance-Program/README.md) wave 1 |
| **Branch** | `task-873-scope-implies-artifacts` (worktree) |
| **Base** | `f3c91ca0c` |
| **Merge target** | `dev-2.2` — merged by the orchestrator, not by this lane |

## Requirement Analysis

Three deliverables, one ticket:

1. **Service-account scope alignment.** A machine identity holding exactly the scope a route
   DECLARES clears the scope gate and is then refused by CASL, because the scope's `implies`
   does not carry the ability the route's `@CanXxx`/`@Authorize` demands. Owner decision:
   **option A — widen `implies`**, with two named exceptions where widening would over-grant.
2. **Delete two orphaned admin-console feature folders** (`features/audio-pipelines`,
   `features/pipeline-policy`) whose routes are already redirect stubs.
3. **Regenerate the five API artifacts** and prove no drift. This lane is the ONLY wave-1 lane
   permitted to regenerate them.

### Why the defect exists at all

`svc:admin:*` is not a literal vocabulary. `buildRegistry()`
(`packages/applications/src/services/serviceAccount/service-account-scopes.registry.ts`)
RENAMESPACES every `admin:<area>` entry of `API_KEY_SCOPE_REGISTRY` to `svc:admin:<area>`,
carrying its `implies` verbatim. For an API key those `implies` are a CEILING over the linked
human's abilities, so an under-specified entry is invisible: the human's own abilities decide.
For a service account there is no human — `serviceAccountPolicyRules(scopes)` BUILDS the CASL
ability from the `implies` alone (`unified-auth.guard.ts:627`). The same row is therefore a
ceiling on one plane and the entire grant on the other, and only the second plane notices when
it is too narrow.

Boot-audit assertion A5 already refuses a scope that resolves to ZERO abilities. Nothing checked
that the abilities it does resolve are the ones its routes require. That is the gap this ticket
closes, with a test rather than a sweep.

## Current State Evaluation

### The mismatch table, re-derived from `apps/api/route-manifest.json` at `f3c91ca0c`

Method: for every non-public route that declares `svcScopes` and is not `forbidServiceAccount`,
resolve EACH declared scope through `resolveServiceAccountImpliedPermissions` and evaluate the
route's `requiredPermissions` under CASL (`manage` covers every action, `all` every subject),
honouring `permissionMode`. Per-SCOPE, not per-union, because `enforceServiceAccountScopes` is
`required.some(...)`: any ONE declared scope is sufficient to reach the route, so each one must
independently carry the abilities.

**31 route×scope failures over 8 controllers + 1 more the audit's union view hid** (30 routes;
`WebhookController.fetchDeliveries` is the 31st failure and the 9th controller):

| # | Controller | routes | declared svc scope → implies today | routes require | decision |
|---|---|---|---|---|---|
| 1 | `TenantBucketController` | 11 | `svc:admin:tenant-storage:manage` → `manage:Tenant` | `read/create/update/delete:Storage` | **widen** + `manage:Storage` |
| 2 | `TenantStorageConfigAdminController` | 6 | same scope | `read/update/delete:Storage` | covered by row 1 |
| 3 | `StorageAccessKeyController` | 3 | `svc:admin:storage-key:manage` → `manage:Tenant` | `read/create/delete:Storage` | **widen** + `read/create/delete:Storage` |
| 4 | `WorkflowSandboxRunController` | 4 | `svc:admin:workflow-definition:manage` → `manage:WorkflowDefinition` | `create/read/update:WorkflowRun` | **widen** + `create/read/update:WorkflowRun` |
| 5 | `GlobalSettingController` | 2 | `svc:admin:settings:manage` → `manage:GlobalSetting` | `manage:all` | **narrow the route** — `@ForbidServiceAccount()` |
| 6 | `RolesController` | 2 | `svc:admin:role:write` → `manage:Role` | `manage:RolePolicy` | **widen** + `manage:RolePolicy` |
| 7 | `UserController` | 1 | `svc:admin:user:write` → `manage:User` | `manage:UserRoleAssignment` | **widen** + `manage:UserRoleAssignment` |
| 8 | `PromptManagementController` | 1 | `svc:admin:prompt-template:manage` → `manage:PromptTemplate` | `manage:Department` | **narrow the route** to `update:Department`, **widen** + `update:Department` |
| 9 | `WebhookController` | 1 | `svc:webhook:event:write` → `manage:Webhook` (route declares the `:read`/`:write` PAIR) | `read:WebhookRunHistory` | **widen** + `read:WebhookRunHistory` |

Row 9 is new. `fetchDeliveries` declares BOTH webhook scopes deliberately (comment at
`webhook.controller.ts:83-92`: dropping `:write` "would revoke this route from every existing
`:write` grant"), and reasons that `:read` implies `read:WebhookRunHistory` so a `:read`-only
token clears both gates. The `:write` half was never checked the same way — it implies only
`manage:Webhook`, so a `:write`-only machine clears the scope gate and is 403'd by CASL. The
union view hides it because the OTHER declared scope satisfies the route.

### Why widening `admin:*` is safe on the API-key plane

Widening an `admin:<area>` entry also widens the API-key scope of the same name. That is safe
for two independent reasons, either of which suffices: (a) an API key's abilities are a CEILING
intersected with the linked human's — a key can never exceed its human, so a wider ceiling
grants nothing the human did not already hold; (b) every admin controller is `@ForbidApiKey()`,
checked FIRST in the API-key branch, so no API key reaches these routes at all. All seven
widened rows are additionally `reserved: true`.

### Seed-derivation impact (checked, not assumed)

`94-service-account.ts` seeds the ArcaAI account with `svc:admin:<area>` scopes under one rule:
include a scope iff EVERY ability it implies is one the seeded `TENANT_ADMIN` already holds.
Computed against `01-policy.ts` + `03-role.ts`, TENANT_ADMIN holds all of
`manage:UserRoleAssignment`, `manage:RolePolicy`, `create/read/update:WorkflowRun`,
`update:Department`, `manage:Storage` and `read:WebhookRunHistory`. So no scope changes side:
the widened seeded ones stay eligible, the widened platform-only ones (`role:write`,
`storage-key:manage`, `tenant-storage:manage`) stay excluded by their pre-existing
`manage:Role` / `manage:Tenant`. **`94-service-account.ts` therefore needs no edit** — only its
mirrored table in `__tests__/service-account-seed.test.ts`.

### Out-of-scope findings (recorded, deliberately NOT acted on)

- `admin:storage-key:manage` implies `manage:Tenant`, which NO route declaring it requires (all
  three need only `Storage`). It is an over-grant that predates this ticket; removing it is a
  narrowing outside this lane's brief.
- `admin:tenant-storage:manage`'s `manage:Tenant` IS load-bearing — exactly one route
  (`TenantBucketController.provisionSystemBuckets`) requires it.

### Admin-console folders

`features/audio-pipelines` (14 files) and `features/pipeline-policy` (10 files). Their routes are
redirect stubs (`/audio/pipelines` → `/agents?task=SPEECH_TO_TEXT`, `/harness/pipeline-policy` →
`/workflow-studio/assignments`), which import nothing from the folders. Verified: no path
reference (`features/audio-pipelines`, `features/pipeline-policy`) and no symbol reference
(`AudioPipelinesScreen`, `PipelinePolicyScreen`, `usePipelines`, `useAudioPipelines`,
`audioPipelineKeys`, `pipelinePolicyKeys`, `usePipelinePolicyRow`, `PipelineDetailDrawer`,
`PipelineStatusBadge`, `listPipelines`) exists anywhere else under `apps/admin-console/src`.
There is no `src/features/index.ts` barrel. The playground features import neither.

## Implementation Plan

TDD, in this order (each step's RED is recorded in Change History):

1. **RED** — add `svc-scope-route-ability-coverage.test.ts` (per-route×scope CASL sufficiency,
   driven by `route-manifest.json`); update the seed test's mirrored `SVC_SCOPE_IMPLICATIONS`
   and `PLATFORM_ONLY_SVC_SCOPES` to the widened rows.
2. **GREEN (7 rows)** — widen the seven `API_KEY_SCOPE_REGISTRY` entries.
3. **GREEN (2 exceptions)** — `@ForbidServiceAccount()` on `GlobalSettingController.reveal` /
   `.rotate`; narrow `PromptManagementController.assignDepartment` to `update:Department`; update
   the controller unit tests that pin the old metadata.
4. Delete the two admin-console feature folders; run its gates.
5. Regenerate the five API artifacts; run the three `:check` gates.

## Implementation Summary

### Part 1 — scope alignment

Seven `API_KEY_SCOPE_REGISTRY` entries widened (each renamespaces into the `svc:` scope of the
same name), one route narrowed, two routes machine-closed. Every decision is carried in a comment
at the entry/route itself; the table is the index.

| Entry / route | Change | Why this and not the alternative |
|---|---|---|
| `admin:user:write` | + `manage:UserRoleAssignment` | `POST admin/users/:id/roles` declares this scope. NOT relaxing the route: `UserRoleAssignment` is a deliberately separate subject from `User` (assigning a role is a privilege decision), and relaxing it would hand that decision to every principal holding only `manage:User`. Sensitivity noted: a machine holding this scope can now assign roles — which is what the route's own declaration always claimed. |
| `admin:role:write` | + `manage:RolePolicy` | The description already said "roles AND policies"; only the `implies` disagreed. |
| `admin:tenant-storage:manage` | + `manage:Storage` | Its 17 routes reach the full `Storage` CRUD, so `manage` is exactly the reachable set. `manage:Tenant` kept — `POST …/buckets/provision/:tenantId` requires it. |
| `admin:storage-key:manage` | + `read`/`create`/`delete:Storage` | Listed individually, not `manage:Storage`: no route declaring this scope updates a storage row. |
| `admin:workflow-definition:manage` | + `create`/`read`/`update:WorkflowRun` | Sandbox runs hang off the definition and are part of authoring it. Not `manage:WorkflowRun` — that would silently confer `delete`, which no route here performs. |
| `webhook:event:write` | + `read:WebhookRunHistory` | The O-2 reasoning applied to the write twin (see the new row 9 above). |
| `admin:prompt-template:manage` | + `update:Department` | Paired with the route narrowing below; never `manage:Department`. |
| `PromptManagementController.assignDepartment` | route NARROWED `manage:Department` → `update:Department` | It performs exactly one OCC UPDATE of a Department row's three prompt-slot columns (`DepartmentService.updatePromptConfig`). Rejected alternative: relaxing it to `manage:PromptTemplate`, which would let any prompt author write Department rows — route decorators are shared by every principal class. Human-plane impact: none. No seeded policy grants a bare `update:Department`; TENANT_ADMIN reaches it through `manage:Department` and SUPER_ADMIN through `manage:all`, exactly as before. |
| `GlobalSettingController.reveal` + `.rotate` | `@ForbidServiceAccount()` (method-level, overriding the class scope) | Not a policy preference — it is what the routes already are. Both service methods assert `isSuperAdmin(this.requestUser)` and then re-authenticate the caller's OWN account password against its bcrypt hash (`globalSetting.service.ts`); a service account has neither a user row nor a password, so no machine identity can ever pass. The closure turns an unexplained CASL denial into a first-checked, documented 403 (the guard resolves FORBIDDEN before the scope gate). `manage:all` was never a candidate: it is the CASL wildcard and would turn one admin scope into a platform-wide grant. Boot audits G and H both explicitly permit a method-level forbid over a class-level scope. |

**Downstream effect worth stating:** `packages/vox-node`'s generated admin surface drops
`settings.reveal` and `settings.rotate` (the SDK's admin plane is service-account-only, and those
two routes are now machine-closed). Nothing is lost — a service account could never have executed
them; the SDK previously advertised two calls that would always have 403'd.

**Regression guard.** `packages/applications/src/services/serviceAccount/__tests__/svc-scope-route-ability-coverage.test.ts`
walks `route-manifest.json` and, for every (route, declared scope) pair that a machine identity can
reach, builds the ability the guard builds (`createPrismaAbility(serviceAccountPolicyRules([scope]))`)
and evaluates the route's `requiredPermissions` under the route's own `permissionMode`. Per-scope,
not per-union — that is what surfaced row 9. It is the step boot-audit A5 stops short of: A5 asks
whether a declared scope resolves to ANY ability, this asks whether it resolves to the RIGHT ones.

**Seed.** `94-service-account.ts` is unchanged — every added ability is one TENANT_ADMIN already
holds, so no scope changed side of the seed's derivation rule. Only the mirrored table in
`__tests__/service-account-seed.test.ts` moved (the mirror exists because `packages/database` sits
below `packages/applications` and cannot import the registry).

### Part 2 — dead feature folders

Both deleted: `features/audio-pipelines` (14 files, 2154 lines) and `features/pipeline-policy`
(10 files, 1513 lines). The redirect stub pages stay. No referencing line elsewhere needed a fix —
`nav-config.ts` and `nav-config.test.ts` mention the retired ROUTES (still accurate, the stubs
remain), and `retired-route-redirects.test.tsx` targets the stub pages. The one file-name mention
left is a historical narrative in `shared/__tests__/emphasis-canon.test.ts` explaining how a bug
once shipped; it is prose about the past, not a live reference, and was left alone.

### Part 3 — artifacts

All five regenerated in this worktree; all three drift checks green. The manifest diff is exactly
three fields (assignDepartment's requirement; `forbidServiceAccount` on reveal and rotate).

### Files changed

| File | Change |
|---|---|
| `packages/applications/src/services/apiKey/apikey-scopes.registry.ts` | 7 entries widened |
| `packages/applications/src/services/serviceAccount/__tests__/svc-scope-route-ability-coverage.test.ts` | NEW — the regression guard |
| `packages/database/src/prisma/db_main/seed/__tests__/service-account-seed.test.ts` | mirrored implications updated (6 rows) |
| `apps/api/src/modules/global-setting/global-setting.controller.ts` | `@ForbidServiceAccount()` on reveal + rotate |
| `apps/api/src/modules/global-setting/__tests__/global-setting.controller.test.ts` | asserts the closure and that the class scope survives for the other routes |
| `apps/api/src/modules/prompt-management/prompt-management.controller.ts` | route narrowed to `update:Department`; 403 description follows |
| `apps/api/src/modules/prompt-management/__tests__/prompt-management.controller.test.ts` | expectation follows the narrowing |
| `apps/api/route-manifest.json`, `apps/api/openapi.json`, `apps/admin-console/src/server/api-docs/openapi.admin.json`, `packages/vox-node/src/resources/admin/{admin-namespace,schemas,settings}.ts` | regenerated |
| `apps/admin-console/src/features/{audio-pipelines,pipeline-policy}/**` | DELETED (24 files) |

### Evidence

| Gate | Result |
|---|---|
| new guard, BEFORE the fix (RED) | `Tests 31 failed \| 407 passed (438)` — exactly the derived table |
| new guard, after registry widening | `Tests 3 failed \| 435 passed` — the two exception routes only |
| new guard, final | `Test Files 1 passed · Tests 436 passed (436)` |
| `pnpm --filter @arcaai/applications test` | `Test Files 660 passed \| 1 skipped (661) · Tests 11514 passed \| 4 skipped` |
| `pnpm --filter @arcaai/applications build` / `lint` | build clean; lint `0 errors, 214 warnings` — all pre-existing prettier warnings in untouched files, none in either changed file |
| `pnpm --filter @arcaai/database test` | `Test Files 79 passed · Tests 1767 passed` |
| `pnpm api:build` | `Tasks: 12 successful, 12 total` |
| `pnpm api:test` | `Test Files 279 passed \| 2 skipped (281) · Tests 4207 passed \| 4 skipped` |
| all 12 boot audits, against the real Nest app | `ALL BOOT AUDITS PASS` (incl. `auditServiceAccountSurface` B..H) |
| `pnpm api:openapi:check` | `OK — every served route is either documented or deliberately excluded` |
| `pnpm api:portal:check` | `no drift (admin 642 ops, business 195 ops)` |
| `pnpm --filter @arcaai/vox-node gen:admin:check` | `no drift (52 areas, 411 routes, 383 schemas)` |
| `pnpm --filter @arcaai/vox-node typecheck` / `test` | clean; `Test Files 25 passed · Tests 375 passed` |
| `pnpm --filter @arcaai/admin-console build lint test` | build clean; lint clean (`--max-warnings 0`); `Test Files 258 passed · Tests 2269 passed` |
| `pnpm lint` (repo-wide) | `Tasks: 39 successful, 39 total`; `apps/api` 65 pre-existing warnings, 0 errors, none new |

**One command worth flagging:** the worktree arrived with no generated Prisma client
(`packages/database/src/generated/` absent), so nothing could compile. `pnpm db:generate` was run
once — it is `prisma generate` + the barrel generator, pure code generation into this worktree with
no database connection, and is not one of the shared-surface `db:*` commands rule 14 §3 reserves to
the orchestrator (`db:push`, `db:migrate`, `test:db:reset`). No other `db:*` command was run, no
Docker was started, and no database was contacted. `@arcaai/ui`, `@arcaai/vox`, `@arcaai/stt` and
their dependencies were also built for the first time in this worktree, which is what the 106 → 5 → 0
admin-console suite-failure progression above reflects (fresh-worktree build state, not this change).

Not run in this lane, by instruction: the Playwright e2e authz matrix
(`task-776-route-authz-matrix.spec.ts`), which needs a live gateway and Docker infra. It reads the
same manifest this lane regenerated and is covered in substance by the new unit guard plus the boot
audits; the orchestrator runs it after the merge.

## Change History

| Date | Change |
|---|---|
| 2026-09-05 | Ticket opened; mismatch table re-derived from `route-manifest.json` (31 route×scope failures, 9 controllers — one more than the program audit's union view found). |
| 2026-09-05 | RED: new guard fails on exactly those 31 pairs. Seven registry entries widened → 3 remaining. `@ForbidServiceAccount()` on `reveal`/`rotate`, `assignDepartment` narrowed to `update:Department` → green after regeneration. Five artifacts regenerated, three drift checks green, all 12 boot audits pass. (`1296987b8`) |
| 2026-09-05 | Both orphaned admin-console feature folders deleted after a path- and symbol-level liveness check; admin-console build/lint/test green. (`68a2be9f5`) |
