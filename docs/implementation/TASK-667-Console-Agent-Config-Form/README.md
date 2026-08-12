# TASK-667 — Admin Console: Agent Configuration Form

- **Status:** Review
- **Type:** feature
- **Wave:** W4 of [TASK-654](../TASK-654-Consultation-Context-Schema-And-Configurable-Loop/README.md) — depends on TASK-659 (`DepartmentAgent` loop-config fields, merged)
- **Baseline:** `dev-2.1` @ `5a675d3d5` (`docs(TASK-654): harness baseline depends on .env.dev presence`)
- **Spec:** [execution-plan.md § TASK-667](../TASK-654-Consultation-Context-Schema-And-Configurable-Loop/execution-plan.md)

---

## 1. Requirement Analysis

**Objective.** Extend the existing Agent Catalog screen (`apps/admin-console/src/features/agents/**`,
`/agents` route) with a constrained goal/tool/guardrail authoring surface for the seven TASK-659
`DepartmentAgent` loop-configuration fields — **not** a rule builder, and **not** a free-text prompt
box (D8).

| # | Scope item | How it's covered |
|---|---|---|
| S1 | `role` (PRIMARY \| SPECIALIST), surfacing the one-PRIMARY-per-department invariant clearly | Role select + inline warning when another agent already holds PRIMARY in the department, computed client-side from the department's own agent list, before the server's 400 |
| S2 | `subscribedKinds` (+ optional filter) and `writeScope`, pickable from the tenant's resolved context schema | Checkbox pickers sourced from `GET tenant/me/context-schema?departmentId=`; a single structured `field = value` filter per subscribed kind (not free text) |
| S3 | Constrained goal fields, not free text | Length-capped objective (≤280) + up to 10 bounded success criteria (≤200 each), mirroring the server's `goalProblems` caps exactly |
| S4 | Tool allowlist; guardrail profile — closed catalogues, selected not authored | Tool allowlist = `toolConfig.tools` (TASK-635's 3-key closed catalogue: ner/vitals/groundedness); guardrail profile = the 3-entry `GUARDRAIL_PROFILE_KEYS` catalogue |
| S5 | `alwaysActions` / `neverActions` — the compliance envelope | Two-column checkbox table over the 7 `AGENT_ACTION_KEYS`, mutually exclusive by construction (checking one side unchecks the other) |
| S6 | Budgets are global-admin tier, rendered disabled for a tenant admin | `maxRegen`/`gateSlaSeconds`/`gateEscalationSeconds` subset of `harnessOverrides`, locked (disabled + "Global admins only" hint) unless `session.isElevated`, mirroring `TENANT_LOCKED_POLICY_KEYS` (`harness-policy/components/policy-fields.ts:45-54`) |
| S7 (C25) | Disabling a clinical check requires an explicit typed acknowledgement — a speed bump with a record, not a blocker | `ConfirmDialog` (existing shared component) with `typeToConfirm="WEAKEN"`, triggered when the pending save transitions `guardrailProfile` into `RELAXED` or newly forbids a clinical-safety action (`nlp.extract_entities`, `harness.finalize`) via `neverActions` |

### 1.1 Design constraints honored

- **D8 (constrained form, not free-text agent instructions).** Every field the form writes is
  either a checkbox pick from a closed catalogue/resolved schema, or a length-capped short string.
  There is no `<Textarea>` bound to anything resembling a system prompt; free-text prompt authoring
  stays exactly where TASK-659 left it — the approval-gated `PromptTemplate`, edited on the
  pre-existing **Settings** tab of this same drawer via `promptTemplateId`.
- **D11 (`always`/`never` as the compliance envelope, not a rule engine).** The form offers no
  conditions, no ordering, no boolean composition — just two flat, mutually-exclusive picks over the
  same 7-key catalogue the server's `AGENT_ACTION_KEYS` declares.

---

## 2. Current State Evaluation

Verified against `dev-2.1` @ `5a675d3d5` (TASK-659 and TASK-663 both merged into this baseline).

| Area | Finding |
|---|---|
| `DepartmentAgent` server surface | `DepartmentAgentResponse`/`CreateDepartmentAgentRequest`/`UpdateDepartmentAgentRequest` already carry all seven TASK-659 fields (`role`, `subscribedKinds`, `writeScope`, `goal`, `guardrailProfile`, `alwaysActions`, `neverActions`) plus the pre-existing `toolConfig`. Validators (`subscribedKindsProblems`, `writeScopeProblems`, `goalProblems`, `guardrailProfileProblems`, `actionListProblems`/`actionOverlapProblems`) and the cross-check against the resolved context schema (`resolveServableContextDefinition`, AC-4, fail-closed with no schema) live in `packages/applications/src/services/departmentAgent/{constants,departmentAgent.service}.ts`. |
| Admin console `DepartmentAgent` wire types | `apps/admin-console/src/features/agents/api/types.ts` had **none** of the seven fields (nor `toolConfig`) declared — the console had not yet caught up to TASK-659's server surface. |
| Existing screen | `agent-detail-drawer.tsx` hosts one `DetailDrawer` with three tabs (Settings / Version / History) over `admin/department-agents`. `SettingsForm` edits `name`/`promptTemplateId`/`dnaStylePolicy`/`goldenSetId` with OCC `If-Match`. No structured UI existed for `harnessOverrides` or `toolConfig` on this resource at all. |
| Resolved context schema read | `GET tenant/me/context-schema?departmentId=` (TASK-658, `MyTenantContextSchemaController`) already serves the RESOLVED, PINNED `ConsultationContextSchemaBundleResponse` — `definition.kinds[]`/`definition.outputs[]`, each `{key,label,primitive,...}` — exactly the shape a picker needs, and exactly what the server's own AC-4 cross-check reads. A tenant with nothing configured gets `definition: null` (200, not 404) — the "fail closed" state this ticket's pickers must render explicitly, not silently. |
| Precedent for locked/disabled fields | `features/harness-policy/components/policy-fields.ts` (`TENANT_LOCKED_POLICY_KEYS`, `LOCKED_FIELD_HINT`) + `harness-policy-form.tsx` — a `lockedKeys` set renders inputs `disabled` with a "Global admins only" hint and excludes locked keys from the sparse patch. Mirrored here for Budgets. |
| Precedent for typed acknowledgement | `@/shared/confirm/confirm-dialog.tsx` (`ConfirmDialog`) already supports `typeToConfirm` — an exact-phrase gate on the confirm button. Reused as-is for C25 rather than hand-rolling a new dialog. |
| PRIMARY invariant | `DepartmentAgentRepository.findPrimaryForDepartment` + `assertSinglePrimaryPerDepartment` (service-side) throw `BadRequestException` naming the conflicting agent's slug. No console-side precomputation existed; a save attempt would previously fail with an unexplained 400. |

---

## 3. Implementation Plan

### 3.1 API layer (`features/agents/api/`)

- `types.ts`: add `DepartmentAgentRole`, `GuardrailProfile`, `AgentActionKey` union types and the
  `AgentSubscribedKinds`/`AgentWriteScope`/`AgentGoal`/`AgentToolConfig` JSONB shapes; extend
  `DepartmentAgent`/`CreateDepartmentAgentRequest`/`UpdateDepartmentAgentRequest` with the seven
  fields + `toolConfig`; add the read-only `ResolvedContextSchemaBundle`/`ResolvedContextEntry`
  projection of `ConsultationContextSchemaBundleResponse`.
- `client.ts`: add `getResolvedContextSchema(departmentId?)` → `GET tenant/me/context-schema`.
  Existing OCC `updateDepartmentAgent`/`getDepartmentAgent` (client.ts:~181-193) **untouched**.
- `keys.ts`: add `departmentAgentKeys.contextSchema(departmentId)`.
- `hooks.ts`: add `useResolvedContextSchema(departmentId)`.

### 3.2 Pure logic (`components/agent-loop-config-fields.ts`)

Client-side mirrors of the server allow-lists (never imported — the console cannot import a server
package) plus pure builders/parsers, so every guarantee is unit-testable without a DOM:

- Catalogue mirrors: `AGENT_ACTION_KEYS`(+labels), `GUARDRAIL_PROFILE_KEYS`(+labels),
  `LIVE_TOOL_KEYS`(+labels), `AGENT_ROLE_OPTIONS`, `AGENT_BUDGET_FIELDS`, `CLINICAL_CHECK_ACTIONS`.
- Validators mirroring `goalProblems`: `goalObjectiveProblem`, `goalSuccessCriterionProblem`.
- `actionOverlap` mirroring `actionOverlapProblems`.
- `weakensClinicalCheck` — the C25 trigger (see §3.4).
- Payload builders (`buildSubscribedKindsPayload`, `buildWriteScopePayload`, `buildGoalPayload`,
  `buildToolConfigPayload`, `buildBudgetsHarnessOverridesPayload`) and hydration parsers
  (`parseSubscribedKinds`, `parseWriteScope`, `parseGoal`, `parseToolConfig`) — defensive, degrade to
  an empty selection on a malformed/legacy shape rather than throwing.

### 3.3 UI (`components/agent-loop-config-tab.tsx`)

A fourth `DetailDrawer` tab ("Loop config"), self-contained like the existing `SettingsForm` —
its own `useSession`/`useResolvedContextSchema`/`useDepartmentAgents` reads. Seven `Card` sections
(Role, Subscribed kinds, Write scope, Goal, Tool allowlist, Guardrail profile, Compliance envelope,
Budgets — eight cards; Role and Budgets are separately load-bearing). `AgentRoleBadge` (exported from
the same file) surfaces a "Primary" badge on the drawer header and the Agent Catalog list rows.

### 3.4 The C25 acknowledgement flow

`weakensClinicalCheck({ currentGuardrailProfile, nextGuardrailProfile, currentNeverActions,
nextNeverActions })` returns human-readable reasons (empty ⇒ none) for two triggers grounded in what
this ticket's seven fields can actually express:

1. `guardrailProfile` transitions **into** `RELAXED` (the weakest catalogue entry) from anything
   else. D9 places the actual enforcement boundary outside the agent's reasoning path, but
   *selecting* the weaker profile is still the tenant admin's act, and is exactly what §4.6 of the
   parent ticket names.
2. A clinical-safety action (`nlp.extract_entities`, `harness.finalize`) is **newly** added to
   `neverActions` — forbidding it disables that check outright. An action already forbidden before
   this edit is not re-flagged (no re-acknowledgement noise on an unrelated save).

On submit, if `weakensClinicalCheck` returns any reasons, the PATCH is **not** sent — a `ConfirmDialog`
opens instead, listing the reasons, with `typeToConfirm="WEAKEN"` arming the confirm button. Only on
confirm does the PATCH fire.

### 3.5 TDD list (RED first)

| # | Test | Where |
|---|---|---|
| T1 | Every catalogue mirror matches the server's allow-list membership (order-independent) | `agent-loop-config-fields.test.ts` |
| T2 | `goalObjectiveProblem`/`goalSuccessCriterionProblem` enforce the 280/200-char caps | same |
| T3 | `actionOverlap` names every action present in both lists | same |
| T4 | `weakensClinicalCheck`: flags RELAXED transition, does not flag staying on RELAXED or tightening (STANDARD→STRICT), flags newly-forbidding `nlp.extract_entities`/`harness.finalize`, does not flag a non-clinical action or an already-forbidden one | same |
| T5 | Payload builders round-trip (kinds/outputs/goal/toolConfig/budgets-merge) | same |
| T6 | Hydration parsers round-trip a well-formed payload and degrade a malformed one | same |
| T7 | `subscribedKinds`/`writeScope` pickers offer ONLY keys the resolved schema declares | `agent-loop-config-tab.test.tsx` |
| T8 | Fail-closed messaging + no pickable kinds when the department has no resolved schema | same |
| T9 | Budgets locked (disabled + hint) for a non-elevated caller; the PATCH omits `harnessOverrides` entirely when nothing elevated-editable changed | same |
| T10 | An elevated (global admin) caller can edit Budgets; the PATCH merges them into existing `harnessOverrides` without dropping other keys | same |
| T11 | PRIMARY conflict warning renders inline when picking PRIMARY while another agent already holds it | same |
| T12 | C25: the dialog blocks the save on a RELAXED transition; wrong text keeps Confirm disabled; the exact phrase arms it; the PATCH carries the weakened value only after confirmation | same |
| T13 | No acknowledgement dialog for a non-weakening change (e.g. STANDARD→STRICT) | same |
| T14 | axe: 0 violations, light and dark themes | same |

---

## 4. Implementation Summary

**Status: Review.** All scope items (§1) implemented and covered by tests; every gate green.

### 4.1 Files changed

| File | Change |
|---|---|
| `apps/admin-console/src/features/agents/api/types.ts` | +7 TASK-659 fields, `toolConfig`, new union/shape types, `ResolvedContextSchemaBundle` projection |
| `apps/admin-console/src/features/agents/api/client.ts` | +`getResolvedContextSchema` |
| `apps/admin-console/src/features/agents/api/keys.ts` | +`departmentAgentKeys.contextSchema` |
| `apps/admin-console/src/features/agents/api/hooks.ts` | +`useResolvedContextSchema` |
| `apps/admin-console/src/features/agents/components/agent-loop-config-fields.ts` | **NEW** — pure catalogues/validators/builders/parsers |
| `apps/admin-console/src/features/agents/components/agent-loop-config-tab.tsx` | **NEW** — the Loop config tab + `AgentRoleBadge` |
| `apps/admin-console/src/features/agents/components/agent-detail-drawer.tsx` | +"Loop config" tab (4th tab), `AgentRoleBadge` in the header badges, `templateLocked` read-only guard mirrors `SettingsForm` |
| `apps/admin-console/src/features/agents/components/agents-tab.tsx` | +`AgentRoleBadge` on catalog list rows |
| `apps/admin-console/src/features/agents/components/__tests__/agent-loop-config-fields.test.ts` | **NEW** — 31 tests |
| `apps/admin-console/src/features/agents/components/__tests__/agent-loop-config-tab.test.tsx` | **NEW** — 10 tests |

`nav-config.ts` was **not touched** — this ticket extends the existing `/agents` screen, it does not
add a route (TASK-666, running concurrently, owns the new context-schema screen and its own
`nav-config.ts` line).

### 4.2 How the constrained goal form avoids becoming a prompt box

The form writes exactly one free-text-shaped value: the `objective` field, capped at 280 characters
via both a `maxLength` HTML attribute and the mirrored `goalObjectiveProblem` validator, plus up to
10 `successCriteria` capped at 200 characters each. There is no larger text area, no markdown/rich
text, no variable interpolation, and nothing rendered as a prompt preview. The section's own hint
text states the boundary explicitly: *"A short objective plus success checks — not a system prompt.
Free-text prompt authoring stays on the Agent Template."* — and the Agent Template binding
(`promptTemplateId`) remains on the pre-existing Settings tab, one drawer over, completely untouched
by this ticket.

### 4.3 How `subscribedKinds`/`writeScope` are sourced from the schema

`GET tenant/me/context-schema?departmentId=<agent.departmentId>` (TASK-658, unmodified) is the sole
source of truth for both pickers. The form renders ONE checkbox per `definition.kinds[]`/
`definition.outputs[]` entry the resolved bundle returns — never a free-text key input. When the
bundle's `definition` is `null` (no context schema configured, or none servable for this
department), the pickers render zero checkboxes and an explicit fail-closed message rather than
silently accepting nothing — matching the server's own AC-4 posture ("naming a kind with the schema
plane unwired/unresolvable fails closed"). This is proven directly: T7 asserts only the two schema-
declared kinds render as checkboxes (and an out-of-schema key never does); T8 asserts zero kind/output
checkboxes and the fail-closed message when `definition` is `null`.

