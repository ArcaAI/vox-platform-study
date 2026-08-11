# TASK-663 — Agent Promotion Between Tenants

- **Status:** In Progress
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

_Pending — filled with pasted gate output on completion._

## 5. Verification Evidence

_Pending._

## 6. Open Items

- **OI-1** — `AgentTemplateResyncService` still does not propagate the seven TASK-659
  loop-config fields (§3.1). No present-day effect (every SYSTEM golden agent has them at
  defaults). If golden agents ever gain loop config, resync needs a per-tenant context-schema
  compatibility check — a copy would manufacture the broken state promotion blocks on.

## Change History

- 2026-08-12 — Ticket opened from the TASK-654 execution-plan spec. Worktree reset from `dev`
  @ `180d09d6a` to `dev-2.1` @ `39f210ab7`; plan authored before any code.
