# TASK-663 — Agent Promotion Between Tenants

- **Status:** Review
- **Type:** feature
- **Wave:** W3 of [TASK-654](../TASK-654-Consultation-Context-Schema-And-Configurable-Loop/README.md) (parallel to TASK-662, which owns `apps/harness/**`)
- **Baseline:** `dev-2.1` @ `39f210ab7` (`docs(TASK-654): Wave 2 merged, Wave 3 started`)
- **Branch:** worktree `worktree-agent-ac3e52d8707ade171` — `git reset --hard dev-2.1` performed (it spawned off `dev` @ `180d09d6a`, per the standing worktree caveat)
- **Spec:** [execution-plan.md § TASK-663](../TASK-654-Consultation-Context-Schema-And-Configurable-Loop/execution-plan.md)
- **Depends on:** TASK-659 (`DepartmentAgentVersion` — the immutable artifact promotion copies), TASK-658 (the context-schema plane promotion validates against)

---

## 1. Requirement Analysis

**Objective.** An admin who manages two tenants promotes an agent version from one to the
other. Decision D10 of the parent: promotion is admin-chosen, **any tenant to any tenant** —
there is no platform environment, tier, or tenant-family concept, so *"the actor holds manage
rights on both tenants"* is the **entire** authorization control.

| # | Acceptance criterion |
|---|---|
| AC-1 | New immutable `AgentPromotion` model — `fromTenantId`, `toTenantId`, `agentVersionId`, `evalRunId?`, actor, timestamp. WORM: written once, never updated, never soft-deleted |
| AC-2 | The actor must hold `manage` on `DepartmentAgent` in **BOTH** the source and the target tenant. Either side missing ⇒ **403** |
| AC-3 | Promotion copies the **exact immutable `DepartmentAgentVersion.configSnapshot`** — the agent is never re-authored in the target (mirrors the repo's own `promote-*` CI jobs, which re-tag a digest rather than rebuild) |
| AC-4 | Eval **re-runs at the target tenant**, against the target's own corpus. The source `EvalRun` travels as an attestation only |
| AC-5 | **No `GoldenCase` row ever crosses a tenant boundary** — no code path is created that could move one |
| AC-6 | **Blocked** when the target tenant lacks a context kind the promoted agent subscribes to (or an output kind it writes), with a **named** reason |
| AC-7 | **Alert, don't block**, when the target has live consultations — *"N consultations are currently running on the previous version and will complete on it."* |
| AC-8 | Lineage recorded on the target; drift detectable afterwards |
| AC-9 | Runs under an elevated tenant-less context exactly as `AgentTemplateResyncService` does. `DepartmentAgent` is **NOT** added to `SYSTEM_SHARED_READ_MODELS` |
| AC-10 | **Regression:** a cross-tenant read outside a sanctioned promotion still returns **404**, never 403 (parent constraint C5) |
| AC-11 | A promoted agent arrives with its loop configuration **intact** — the TASK-659 §4.5 gap; `clone()` is made consistent with the decision taken here |

### 1.1 Constraints inherited from the parent

| # | Constraint | How this ticket honors it |
|---|---|---|
| C5 | Cross-tenant access returns 404, not 403 | Authorization runs **before** any read (§3.3). A caller who has not proven manage-on-both learns nothing about either tenant; a caller who fails the *tenancy* posture on a normal agent read still gets 404 (regression-tested) |
| C6 | resource → immutable version → movable pinned default | Promotion consumes the TASK-659 immutable `DepartmentAgentVersion` and produces one in the target |
| C7 | Global `whitelist + forbidNonWhitelisted + forbidUnknownValues` | Every accepted field is declared on a class-validator DTO |
| RK-8 | "Promotion is the largest net-new surface and was least discussed" | Own ticket; eval re-runs at target; corpus never moves |

### 1.2 Out of scope

The admin-console promotion screen (TASK-667 territory), loop dispatch of a promoted agent
(TASK-662), and reasoning/adjudication (TASK-664). Promotion between tenants of anything other
than a `DepartmentAgent` (schemas, pipelines, policies) is not in this ticket.

---

## 2. Current State Evaluation

Verified against `dev-2.1` @ `39f210ab7`.

| Area | Finding |
|---|---|
| Cross-tenant agent copy | **Exists in exactly one direction: SYSTEM → tenant.** `DepartmentAgentService.clone` 404s on a foreign source (`loadOwned`). `TenantService.provisionTenantAgentCatalog` (at tenant creation) and `AgentTemplateResyncService` (nightly) both read the SYSTEM golden library and write into an arbitrary tenant. Tenant → tenant has **no** code path at all. |
| The elevated tenant-less mechanism | There is **no `runWithTenant` helper in the repo** — suppression is ambient. `TenantContextProvider.getTenantId()` (`apps/api/src/database/tenant-context.provider.ts:52-66`) returns `undefined` for an empty-string CLS `tenantId` (how a global admin authenticates) and `isSuperAdmin()` returns true with no CLS at all. `tenant-scope.ts`'s handlers then pass through: `if (tenantId == null) { if (isSuperAdmin) return query(args); throw ... }`. |
| The corollary that shapes this ticket | With a **pinned** tenant the extension calls `mergeTenantIntoWhere` and **forces** the caller's tenantId into every read. A cross-tenant read is therefore not merely unauthorized — it is *mechanically impossible* unless the context is elevated and tenant-less. Every repository call in the promotion path must pass `tenantId` **explicitly**; the extension adds nothing in pass-through mode. |
| Per-tenant ability check, callable from a service | `PolicyEngine.buildAbility({ userId, tenantId })` → `AppAbility.can(action, subject)`. `loadUserPolicies` scopes assignments to `tenantId IN [SYSTEM, context.tenantId]` on the **unscoped** client, so the answer genuinely is "for tenant X". Precedent for calling it outside a guard: `permission-check.controller.ts:41-59`, `role.service.ts:73`, `consultation.controller.ts:250-256`. |
| `GoldenCase` PHI | `harness.prisma:82-118` — plaintext `transcript`/`referenceNote` columns were **dropped**; the row carries `encryptedTranscript`/`encryptedReferenceNote` `Bytes?` + `keyVersion`, Vault-Transit key `hope-phi`. `EvalRunService.runGoldenSet` decrypts per case in-process. Nothing moves a case anywhere. |
| Eval at a tenant | `EvalRunService.runGoldenSet({ goldenSetId, tenantId, triggerType, promptTemplateId?, ... })` — `tenantId` is an explicit parameter, never read from CLS; a cross-tenant `goldenSetId` yields `DataNotFoundException` (404-over-403). `EvalPromotionGateService` fires on exactly two existing transitions (template approve, agent pin). |
| Live consultations | `Consultation.status` (`ConsultationStatus.RECORDING`) with index `[tenantId, status]`. `consultationRepository.count({ filters: { tenantId, status } })` is the direct count; `GET /admin/consultations?status=RECORDING` already uses exactly this. There is **no** `Consultation.pinnedAgentId` column — the session pin lives in `LiveSession`/Redis and on the `LIVE_SOAP_SNAPSHOT` `metaData.agent`, and the Redis stats snapshot deliberately carries no `agentId` (PHI-safe counters only). |
| Template references across tenants | `PromptTemplate` **is** in `SYSTEM_SHARED_READ_MODELS`, which is why `AgentTemplateResyncService` may copy capability bindings *by reference* from SYSTEM. That does **not** generalise: a tenant-owned template id copied into another tenant is unreadable there and would silently fall through the resolver. |
| The TASK-659 gap | `clone()` (`departmentAgent.service.ts:420-517`) copies 19 fields and **none of the seven loop-config fields**, and never calls `writeLoopConfigVersionIfNeeded`. TASK-659 §4.5 flagged this explicitly and deferred the call to this ticket. |

---

## 3. Implementation Plan

### 3.1 What promotion carries — and what it deliberately does not

This is the ticket's central design decision, and the answer to the TASK-659 §4.5 gap.

**The governing rule: promotion copies *values*, never *references*.** A reference — a template
id, a golden-set id, a department id — is meaningful only inside the tenant that owns it.
Copying one across the boundary produces a row that either resolves to nothing or, worse,
points at another tenant's data. Copying the *value* it names is always safe.

| Carried | Why |
|---|---|
| All seven loop-config fields, taken from the immutable `DepartmentAgentVersion.configSnapshot` — `role`, `subscribedKinds`, `writeScope`, `goal`, `guardrailProfile`, `alwaysActions`, `neverActions` | This IS the promoted artifact (AC-3). Read from the version row, never re-derived from the live source agent, so a mid-promotion edit at the source cannot leak into the target |
| `description`, `dnaStylePolicy`, `toolConfig`, `llmOverrides`, `tags` | Plain values with no cross-tenant meaning |
| Every bound prompt template — base **and** the four capability bindings — **deep-copied** into a fresh target-tenant `APPROVED` template + `v1` `PromptVersion` | A tenant-owned template id is not readable in the target. Dropping the bindings instead would repeat exactly the failure this ticket exists to fix: an agent arriving with part of its configuration silently missing. A binding that names a **SYSTEM** template keeps its id (SYSTEM templates are in `SYSTEM_SHARED_READ_MODELS`, so the reference is genuinely valid) |
| `name`, `slug` | Identity — the promotion targets the same slug in the target's matching department |

| **Not** carried | Why |
|---|---|
| `goldenSetId` | The sharpest expression of "the corpus never moves" (AC-5): not even the *pointer* crosses. A source golden-set id in a target row would name a `GoldenSet` whose `GoldenCase` children hold Vault-Transit-encrypted PHI belonging to another tenant. The target agent keeps its own |
| `pinnedVersionNumber` | Numbers a version of the *source* template. The target's freshly-created template starts at v1; the promoted agent tracks it |
| `isDefault` | A promotion must never silently re-point a target department's default agent. That is a separate, deliberate act |
| `templateLocked` | The target copy is the tenant's to edit (`false`). Locking is the golden-library mechanism (`AgentTemplateResyncService`), not this one |
| `sourceAgentTemplateSlug` | Golden-library lineage. Promotion lineage is the `AgentPromotion` row, which is strictly richer |
| The source `EvalRun` | Travels as an **attestation** (`sourceEvalRunId` on the promotion record), never as a result the target inherits (AC-4) |

**Closing the TASK-659 gap in `clone()`.** `clone()` is made consistent with the decision
above: it carries all seven loop-config fields and calls `writeLoopConfigVersionIfNeeded`, with
**one deliberate exception** — `role` is forced to `SPECIALIST`. A clone lands in the *same*
department as its source; if the source is that department's `PRIMARY` then a `PRIMARY` clone
would violate the AC-7-of-TASK-659 invariant by construction, and if the source is a
`SPECIALIST` the forced value is what it already was. No extra query is needed to know this.
Promotion has no such constraint (a different tenant's department may have no `PRIMARY` at
all), so it carries `role` faithfully and validates it — see §3.4.

`AgentTemplateResyncService` is **deliberately left alone**, and this is a decision rather than
an omission. Resync is an unattended nightly sweep across every tenant; propagating
`subscribedKinds`/`writeScope` from a SYSTEM golden agent would push kind references into
tenants whose context schema does not declare them — manufacturing, silently and at scale,
exactly the broken state promotion **blocks** on (AC-6). Carrying only the non-referencing
subset would leave a half-configured agent, which is worse than none. Every SYSTEM golden agent
has all seven fields at their defaults today, so the present-day effect is nil. Recorded as
open item OI-1 (§6): if golden agents ever gain loop config, resync needs a per-tenant
compatibility check, not a copy.

### 3.2 Schema

`AgentPromotion`, in `department-agent.prisma` (same family, same file as the agent and its
version):

- `tenantId` = **`toTenantId`**. The promotion record is *the target's* lineage (AC-8), so the
  target tenant owns and reads it; the entity's `validate()` enforces `tenantId === toTenantId`
  so the two can never diverge. `fromTenantId` is a plain column.
- `agentVersionId`, `sourceAgentId`, `targetAgentId`, `targetAgentVersionId` — plain `String`
  columns with **no `@relation`**. An FK would create a *navigable* path from a target-tenant
  row into source-tenant rows; the tenant-scope extension scopes per model, so a nested include
  is not a leak, but the relation itself is a shape this codebase should not own. The `tenantId`
  column's own no-FK convention is the precedent.
- `configSnapshot Json` + `checksum String` — the exact promoted bytes, which is what makes the
  record auditable and drift detectable (AC-8).
- `evalRunId String?` (the **target** re-run) and `sourceEvalRunId String?` (the source
  attestation). Two columns, because conflating them is precisely the mistake AC-4 forbids.
- `promotedBy String?` — the actor. Named explicitly rather than leaning on `createdBy`, which
  carries a system default and would read as "whoever inserted the row".
- `warnings Json?` — the AC-7 alert text as issued, so the record shows what the operator was
  told at the time.
- No `resourceStatus`, no `updatedAt`/`updatedBy` — the `DepartmentAgentVersion` /
  `PromptVersion` immutable shape (⇒ `MODELS_WITHOUT_SOFT_DELETE`).

`ResourceType += AgentPromotion` in **both** `audit.prisma` and
`packages/domains/src/enums/generated/ResourceType.ts` (+ `ALTER TYPE ... ADD VALUE`), because
unlike `DepartmentAgentVersion` this row **is** its own audited resource with its own lifecycle
and its own `broadcastSysEvent`. `resourceType.enum-parity.test.ts` is the guard.

Allow-lists: `TENANT_SCOPED_MODELS += AgentPromotion`; `MODELS_WITHOUT_SOFT_DELETE +=
AgentPromotion`. `SYSTEM_SHARED_READ_MODELS` is **not** touched (AC-9).

Migration `task_663_agent_promotion`, produced via the shadow-DB recovery of execution-plan
§1.1c (`pnpm db:migrate` is broken on `dev-2.1`).

### 3.3 Authorization — the whole control (AC-2)

```
assertPromotionContext()      // mechanical precondition, see below
assertManagesBothTenants()    // THE authorization control
  → then, and only then, any read
```

`assertManagesBothTenants(fromTenantId, toTenantId)` calls
`policyEngine.buildAbility({ userId, tenantId })` **once per tenant** and requires
`can('manage', 'DepartmentAgent')` on each. Either side missing ⇒ `ForbiddenException` naming
*which* side failed. This is a **privilege** 403, not the 404-over-403 tenancy posture — the
distinction the `05-nestjs-api.md` §"Imperative Privilege Checks" table draws, and the route
carries the mandatory `// AUTH-NOTE:` marker because its `@CanManage('DepartmentAgent')`
decorator understates the real gate.

**Ordering is load-bearing.** Authorization runs before the source or target agent is read, so
an unauthorized caller can never distinguish "exists" from "does not exist" in either tenant
via a 403/404 difference. Only a caller already proven to manage both tenants can learn
anything about either.

`assertPromotionContext()` is a separate, *mechanical* precondition, not an authorization
control: promotion must read and write across the tenant boundary, which — per §2 — requires the
tenant-scope extension to be in pass-through. The applications-layer mirror of that condition is
"CLS carries no pinned tenant **and** the actor is elevated". Checking it explicitly turns what
would otherwise be a raw `TenantScope: tenant context required` 500 (or, worse, a silent
empty-result 404) into a clear, actionable 403. Today `ELEVATED_ROLES` is `['GLOBAL_ADMIN']`, so
in practice both checks hold for the same actor; the manage-on-both check is nonetheless written
against per-tenant abilities so that D10's stated intent — a non-global admin who manages two
tenants — is already correct and already tested when the platform grows one.

Because the extension injects nothing in pass-through mode, **every repository call in this
service passes `tenantId` explicitly.** A missed filter here reads across all tenants, so this
is tested rather than assumed.

### 3.4 Promotion flow

```
 1  assertPromotionContext()                    → 403 (mechanical)
 2  assertManagesBothTenants(from, to)          → 403 (AC-2)
 3  load source agent  (explicit tenantId=from) → 404 if absent/foreign
 4  load source DepartmentAgentVersion          → 400 if the agent has none
 5  resolve target department by CODE, reuse-only → blocked, named reason
 6  compatibility gate (AC-6):
      target's servable ConsultationContextSchemaVersion must declare every
      subscribedKinds[].key and every writeScope.outputs[]  → blocked, named
 7  PRIMARY invariant in the target department  → blocked, named
 8  count target live consultations (RECORDING) → WARNING only (AC-7),
      and only when a previous version exists to complete on
 9  transaction:
      deep-copy each bound template into the target (SYSTEM ids kept as-is)
      create-or-update the target agent from the version snapshot
      write the target DepartmentAgentVersion
      write the immutable AgentPromotion row
10  broadcastSysEvent(ResourceCreated, AgentPromotion)
11  eval re-run at the TARGET (AC-4) — target agent's own goldenSetId, or the
      caller-supplied targetGoldenSetId validated to belong to the target;
      record evalRunId on the promotion. Never the source's golden set.
```

Step 9 is create-**or**-update on `(toTenantId, targetDepartmentId, slug)`: promoting into a
department that already runs that agent is a version bump, which is what makes step 8's "running
on the previous version" wording true.

**Why the eval is step 11 and not a pre-write gate.** The promoted configuration and the
target's corpus only coexist *in the target* after the copy; there is nothing to evaluate
before it. Blocking afterwards would mean retracting an immutable audit record, which the WORM
contract forbids. The pre-write gate that genuinely blocks is the context-kind compatibility
check (step 6). The eval result is recorded as an attestation on the promotion row — reused by
the console (TASK-667) and by whoever owns rollback policy. Stated here so it is a decision, not
a silence.

**Drift detection (AC-8).** The promotion row stores the promoted `checksum`. On read, the
service recomputes the target agent's *current* loop-config checksum and reports
`drifted: boolean` — "has the target been edited since it was promoted into?" — with no extra
storage and no background job.

### 3.5 File plan

| # | Layer | Files |
|---|---|---|
| 1 | Prisma | `department-agent.prisma` (+`AgentPromotion`); `audit.prisma` (`ResourceType += AgentPromotion`) |
| 2 | Migration | `<ts>_task_663_agent_promotion` |
| 3 | DB allow-lists | `tenant-scope.ts` `TENANT_SCOPED_MODELS`; `client.ts` `MODELS_WITHOUT_SOFT_DELETE`; the two inventory tripwire tests |
| 4 | Domain | `gen:model`; hand-authored `AgentPromotion{Entity,Factory,EntityMapper,Repository}`; `ResourceType.ts`; barrels ×4; `CoreDatabaseModule` |
| 5 | Applications | new `services/agentPromotion/` (service, module, token, DTO mapper, DTOs, barrel); `departmentAgent.service.ts` `clone()` gap fix |
| 6 | API | `apps/api/src/modules/agent-promotion/` (controller + module); `app.module.ts` |
| 7 | Tests | applications service tests, domains entity tests, api controller test, cross-tenant e2e spec |

### 3.6 TDD list (RED first)

| # | Test | AC |
|---|---|---|
| T1 | Promotion without manage rights on the **source** → 403; without manage on the **target** → 403; with both → proceeds | AC-2 |
| T2 | Authorization is evaluated **before** any agent read (an unauthorized caller gets 403 for a non-existent source id too — no existence oracle) | AC-2, C5 |
| T3 | **Regression** — a cross-tenant `DepartmentAgentService.getById` outside a promotion still returns **404**, not 403 | AC-10 |
| T4 | Target department missing a subscribed kind → blocked, reason names the missing key(s) | AC-6 |
| T5 | Target department missing a `writeScope` output → blocked, reason names it | AC-6 |
| T6 | Eval runs with `tenantId === toTenantId` and the **target's** golden set; the source's `goldenSetId` is never passed | AC-4 |
| T7 | **No `GoldenCase` row crosses**: the promoted target agent's `goldenSetId` is null/its own, never the source's; the service holds no golden-case dependency | AC-5 |
| T8 | The `AgentPromotion` record is immutable — no update path exists; a second promotion writes a **new** row | AC-1 |
| T9 | Live consultations on the target are unaffected and the response warning names the count with the exact wording | AC-7 |
| T10 | A promoted agent arrives with its loop configuration **intact** — all seven fields equal the source version's snapshot | AC-11, AC-3 |
| T11 | The promoted config comes from the immutable **version**, not the live source agent | AC-3 |
| T12 | Bound tenant-owned templates are deep-copied into the target; a SYSTEM-owned binding keeps its id | §3.1 |
| T13 | `clone()` carries the seven loop-config fields and forces `role = SPECIALIST` | AC-11 |
| T14 | Target department already has a PRIMARY and the promoted role is PRIMARY → blocked, named | §3.4 |
| T15 | Entity invariants: `tenantId === toTenantId`; required fields | AC-1 |
| T16 | Drift: an unedited target reports `drifted: false`; an edited one reports `true` | AC-8 |

---

## 4. Implementation Summary

**Status: Review.** All eleven acceptance criteria implemented and covered by tests; every gate
green, with the actual output pasted in §5.

### 4.1 Files changed

**Database (`packages/database/`)**

| File | Change |
|---|---|
| `src/prisma/db_main/department-agent.prisma` | **new** `AgentPromotion` model |
| `src/prisma/db_main/audit.prisma` | `ResourceType += AgentPromotion` |
| `src/prisma/db_main/migrations/20260812010000_task_663_agent_promotion/migration.sql` | **NEW** |
| `src/extensions/tenant-scope.ts` | `AgentPromotion` → `TENANT_SCOPED_MODELS` (75 → 76) |
| `src/client.ts` | `AgentPromotion` → `MODELS_WITHOUT_SOFT_DELETE` |
| `src/extensions/__tests__/tenant-scope.test.ts`, `src/__tests__/soft-delete-extension.test.ts` | inventory tripwires updated |

**Domain (`packages/domains/`)** — hand-authored `AgentPromotion{Entity,Factory,EntityMapper,Repository}`
following the `DepartmentAgentVersion*` immutable shape verbatim; `ResourceType.ts`; four barrels;
`CoreDatabaseModule` (provider **and** export); `gen:model` produced `AgentPromotionModel.ts`;
new `AgentPromotionEntity.test.ts`.

**Applications (`packages/applications/`)** — new `services/agentPromotion/` (service, module,
symbol token, DTO mapper, request/response DTOs, barrel, tests); `departmentAgent/constants.ts`
gains the shared snapshot/checksum helpers; `departmentAgent.service.ts` rewired to them and its
`clone()` gap closed; new `departmentAgent.task663.clone.test.ts`; services barrel.

**API (`apps/api/`)** — new `modules/agent-promotion/` (controller, module, tests); `app.module.ts`;
new cross-tenant e2e spec `tests/e2e/task-663-agent-promotion-cross-tenant.spec.ts`.

### 4.2 The migration

`20260812010000_task_663_agent_promotion` — additive only: one `ALTER TYPE ... ADD VALUE IF NOT
EXISTS` and one `CREATE TABLE` + 4 indexes. **No foreign keys**, deliberately (§3.2).

Produced with the execution-plan §1.1c shadow-DB recovery, since `pnpm db:migrate` is still broken
on `dev-2.1` (Prisma 7 removed `--skip-generate`) and the local dev DB is `db push`-managed with no
`_prisma_migrations` ledger. Two Prisma-7 flag changes worth recording for the next ticket:
`--to-schema-datamodel` is now `--to-schema`, and `--shadow-database-url` is no longer a CLI flag —
the shadow URL must come from `prisma.config.ts`. A **temporary** `shadowDatabaseUrl` line was added
there, fed from an env var, and reverted with `git checkout` immediately after each run; it is not
committed (verified with `git status`).

The first diff emitted exactly this ticket's statements plus four pre-existing TASK-648
`RenameIndex` drifts, which are not ours (the same four TASK-658 and TASK-659 both found). The
migration was written from that output minus those four, and the re-diff confirms it closes its own
diff — only the four TASK-648 renames remain. Full output in §5.

### 4.3 What promotion carries — and the TASK-659 gap

The design decision and its full carry/don't-carry table are in §3.1. The three points a reviewer
should check hardest:

1. **`goldenSetId` does not travel.** This is the strongest form of "the corpus never moves": not
   the cases, not the set, not even the *pointer*. `AgentPromotionService` has no `GoldenCase` or
   `GoldenSet` dependency at all, so there is no code path that could move one — the guarantee is
   structural, not merely untested. Three tests assert it, and mutating the service to copy the
   pointer fails all three, including the one proving the eval would then run against the **source**
   tenant's corpus.
2. **Bound templates are deep-copied.** A tenant-owned template id is unreadable in the target and
   would silently fall through the resolver. Dropping the bindings instead would land a promoted
   agent with part of its configuration missing — the exact failure this ticket exists to fix.
   SYSTEM-owned bindings keep their id, because `PromptTemplate` **is** in
   `SYSTEM_SHARED_READ_MODELS` and that reference is genuinely valid cross-tenant.
3. **`clone()` now carries the seven loop-config fields** and writes its own immutable version,
   with `role` forced to `SPECIALIST`. That exception needs no query to justify: a clone lands in
   the *same* department as its source, so a `PRIMARY` clone would violate the
   one-PRIMARY-per-department invariant by construction. Promotion has no such constraint (a
   different tenant's department may have no PRIMARY at all), so it carries `role` faithfully and
   validates it against the target. Reverting the fix fails four tests.

`AgentTemplateResyncService` is deliberately **not** changed — see OI-1 (§6) for the reasoning.

### 4.4 Decisions worth reviewing

| # | Decision | Reasoning |
|---|---|---|
| D-1 | `tenantId` IS `toTenantId`, enforced in `validate()` | The record is the TARGET's lineage and is read under the target's tenant scope. If the two could diverge, a row would be readable by one tenant while describing another's agent. |
| D-2 | No `@relation` on any of the four id columns | Two of them name rows in the SOURCE tenant; a relation would put a navigable path from a target-tenant row into another tenant's data on the model. The `tenantId` column's own no-FK convention is the precedent. |
| D-3 | `AgentPromotion` IS a `ResourceType` (unlike `DepartmentAgentVersion`) | It has a lifecycle of its own — one promotion is one event, not a side effect of another aggregate's write — and it crosses a tenant boundary. A privileged cross-tenant write is exactly what an auditor needs to enumerate. |
| D-4 | Authorization runs BEFORE any read | Otherwise the 403-vs-404 difference is an existence oracle over another tenant's agents. Reordering the two lines fails a test, and the e2e spec probes the same property on the wire with a real vs synthetic id. |
| D-5 | The elevated tenant-less check is a MECHANICAL precondition, not a second authorization control | With a pinned tenant the tenant-scope extension forces the caller's `tenantId` into every read, making a cross-tenant read impossible rather than unauthorized. Checking it explicitly converts a raw `TenantScope: …` 500 (or a silently empty 404) into a clear, actionable 403. The manage-on-both check is still written against per-tenant abilities, so D10's stated intent — a non-global admin managing two tenants — is already correct and already tested for when the platform grows one. |
| D-6 | The context-kind gate does NOT degrade when the schema repositories are unwired | TASK-659's create/update path degrades to a structural-only check via `@Optional()` deps. A cross-tenant privileged write must not, so those two repositories are REQUIRED here and the gate is unconditional. |
| D-7 | The eval runs AFTER the copy, and its result does not block | The promoted config and the target's corpus only coexist in the target once copied, so there is nothing to evaluate beforehand; and blocking afterwards would mean retracting an immutable audit record. The gate that genuinely blocks is the context-kind check. A failed or unreachable eval degrades to a recorded warning — a promotion is never lost to an eval problem. |
| D-8 | Two eval columns, never conflated | `evalRunId` is the run executed AT THE TARGET; `sourceEvalRunId` is the source attestation that travelled as evidence only. One column would quietly let a source result stand in for a target one, which is precisely what AC-4 forbids. |
| D-9 | `canonicalAgentConfigJson` / `buildLoopConfigSnapshot` hoisted into `constants.ts` | This codebase deliberately keeps such canonicalisers as separate per-file copies. Promotion breaks that: drift detection compares the checksum `DepartmentAgentService` wrote against the checksum `AgentPromotionService` wrote, so two implementations make the comparison wrong by construction. A correctness coupling, not a stylistic one. |
| D-10 | Promotion is create-**or**-update on `(toTenantId, targetDepartment, slug)` | Promoting into a department that already runs that agent is a version bump — which is what makes the live-consultation alert's "running on the previous version" wording true. A brand-new target agent gets no alert, because there is no previous version to complete on. |
| D-11 | Only SUCCESSFUL promotions are recorded | A blocked attempt throws and writes nothing. Recording attempts would be a different feature (an attempt log), and the audit row's value is that every entry describes something that actually happened. |

### 4.5 Known limitation — CLOSED by TASK-677 (2026-08-12)

> Retained as the historical analysis of the window. `Repository.update` gained an optional `tx`
> parameter, and the sequence below now runs inside one `runInTransaction`.

The write sequence — target agent → target version → promotion record — is **not** wrapped in a
transaction. `Repository.update` takes no `tx` parameter (only `create` does), so a
create-**or**-update path cannot be wrapped without a cross-cutting repository change that is out
of this ticket's scope. The ordering is chosen so the failure modes are safe: the promotion row is
written LAST, so a failure before it means no promotion is recorded — the audit row never claims
something that did not complete. The reverse window (agent advanced, record lost) is narrow and is
not untraceable: the target's own `DepartmentAgentVersion` and the sys-event on the agent are both
independent evidence of the change. Recorded as OI-2.

### 4.6 Must-not-change verification

- `resolveDepartmentAgent` (`prompt-resolution.service.ts`) — **not touched**.
- The five capability-keyed template bindings and `sessionAgentId` continuity — **not touched**.
- `SYSTEM_SHARED_READ_MODELS` — **not touched** (AC-9). `DepartmentAgent` remains invisible
  cross-tenant.
- `packages/agentic-sdk-v2/src/compat.ts` and `src/compat/**` — **not touched** (verified: `git
  diff --stat` across all four commits shows zero files under those paths).
- `apps/harness/**` — **not touched** (TASK-662 owns it, running in a parallel worktree).
- `pnpm gen:mapper` — **NEVER run**. The new mapper carries `FIELDS_NOT_WRITABLE = ['version']`
  by hand.
- The 404-over-403 posture on ordinary agent reads — regression-tested in
  `departmentAgent.task663.clone.test.ts`.

## 5. Verification Evidence

All commands run in the foreground from the worktree at `dev-2.1` @ `39f210ab7`, after
`pnpm install` and `pnpm db:generate`.

### Migration — shadow-DB diff, `db:push`, direct psql inspection

First diff (the committed ledger replayed against the target schema):

```
$ npx prisma migrate diff --from-migrations ./src/prisma/db_main/migrations \
    --to-schema ./src/prisma/db_main --script
-- AlterEnum
ALTER TYPE "core"."ResourceType" ADD VALUE 'AgentPromotion';
-- CreateTable
CREATE TABLE "core"."AgentPromotion" ( ... 18 columns ... );
-- CreateIndex ×4
-- RenameIndex ×4        (pre-existing TASK-648 drift, NOT this ticket's)
```

Re-diff after writing the migration — it closes its own diff exactly:

```
$ npx prisma migrate diff --from-migrations ... --to-schema ... --script
-- RenameIndex ×4        (the same pre-existing TASK-648 drift, unchanged)
```

Dev DB synced through its normal management path and inspected:

```
$ pnpm db:push                                    (ok)

$ psql -d hope -c '\d core."AgentPromotion"'
 tenantId | fromTenantId | toTenantId | agentVersionId | sourceAgentId |
 targetAgentId | targetAgentVersionId | configSnapshot | checksum |
 evalRunId | sourceEvalRunId | warnings | promotedBy | createdBy | createdAt
Indexes:
    "AgentPromotion_pkey" PRIMARY KEY, btree (id)
    "AgentPromotion_agentVersionId_idx" btree ("agentVersionId")
    "AgentPromotion_fromTenantId_idx" btree ("fromTenantId")
    "AgentPromotion_tenantId_idx" btree ("tenantId")
    "AgentPromotion_tenantId_targetAgentId_idx" btree ("tenantId", "targetAgentId")
(no Foreign-key constraints section — by design, §3.2)

$ psql -d hope -c 'select unnest(enum_range(NULL::core."ResourceType"))' | grep AgentPromotion
 AgentPromotion
(62 rows total)
```

### `pnpm --filter @arcaai/database build && test`

```
> tsc                                             (clean)

 Test Files  47 passed (47)
      Tests  1177 passed (1177)
```

Baseline **measured directly on a clean tree** (`git stash` → run → `git stash pop`): 1,171.
Delta +6, all six inside the two allow-list tripwire files, which parametrize over every
`tenantId`-bearing model parsed off the `.prisma` files on disk — confirmed by running those two
files alone: 281 → 287.

### `pnpm --filter @arcaai/domains build && test`

```
> tsc                                             (clean)

 Test Files  139 passed | 2 skipped (141)
      Tests  1586 passed | 2 skipped | 9 todo (1597)
```

Baseline 1,573. Delta **+13 = exactly the new `AgentPromotionEntity.test.ts` suite**. The
`resourceType.enum-parity` guard runs inside this suite and passes, proving the dual-file
`ResourceType` addition is in parity.

### `pnpm --filter @arcaai/applications build && test`

```
> rimraf dist tsconfig.tsbuildinfo && tsc         (clean)

 Test Files  468 passed | 1 skipped (469)
      Tests  8830 passed | 4 skipped (8834)
```

Baseline **measured directly on a clean tree**: **8,779** — note the 8,782 figure carried in the
ticket brief is 3 high (TASK-659's README reported the same kind of discrepancy against a
baseline taken on a different branch state). Delta **+51 = exactly the 43 new promotion tests plus
the 8 clone/posture tests**, with nothing unaccounted for.

### `pnpm api:build`

```
 Tasks:    9 successful, 9 total
```

### `pnpm test:unit` (whole monorepo, exit 0)

```
 Test Files  977 passed | 2 skipped (979)
      Tests  16641 passed | 8 skipped | 9 todo (16658)
packages/ui test:              Test Files  242 passed (242)   Tests   656 passed
packages/agentic-sdk-v2 test:  Test Files  255 passed (255)   Tests  4131 passed
apps/compat-playground test:   Test Files   21 passed  (21)   Tests   223 passed
apps/admin-console test:       Test Files  172 passed (172)   Tests  1339 passed
```

`+4` test files and `+76` tests over the ticket baseline, decomposing exactly as the per-package
runs above: database +6, domains +13, applications +51, apps/api +6.

> **Measurement trap worth recording.** A `git stash -u` taken partway through this ticket does
> NOT produce the ticket baseline, because the earlier commits are already in `HEAD` — it only
> removes the *uncommitted* work. That run reported 976/16,635, which is "everything committed so
> far minus the API layer", not the baseline, and would have understated the delta by a factor of
> twelve if reported as one. The per-package baselines above were each measured on a genuinely
> clean tree *before* their layer was committed, which is why they reconcile exactly.

Required build order followed (execution-plan §1.1b): `pnpm install` → `pnpm db:generate` →
`@arcaai/database` build → `@arcaai/domains` build → `@arcaai/applications` build →
`room`/`noise-filter`/`vad`/`stt`/`med-ner`/`vox`/`ui` build → `pnpm test:unit`. Skipping it
reproduced the documented false red twice (first ~119 files failing to load on an unbuilt
`@arcaai/database` dist, then on an unbuilt `@arcaai/exceptions`).

### `pnpm lint` (exit 0)

```
 Tasks:    31 successful, 31 total

@arcaai/api:lint:           ✖ 65 problems (0 errors, 65 warnings)
@arcaai/applications:lint:  ✖ 191 problems (0 errors, 191 warnings)
@arcaai/domains:lint:       ✖ 13 problems (0 errors, 13 warnings)
```

0 errors. The 65 `apps/api` warnings match the stated baseline exactly. **Zero warnings on any
file this ticket adds or touches** — verified by grepping the full lint log for every new/modified
filename and finding no matches. Three findings that DID land on this ticket's files (two prettier
errors in the controller, one prettier warning in the service) were fixed rather than left as
`only-warn` noise, per rule 01's "treat them as errors anyway".

### Generator drift (exit 0)

```
[Generate Data Model]  check: no drift — 157 generated file(s) match the committed files.
[Generate Data Entity] check: no drift — 91 generated file(s) match the committed files.
[Generate Data Entity] Schema coverage OK: 89 entity artifact(s) cover every persisted column of 93 Prisma model(s)
[generate-factory]     check: no drift — 91 generated file(s) match the committed files.
[generate-factory]     Schema coverage OK: 89 factory artifact(s) cover every persisted column of 93 Prisma model(s)
```

`pnpm gen:mapper` was **never run**.

### Tests proven to bite (mutation checks)

The service was written before its tests, so each load-bearing guarantee was verified by breaking
the code and confirming the suite fails:

| Mutation | Result |
|---|---|
| Move the manage-on-both check to run AFTER the source read | 1 failed — *"evaluates authorization BEFORE any read — an unauthorized caller gets no existence oracle"* |
| Copy `source.goldenSetId` onto the target agent | **3 failed** — the direct assertion, plus two downstream consequences including the eval then running against the source corpus |
| Restore the TASK-659 pre-fix `clone()` (drop the seven fields) | 4 failed — carries the six fields, forces SPECIALIST, writes a version, and the no-config regression |

### AC → test map

| AC | Test | File |
|---|---|---|
| AC-1 | Entity/factory invariants incl. `tenantId === toTenantId` and same-tenant refusal | `AgentPromotionEntity.test.ts` |
| AC-2 | 403 per side; both tenants checked; ordering before any read; elevated-context precondition | `agentPromotion.service.test.ts` |
| AC-3 | Copies the immutable VERSION, not the live row; explicit version number honoured | same |
| AC-4 | Eval runs with `tenantId === toTenantId` and the target's set; source run recorded as attestation only | same |
| AC-5 | goldenSetId never on the agent, never on the record, never evaluated against | same |
| AC-6 | Missing kind / missing output / no schema at all — each blocked with the key named | same |
| AC-7 | Count named, promotion completes, singular wording, no alert for a new agent | same |
| AC-8 | `drifted` false when unedited, true after an edit | same |
| AC-9 | `SYSTEM_SHARED_READ_MODELS` untouched (tripwire test asserts the set) | `tenant-scope.test.ts` |
| AC-10 | Cross-tenant `getById`/`clone` → 404; missing and foreign indistinguishable | `departmentAgent.task663.clone.test.ts` |
| AC-11 | Seven fields carried; role forced SPECIALIST; version written; no-config regression | same |
| — | WORM: no update/delete route; second promotion writes a second row | `agent-promotion.controller.test.ts`, `agentPromotion.service.test.ts` |

## 6. Open Items

- **OI-1** — `AgentTemplateResyncService` still does not propagate the seven TASK-659
  loop-config fields (§3.1). No present-day effect: every SYSTEM golden agent has all seven at
  their defaults today. If golden agents ever gain loop config, resync needs a per-tenant
  context-schema compatibility check rather than a copy — copying would push kind references into
  tenants whose schema does not declare them, manufacturing (unattended, nightly, across every
  tenant) exactly the broken state promotion blocks on. Carrying only the non-referencing subset
  would leave a half-configured agent, which is worse than none. **The console form (TASK-667) is
  the moment this becomes live** — it is the first surface that lets anyone configure a SYSTEM
  golden agent's loop fields.
- **OI-2** — ~~the promotion write sequence is not transactional~~ **CLOSED by TASK-677**
  (2026-08-12). `Repository.update` now takes an optional `tx`, so the create-**or**-update path is
  wrappable; the deep-copied templates, the target agent, its version row and the `AgentPromotion`
  record now commit inside one `runInTransaction`, and the sys-event moved to after the commit. The
  eval re-run and its `evalRunId` write stay outside by design (D-7). See
  `docs/implementation/TASK-677-Transactional-Write-Sequences/README.md`. §4.5 below is retained as
  the historical analysis of the window that existed.
- **OI-3** — the cross-tenant e2e spec is **authored but not executed**. `pnpm test:e2e` needs a
  live API on 8868 plus seeded test infra, which was not stood up in this worktree; the standing
  guidance is that only ONE API instance may serve e2e, and TASK-662 is running concurrently.
  Run it with `pnpm test:up:api` then `pnpm test:e2e` before merge.
- **OI-4** — `pnpm db:migrate` remains broken on `dev-2.1` (confirmed independently, third ticket
  running). Two ADDITIONAL Prisma-7 CLI changes were discovered here and are worth folding into
  execution-plan §1.1c so the next ticket does not rediscover them: `--to-schema-datamodel` is now
  `--to-schema`, and `--shadow-database-url` is no longer accepted as a flag — the shadow URL must
  be supplied through `prisma.config.ts`.

## Change History

- 2026-08-12 — Ticket opened from the TASK-654 execution-plan spec. Worktree reset from `dev`
  @ `180d09d6a` to `dev-2.1` @ `39f210ab7`; plan authored before any code.
- 2026-08-12 — Implemented in four staged commits: the plan (`cf6c75fc2`), the data model +
  domain layer (`5f77aac3e`), the promotion service + the TASK-659 `clone()` gap closure
  (`f80b7f004`), and the API surface (`60a347b4c`). All gates green with pasted output (§5);
  every load-bearing guarantee additionally verified by mutation (breaking the code and confirming
  the suite fails). Status **Review**. Not merged, not pushed, no MR opened.
