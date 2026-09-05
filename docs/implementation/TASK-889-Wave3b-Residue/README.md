# TASK-889 — Wave-3b residue: one bundle contract, and a sync data path that works

| | |
|---|---|
| **Status** | Review |
| **Program** | TASK-870 configuration governance, wave 3b (residue lane) |
| **Branch** | `task-889-wave3b-residue` off `88a876e49` (`dev-2.2` + TASK-884 / 885 / 886) |
| **Type** | refactor + bugfix |
| **Closes** | the two reconciliation items wave 3b left open — lane G's local alias of lane F's bundle contract, and the sync data path both lanes deferred |

## Requirement Analysis

Two deliverables, both named in the wave-3b rows G and H of the program README.

**D1 — one bundle contract.** TASK-885 shipped `workflow-definition/portable-bundle.contract.ts`,
a LOCAL ALIAS of the envelope TASK-884 was authoring in parallel, carrying its own
`// TASK-884: replace with the shared PortableBundle once merged` marker. Lane F has since merged
`packages/workflow-contract/src/portable-bundle.ts`. Two envelope declarations for one wire format
is exactly the drift a shared contract exists to prevent, so the alias is deleted and the workflow
bundle joins the real one.

**D2 — the sync data path.** Both `AgentService.syncToTenants` and
`WorkflowDefinitionService.syncToTenants` authorise a caller who holds `manage` in the source AND
in every target (membership = `UserRoleAssignment`, resolved through `PolicyEngine`). What neither
had was a DATA path that honours the same boundary: the tenant-scope Prisma extension pins every
scoped read and write to the ONE tenant in CLS, so a step that means "read tenant A / write tenant
B" must SAY which tenant it means. Lane G's own README recorded this as deferred
("what is missing is the data path"), and lane F's write path sidesteps it by running on the
unscoped client.

## Current State Evaluation

Measured on `88a876e49`.

### D1 — where the alias is

| Site | What it uses |
|---|---|
| `workflow-definition/portable-bundle.contract.ts` | the alias itself: `PortableBundle<TKind, TPayload>`, `PortableSource`, `PortableSourceTenantKind`, `WORKFLOW_DEFINITION_BUNDLE_KIND = 'workflow-definition'`, `…_SCHEMA_VERSION = 1` |
| `workflow-definition.service.ts:88-91, 532-533, 570-575` | builds the envelope by object literal; validates an import with two hand-rolled `if`s |
| `dto/workflow-definition-bundle.ts:6, 64, 78` | `implements PortableBundle<'workflow-definition', …>`; `source.versionNumber` |
| `workflow-definition/index.ts:14` | re-exports the alias |
| console `features/workflow-studio/{api/types.ts,lib/bundle-io.ts,components/import-definition-dialog.tsx}` | mirrors the same literal + `source.versionNumber` |

The shared contract differs in two observable ways: `kind` is drawn from
`PORTABLE_BUNDLE_KINDS = ['agent', 'workflow']` (so the workflow literal becomes `'workflow'`), and
`PortableBundleSource.version` replaces the alias's `source.versionNumber`. The second is not
cosmetic — `portableBundleProblems()` validates `source.version`, so a bundle keeping
`versionNumber` cannot pass the shared validator, and the global `ValidationPipe`
(`forbidNonWhitelisted`) would reject the other spelling on the way in. Both are wire changes,
taken deliberately: no bundle has ever been exported from a deployed environment (pre-production,
day-1 posture), and carrying two spellings of one field is the drift this ticket exists to remove.

### D2 — what each sync actually does today, and what breaks

`tenant-scope.ts` merges the CLS tenant into every scoped read's `where` and asserts it against
every scoped write's `data`; a caller-supplied tenant that DISAGREES with CLS throws
`TenantScope: tenantId mismatch`. Pass-through happens only when CLS carries NO tenant **and** the
actor is `SUPER_ADMIN` (`:635`). `AgentPromotionService` meets that bar deliberately — it is the
platform-admin promotion path and `assertElevatedTenantlessContext()` is its gate. That gate is
NOT the answer here: a multi-tenant customer admin is not elevated and must not become elevated to
sync their own tenants.

| Sync | Today | Verdict |
|---|---|---|
| `WorkflowDefinitionService.syncToTenants:786` | calls `assertElevatedTenantlessContext('Syncing a workflow')` | **403 for the person owner #4 names.** Past that gate it would still throw: `resolveBundleReferences(graph, targetTenantId)` and `validateGraph(…, targetTenantId)` read the target's catalogue through the SCOPED client while CLS holds the caller's own tenant |
| `AgentService.syncToTenants:634` | no elevation gate; every cross-tenant step takes `tx` from `databaseService.baseClient.$transaction` | **Not blocked — unchecked.** `baseClient` bypasses BOTH extensions, so the target-side reads and writes carry whatever tenant id the call site passed, with nothing verifying it. One scoped read survives inside `writeCopy` (`fallbackRepository.findByAgentId(source.id)`), which is why a naive "wrap the whole copy in the target context" would silently read an empty fallback chain |