The optional per-kind `filter` is a single structured `field = value` pair (two small text inputs),
not a JSON/free-text box — the server places no closed catalogue on filter *values* (they are
data-dependent), so this is the form's own constrained-but-necessarily-open leaf; the *keys* being
filtered on remain closed-catalogue picks.

### 4.4 How global-only Budgets are locked

`AGENT_BUDGET_FIELDS` (`maxRegen`, `gateSlaSeconds`, `gateEscalationSeconds` — the `harnessOverrides`
subset that reads like "Generation"/"Clinician gate" budgets on the global Harness Policy screen)
renders as three `Input type="number"` fields, `disabled` unless `useSession().data?.isElevated` is
true, with the `LOCKED_FIELD_HINT` ("Global admins only") text shown underneath — the exact UX
`TENANT_LOCKED_POLICY_KEYS` already establishes for a **different** resource
(`harness-policy/components/policy-fields.ts:45-54`). When the caller is not elevated, the save
patch omits `harnessOverrides` entirely (T9); when elevated, an edit is merged into the agent's
*existing* `harnessOverrides` object so the three fields this form does not render (the five sensor
thresholds, `toolAllowlist`) are never clobbered (T10).

**Decision worth flagging for review.** Server-side, `DepartmentAgent.harnessOverrides` validation
(`validateHarnessOverrides` / `TENANT_TIER_HARNESS_OVERRIDE_KEYS`) does **not** distinguish caller
role for these three keys — a tenant admin's PATCH carrying `maxRegen`/`gateSlaSeconds`/
`gateEscalationSeconds` on their own tenant's agent is accepted today. This ticket's brief names
Budgets as "global-admin-tier" and directs the `TENANT_LOCKED_POLICY_KEYS` precedent explicitly, so
the console renders them locked for a non-elevated caller as a **defense-in-depth / intentional UX
choice** ahead of any server-side tightening, not because the API itself currently enforces the
split on this resource. If the intended server behavior is genuinely a hard 403 for tenant admins on
these three keys, that is a `packages/applications` change **out of this ticket's console-only
scope** — flagged here rather than silently left inconsistent.

