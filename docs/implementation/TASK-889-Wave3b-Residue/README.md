# TASK-889 — Wave-3b residue: one bundle contract, and a sync data path that works

| | |
|---|---|
| **Status** | In Progress |
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

_(filled in as the work lands)_

## Change History

| Date | Entry |
|---|---|
| 2026-09-06 | Ticket opened; current state measured on `88a876e49`; plan recorded. |