`PolicyEngine.loadUserPolicies` already reads the RBAC control plane on the unscoped client, so the
AUTHORISATION half works across tenants in both syncs and is not touched here.

## Implementation Plan

### D1
1. Delete `portable-bundle.contract.ts`; repoint the three import sites at `@arcaai/workflow-contract`.
2. `kind` becomes `'workflow'`; `source.versionNumber` becomes `source.version`.
3. Export builds through `buildPortableBundle('workflow', …)`; import validates through
   `portableBundleProblems(bundle, { kind: 'workflow' })` so both bundle kinds refuse a bad
   envelope identically, with the same problem list.
4. Update lane G's tests/fixtures, and the console mirror + its fixture.

### D2
1. One shared helper, `runInTenantContext(cls, tenantId, work)`, beside the promotion service —
   see *Decisions* for why there.
2. `WorkflowDefinitionService.syncToTenants`: drop the elevation gate; run the source read in the
   SOURCE context and each target's resolve / validate / write in THAT target's context.
3. `AgentService.syncToTenants`: hoist the source-side fallback read into the SOURCE context and
   pass it in; run each target's copy in the target's context.
4. Prove it without a database: drive the real `applyTenantScopeExtension` over a stub client whose
   tenant comes from the same CLS the helper drives.
5. One `describe.skip`ped integration file for the live path.

## Implementation Summary

### D1 — one bundle contract

| What | Where | Proven by |
|---|---|---|
| The alias is gone | `packages/applications/src/services/workflow-definition/portable-bundle.contract.ts` (deleted); barrel line removed from `workflow-definition/index.ts:12-14` | the package builds with no reference left (`grep` for `WORKFLOW_DEFINITION_BUNDLE\|portable-bundle.contract` returns nothing) |
| The DTO IS the shared envelope | `dto/workflow-definition-bundle.ts:88` — `implements PortableBundle<WorkflowDefinitionBundlePayload>`; `kind: 'workflow'`; `source.version` (`:74`) | `tsc`: the class stops compiling if the shared envelope moves |
| Export is BUILT by the contract | `workflow-definition.service.ts:544` `buildPortableBundle(WORKFLOW_BUNDLE_KIND, …)` | `workflow-definition.import-export.task885.test.ts` — "produces an envelope the shared portable-bundle validator accepts as a `workflow` bundle" (also asserts an AGENT importer refuses it, naming the kind) |
| Import is VALIDATED by the contract | `workflow-definition.service.ts:586` `portableBundleProblems(bundle, { kind: WORKFLOW_BUNDLE_KIND })` → one 400 `BUNDLE_INVALID` carrying `findings` | same file — "rejects a bundle of the wrong kind or an unimplemented schema version" |
| One literal, not two | `workflow-definition.service.ts:127` `WORKFLOW_BUNDLE_KIND` used by both the builder and the validator | — |
| Console mirror follows | `features/workflow-studio/{api/types.ts:366, lib/bundle-io.ts:36, components/import-definition-dialog.tsx:152}` + its fixture | `admin-console` suite |

**Two wire changes, both forced and both deliberate**: `kind` `'workflow-definition'` → `'workflow'`
(the shared vocabulary), and `source.versionNumber` → `source.version` (what
`portableBundleProblems` validates; the global `ValidationPipe`'s `forbidNonWhitelisted` would
reject the other spelling inbound). No bundle has ever been exported from a deployed environment,
so there is nothing in the wild to migrate.

### D2 — the sync data path

**The helper.** `packages/applications/src/services/agentPromotion/tenant-context.ts` —
`runInTenantContext(cls, tenantId, work)`, `cls.run({ ifNested: 'inherit' })` + `cls.set('tenantId')`,
the shape `apps/api/src/modules/internal/agent-internal.controller.ts` already uses to serve a peer
service under the tenant it named. It is deliberately filed **beside `AgentPromotionService`**, not
in `common/`: the two cross-tenant mechanisms in this codebase are the ELEVATED one (super-admin,
tenant-less, unfiltered client) and this MEMBERSHIP-BOUNDED one, and they must be read together so
nobody widens the first when they meant the second. `assertElevatedTenantlessContext` now carries a
comment saying so in both services.