### 4.5 The C25 acknowledgement flow

Full flow in §3.4. The "record" half of *"a speed bump with a record, not a blocker"* is **not**
reinvented here: TASK-659's `writeLoopConfigVersionIfNeeded` already writes an immutable
`DepartmentAgentVersion` snapshot (checksum, key-sorted canonical JSON) on every loop-config-affecting
`create`/`update`, unconditionally, whenever the resulting config differs from the last recorded
snapshot — which a save that changes `guardrailProfile` or `neverActions` always does. This ticket's
`ConfirmDialog` is the **speed bump**: it stops the save from firing until the caller has read the
named reasons and typed `WEAKEN`. No new backend surface was added or needed — `UpdateDepartmentAgentRequest`
has no `changeReason`/acknowledgement field to thread through (unlike `HarnessPolicyChange`'s optional
`reason`), so the record is the resulting `DepartmentAgentVersion` row itself, not a freestanding
acknowledgement log. A console-facing viewer for that version history is **not** part of this
ticket's scope (no such endpoint exists yet — TASK-663 confirmed the console promotion screen is the
first surface expected to need one) and is flagged as a natural follow-up rather than built here.

### 4.6 Must-not-change verification

- `features/agents/api/client.ts`'s existing OCC `If-Match` handling (`getDepartmentAgent`,
  `updateDepartmentAgent`, lines ~181-193) — **untouched**; the new `getResolvedContextSchema` is a
  plain unauthenticated-relative-to-OCC `GET`, added after it.