| What | Where | Proven by |
|---|---|---|
| Source read pinned to the SOURCE tenant (workflow) | `workflow-definition.service.ts:839` | `membership-bounded-sync.task889.test.ts` (a) — the `findFirst` the extension emitted carries the source tenant |
| Each target's resolve + validate pinned to THAT target | `workflow-definition.service.ts:864` | same file (a,b) |
| Each target's write pinned to THAT target | `workflow-definition.service.ts:897` | same (b) — `create` args in target order |
| The elevation gate is gone from sync | `workflow-definition.service.ts:797` (call removed); the method survives for `promoteToSystem` at `:982`, with a "do not re-attach" note at `:1051` | `workflow-definition.sync-promotion.task885.test.ts` — "lets a NON-elevated multi-tenant admin sync" (the REVERSED test; the elevated gate is still asserted on `promoteToSystem`) |
| Source read + fallback chain pinned to the SOURCE (agent) | `agent.service.ts:647` | `membership-bounded-sync.task889.test.ts` (a,b) — exactly two scoped reads, both in the source step, the chain read ONCE |
| Each target's copy pinned to THAT target | `agent.service.ts:669` | same |
| The chain cannot vanish under a target context | `agent.service.ts:879` `knownSourceFallbacks` | same test; the clone path is untouched, so deferred H-6 stays deferred |
| A tenant outside the caller's memberships is never queried | authorisation precedes every target step in both services | (c) — the 404 lands with an EMPTY query log |
| A super admin still works, and is now PINNED per step | — | (d) — before this change an elevated caller's reads carried `undefined` (pass-through over the whole estate); they now carry the named tenant |

**The write transaction stays on the unscoped `baseClient`, on purpose.** Two of its reads are
genuinely cross-tenant with an explicit tenant argument, and the scoped client would break both:
`AgentService.resolveModelIdForTarget` must read the SOURCE tenant's model row while standing in
the TARGET's context, and `findMaxVersionNumber` is documented as deliberately unfiltered by
`resourceStatus` (a soft-deleted row's `versionNumber` is still live in the unique index) — the
soft-delete extension would filter it and mint a colliding version. What the helper fixes is
everything that goes through the SCOPED client. This is recorded in the helper's own header so the
next reader does not "tidy" it.

### Decisions worth stating

1. **A narrowing, not a widening.** The alternative on the table (lane G's own handoff) was to
   widen `tenant-scope.ts` pass-through to a "declared multi-tenant operator". That would hand a
   customer admin the same unfiltered client the platform uses. Naming the tenant per step gives
   them strictly less: every read and write stays fully scoped, and to a tenant they were just
   authorised for.
2. **`packages/database/src/extensions/**` was not touched.** It is the enforcement layer this
   ticket leans on; changing it to make a caller pass is the wrong direction.
3. **Audit attribution changes for the workflow sync, for the better.** The `ResourceCreated`
   sys-event stamps CLS `tenantId`; under the old elevated-only path that was always `SYSTEM`.
   A tenant admin's sync is now attributed to the tenant that performed it.
4. **`assertPortableAcrossTenants` (agent) was left on the ambient context.** It reads SOURCE-side
   rows, and on this path `resolveOwnSource` guarantees the ambient tenant IS the source, so
   wrapping it would be a no-op. Noted rather than done.

## Verification

Every count below was measured on this branch AND on the merge base `88a876e49` before the work
started, so each delta is attributed rather than assumed.

```
pnpm --filter @arcaai/workflow-contract build   -> exit 0
pnpm --filter @arcaai/workflow-contract test    -> Test Files  38 passed (38)
                                                        Tests  1548 passed (1548)      [= baseline]

pnpm --filter @arcaai/applications build        -> exit 0
pnpm --filter @arcaai/applications test         -> Test Files  665 passed | 2 skipped (667)
                                                        Tests  11683 passed | 6 skipped (11689)
pnpm --filter @arcaai/applications lint         -> 241 problems (0 errors, 241 warnings)

pnpm --filter @arcaai/api typecheck             -> exit 0
pnpm --filter @arcaai/api test                  -> Test Files  279 passed | 2 skipped (281)
                                                        Tests  4186 passed | 4 skipped (4190)   [= baseline]
pnpm --filter @arcaai/api lint                  -> 70 problems (5 errors, 65 warnings)

pnpm --filter @arcaai/admin-console test        -> Test Files  259 passed (259)
                                                        Tests  2287 passed (2287)      [= baseline]
```

### Reconciliation against the baseline

| Gate | Baseline (`88a876e49`) | Now | Why |
|---|---|---|---|
| applications test — files | 664 passed \| 1 skipped (665) | 665 passed \| 2 skipped (667) | +1 passed: `membership-bounded-sync.task889.test.ts`. +1 skipped: the live-path integration file (`describe.skip`; the applications vitest config does not exclude `**/integration/**`, so it is COLLECTED and reported skipped) |
| applications test — cases | 11677 passed \| 4 skipped (11681) | 11683 passed \| 6 skipped (11689) | +6 passed = 5 (the proof file) + 1 (the shared-validator round-trip added to lane G's import/export suite). +2 skipped = the integration file's two cases |
| applications lint | 242 warnings, 0 errors | 241 warnings, 0 errors | **one FEWER.** Measured directly: linting the base and current `agent.service.ts` side by side gives 5 → 4 warnings — a pre-existing `prettier/prettier` warning sat on the `sourceFallbacks` line this change rewrites, and the rewrite is prettier-clean. Every file this ticket adds or edits reports **0 errors, 0 warnings** individually |
| api lint | 5 errors, 65 warnings | 5 errors, 65 warnings | UNCHANGED — the 5 are the pre-attributed e2e-spec errors (`auth-throttle-per-endpoint.spec.ts` ×3, `harness-gate.spec.ts` unused var, `shared-component-contracts.spec.ts`), none in a file this ticket touches |
| api test / typecheck, admin-console test, workflow-contract | — | identical | no behavioural change reached them |

`pnpm test:integration` was NOT run: the shared test database still carries the pre-wave schema
(see *Handoffs*). No migration was authored and no generated artifact was edited.

## Handoffs

| To | Item |
|---|---|
| **Orchestrator — artifacts (REQUIRED before merge closes)** | The `WorkflowDefinitionBundle` schema changed (`kind` `'workflow-definition'` → `'workflow'`; `source.versionNumber` → `source.version`) and the sync route's description + 403 text changed. No route was added or removed, no new tag, no new scope. Run the five-artifact chain and its three checks: `pnpm api:build && pnpm api:route-manifest && pnpm api:openapi && pnpm api:portal && pnpm --filter @arcaai/vox-node gen:admin`, then `pnpm api:openapi:check`, `pnpm api:portal:check`, `pnpm --filter @arcaai/vox-node gen:admin:check`. `api:portal` is also what rewrites the console's committed `apps/admin-console/src/server/api-docs/openapi.business.json`, which still carries the OLD bundle schema — this lane does not edit generated artifacts. |
| **Orchestrator — unskip the live-path test** | `packages/applications/src/services/agentPromotion/__tests__/integration/membership-bounded-sync.integration.test.ts` is `describe.skip`ped because the shared test database still carries the PRE-WAVE schema and this lane was not cleared to reset it. **Unskip condition**: the test DB has been reset onto the wave's schema (`pnpm setup:test`, or `pnpm test:db:reset && pnpm test:db:seed`) — the same gate the rest of `pnpm test:integration` waits on. Change `describe.skip` to `describe`; nothing else. It costs 2 skipped tests in the applications suite until then (reconciled below). |
| **Orchestrator — e2e** | No route was added, so the route-authz matrix covers `POST admin/workflow-definitions/slug/:slug/sync` automatically once the manifest is regenerated. What the matrix cannot express is the new REACHABILITY: a tenant admin holding `manage:WorkflowDefinition` in two tenants now gets a 200 where they used to get a 403. That needs a live gateway and two seeded memberships, so it is named here rather than committed as an unrunnable spec. |
| **Owner — still open, untouched** | Lane G's OTHER deferred decision is unaffected by this ticket and still open: should `WorkflowAssignmentService.resolve` gain a SYSTEM tier (with a widened dispatcher lookup), so an unopinionated tenant actually runs the SYSTEM template? Lane F's H-6 (a SYSTEM template's fallback chain is unreadable because `AgentModelFallback` is not a shared-read model) is likewise still deferred — this ticket deliberately did NOT close it as a side effect: the fallback hoist applies only to the sync path, where the source is always the caller's own tenant. |

## Change History

| Date | Entry |
|---|---|
| 2026-09-06 | Ticket opened; current state measured on `88a876e49`; plan recorded. |
| 2026-09-06 | D1: the alias deleted, the workflow bundle repointed at `@arcaai/workflow-contract` (`kind: 'workflow'`, `source.version`), export built by `buildPortableBundle` and import validated by `portableBundleProblems`; console mirror follows. `dbdf15cb7` |
| 2026-09-06 | D2: `runInTenantContext` added beside `AgentPromotionService`; both syncs rewired onto per-tenant steps; the workflow sync's elevation gate removed (its test REVERSED); the agent sync's source fallback chain hoisted so a target step cannot read it empty. Proof against the real tenant-scope extension + one skipped live-path file. `58d0e2676` |