- `SettingsForm`/`PinControl`/`VersionsPanel` (Settings/Version/History tabs) — **untouched**.
- `nav-config.ts` — **not touched** (this ticket extends an existing route).
- `packages/agentic-sdk-v2/**`, `apps/harness/**` — **not touched**.
- `features/harness-policy/**` — **not touched**; only its `TENANT_LOCKED_POLICY_KEYS`/
  `LOCKED_FIELD_HINT` UX pattern was mirrored (re-declared locally per rule 13's "features never
  import each other").

---

## 5. Verification Evidence

All commands run from the worktree at `dev-2.1` @ `5a675d3d5`, after `pnpm install` and building the
`@arcaai/admin-console` dependency chain (`npx turbo build --filter=@arcaai/admin-console^...` —
`@arcaai/room`, `@arcaai/stt`, `@arcaai/ui`, `@arcaai/vox` + their own deps).

### `pnpm --filter @arcaai/admin-console build`

```
✓ Compiled successfully in 11.9s
  Running TypeScript ...
  Finished TypeScript in 8.6s ...
  Collecting page data using 15 workers ...
✓ Generating static pages using 15 workers (74/74) in 912ms
  Finalizing page optimization ...
```

(The only warnings printed are pre-existing Edge-Runtime notices from `instrumentation.ts`,
unrelated to and untouched by this ticket.)

### `pnpm --filter @arcaai/admin-console lint`

```
> eslint src --max-warnings 0
```

Exit 0 — zero errors, zero warnings (one `no-unused-vars` finding on a since-removed test helper was
caught and fixed during development, not left as `only-warn` noise).

### `pnpm --filter @arcaai/admin-console test`

```
 Test Files  174 passed (174)
      Tests  1380 passed (1380)
```

Baseline (stated in the ticket brief, confirmed by a clean-tree run before any change): **172 files /
1,339 tests**. Delta: **+2 files / +41 tests** — exactly
`agent-loop-config-fields.test.ts` (31 tests) + `agent-loop-config-tab.test.tsx` (10 tests, including
the two axe scans). Zero failures, zero skipped, no other file's test count moved.

### `pnpm typecheck` (admin-console)

```
> tsc --noEmit
```

Exit 0, clean.

### axe scan (definition-of-done gate, rule 12 §2.3)

Both `agent-loop-config-tab.test.tsx` cases — light theme and `document.documentElement.classList.add('dark')`
— assert `expect(await axe(container)).toHaveNoViolations()` on the fully-hydrated Loop config tab
(role select, subscribed-kinds/write-scope checkboxes with an active filter row, goal fields, tool
allowlist, guardrail profile select, the compliance-envelope table, and the budgets grid). Both pass.

### Both-theme verification

Covered by the light/dark axe pair above (structural + contrast-relevant a11y checks run against the
real `.dark` class toggle used everywhere else in the console, e.g.
`features/harness-ops/components/__tests__/edit-burden-card.test.tsx`). A live-browser visual pass
against a running `next dev` + seeded backend was **not** performed in this session — no backend/DB
was stood up in this worktree (console-only scope, no `.env.dev`) — flagged as an open item (§6).

### Specific required tests

| Requirement | Test |
|---|---|
| A tenant admin cannot set a global-only field | `locks the Budgets fields for a non-elevated (tenant admin) caller...` + `a tenant admin cannot change Budgets — the PATCH omits harnessOverrides entirely` |
| The C25 acknowledgement is required and recorded | `requires the C25 typed acknowledgement before saving a transition to the RELAXED guardrail profile, and records it in the PATCH` (+ the negative case, `does NOT require acknowledgement...`) |
| `subscribedKinds` offers only kinds from the resolved schema | `offers subscribed-kind and write-scope checkboxes ONLY for keys declared in the resolved context schema` + `renders a fail-closed message and no pickable kinds when the department has no resolved schema` |

---

## 6. Open Items

- **OI-1** — No live-browser (real `next dev` + seeded backend) visual pass was performed; jsdom +
  axe cover structure/contrast-relevant semantics but not true rendered layout in either theme. Run
  the `next-dev-loop` skill against a seeded tenant admin + global admin session before shipping to
  confirm layout, focus order, and the dialog's visual placement.
- **OI-2** — ~~§4.4's flagged decision~~ **Resolved by TASK-678**: Budgets were tenant-tier by
  design all along (`TENANT_TIER_HARNESS_OVERRIDE_KEYS`, TASK-546/550) — the console lock was
  based on the wrong precedent (`TENANT_LOCKED_POLICY_KEYS`, which governs a different key set on
  the `HarnessPolicy` resource). The lock has been removed; the server was never changed.
- **OI-3** — No console surface exists yet to view a `DepartmentAgentVersion` history (the C25
  "record"); flagged as a natural follow-up once a versions-list endpoint exists (none does today —
  confirmed by grep across `apps/api/src/modules/**`).
- **OI-4** — `alwaysActions`/`neverActions` and the tool allowlist round-trip through this form
  always write an EXPLICIT full state (all 7 action keys accounted for by inclusion/omission, all 3
  tools set to an explicit `enabled: true/false`) rather than expressing `toolConfig`'s tri-state
  `enabled: null` ("follow the platform default"). A scoped simplification, not a defect — the form
  never claims to express "no opinion" for a tool the admin has touched at all; recorded here in case
  a future ticket wants the tri-state exposed.

## Change History

- 2026-08-12 — Ticket implemented from the TASK-654 execution-plan §TASK-667 spec, against the
  merged TASK-659 baseline. Pure-logic layer (`agent-loop-config-fields.ts`) TDD'd first (31 tests),
  then the Loop config tab UI + drawer wiring, then the 10 integration tests (schema-sourced pickers,
  locked budgets, the C25 acknowledgement gate, the PRIMARY conflict warning, both-theme axe). All
  gates green (§5). Status **Review**. Not merged, not pushed, no MR opened.
