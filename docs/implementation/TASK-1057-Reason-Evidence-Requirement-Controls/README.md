# TASK-1057 — Reason / Evidence Requirement Controls

| Field | Value |
|---|---|
| Status | **Review** — merged on local `dev-2.2`, gates green, local e2e passed; NOT pushed / NOT deployed (awaiting owner) |
| Type | feature |
| Branch | `dev-2.2` |
| Rules | 00, 01, 04, 05, 09 (§Configuration Tiers), 13, 07/10/11 |

## 1. Requirement Analysis

1. Inventory every screen / route / action where a platform admin or tenant admin must supply a
   **reason, evidence, justification, typed confirmation or break-glass credential** before a change.
2. For each **kind** of request, give the platform admin a configuration surface to manage it
   (on/off), and the console must honour that configuration.
3. Prove it with a local e2e run before any push / cluster rollout.

## 2. Current State Evaluation (inventory — scouted 2026-10-09)

Paths: backend relative to repo root; console relative to `apps/admin-console/src`.

### 2.1 Kinds of request found

| Kind | Code | Where it is enforced today |
|---|---|---|
| Free-text reason (required) | `REASON` | server DTO/service (restore, promote) or server 409 (residency) |
| Free-text reason (optional) | `REASON` | DTO `@IsOptional()`; console renders an optional field |
| Evidence reference | `EVIDENCE` | consent record `evidenceRef` (optional) |
| Reason code (bounded slug) | `REASON_CODE` | billing adjustment (server) |
| Acknowledgement checkbox | `ACK` | context-schema publish (`acknowledgeImpact`, server 400), summary safety override |
| Typed confirmation (type the name) | `TYPE_CONFIRM` | **console only** (`shared/confirm/confirm-dialog.tsx` `typeToConfirm`) |
| Break-glass (password + typed name) | `BREAK_GLASS` | server `packages/applications/src/services/rbac/breakGlass.ts` + restore |
| Password step-up | `STEP_UP` | server (settings reveal / rotate) |

### 2.2 Required today

| # | Action | Route | Kind(s) | Server enforcement | Console | Audience |
|---|---|---|---|---|---|---|
| R1 | Restore tenant checkpoint | `POST admin/tenants/:tid/checkpoints/:id/restore` | REASON (10–1000) + BREAK_GLASS | `tenant-checkpoint.service.ts:572-580,652` | `features/tenant-checkpoints/components/restore-dialog.tsx:22,130` | tenant admin (+SA w/ working tenant) |
| R2 | Promote agent to SYSTEM | `POST admin/agents/promote-to-system` | REASON (`changeReason`, ≤500) | `promote-agent-to-system.dto.ts:36`, service `:248` | agents screen | super admin |
| R3 | Billing invoice adjustment | `POST admin/billing/invoices/:id/adjustments` | REASON_CODE | `add-adjustment.request.ts:11`, `billing.prisma:176` (NOT NULL) | billing | super admin |
| R4 | Delete role / detach policy / delete policy / edit multi-role policy rules | `DELETE admin/rbac/roles/:id`, `…/roles/:roleId/policies/:policyId`, `DELETE admin/rbac/policies/:id`, `PATCH admin/rbac/policies/:id` | BREAK_GLASS | `rbac/breakGlass.ts`, `role.service.ts:330,428`, `policies.controller.ts:127,148,156` | `shared/confirm/break-glass-dialog.tsx`; roles/policies screens | both |
| R5 | Reveal / rotate secret setting | `POST admin/settings/:id/reveal`, `/rotate` | STEP_UP | `globalSetting.service.ts` | `features/settings/components/setting-drawer.tsx:51,111` | both (SYSTEM tier SA only) |
| R6 | Residency load (force) / reload / unload of a live-path or pinned model | model-residency routes | REASON (when live-path/force) | `model-residency.service.ts:924,1579` (409 `LIVE_PATH_REASON_REQUIRED`) | `features/model-residency/components/{load-preview,reload-confirm,unload}-dialog.tsx` | super admin |
| R7 | Force-apply serving profile | inference-engines serving control | REASON (when force) | residency service (same path as R6) | `features/inference-engines/components/serving-profile-drawer.tsx:384` | super admin |
| R8 | Publish context schema with downstream impact | context-schema publish | ACK | 400 `SCHEMA_IMPACT_UNACKNOWLEDGED` | `features/context-schemas/components/publish-confirm-dialog.tsx` | tenant admin |
| R9 | 16 destructive deletes (tenant, user, API key, storage, object, knowledge doc, department, agent deprecate/delete, versioning dialogs, context schema, prompt template, document template, IdP, workflow, harness-ops action) | various DELETEs | TYPE_CONFIRM | **none — console only** | `ConfirmDialog typeToConfirm` call sites (list in §9) | both |

### 2.3 Optional today (field accepted, not required)

Impersonation `reason` (`impersonate.dto.ts:53`), prompt template approve `reason`, consent revoke
`reason` + record `evidenceRef`, agent / workflow assignment `reason`, harness policy `reason`,
agentic policy + live-engine kill-switch `reason`, guardrail availability `reason`, DNA settings /
report `changeReason`, agent sync `reason`, the `changeReason?` family on versioned content
(workflow promote/sync, node prompt binding, document template, context, summary, context schema,
prompt template), workflow review `comment`, invariant rule `rationale`.

Two console call sites send a **hard-coded** reason (no user input): AI-ops cancel
(`trajectory-timeline.tsx:100`), agent assignment set/remove (`agent-detail.tsx:483,997`).

### 2.4 Gaps

- **No toggle exists** for any of these — every rule is a code constant (`RESTORE_REASON_MIN/MAX`,
  `REASON_MIN=10` duplicated in the console).
- **No shared reason component** — R1, R6, R7 and the 10 optional fields are hand-rolled per feature.
- Console and server rules are duplicated and can disagree (restore min length lives in both).
- Natural home already exists: settings-registry descriptors + Feature Availability
  (`feature-availability.descriptors.ts`, `FeatureAvailabilityService`, `/features` matrix).

## 3. Implementation Plan (proposed — subject to the OD round)

### 3.1 Model: one catalogue, one policy per action

- **Catalogue** (code, like `ACTION_CATALOGUE`): `CONFIRMATION_ACTIONS` in `@arcaai/types` — one entry
  per action id (`tenantCheckpoint.restore`, `agent.promoteToSystem`, `rbac.role.delete`, …) with
  its kinds, audience, label, default policy, and which kinds are **locked** (cannot be turned off, OD-3).
- **Policy per (action, kind)** ∈ `off | optional | required` (OD-1), plus `minLength` for REASON.
- **Storage**: settings-registry descriptors in a new category **"Action Confirmations"**,
  `global-kv`, one key per action (`confirmation.<actionId>`, JSON value `{ reason, evidence, typeConfirm, … , minLength }`),
  `failMode: open-to-default` where the default is today's behaviour (so an absent row changes nothing).
  Scope per OD-2.
- **Resolver**: `ConfirmationPolicyService.resolve(actionId)` (tenant → SYSTEM per OD-2) and
  `assertSatisfied(actionId, dto)` → 400 `REASON_REQUIRED` / `EVIDENCE_REQUIRED` / 428 for break-glass.

### 3.2 Backend wiring

Replace each hard-coded check (R1, R2, R4, R5, R6, R7, R8) with `assertSatisfied`. Turn the optional
DTO fields in §2.3 into policy-driven (still `@IsOptional()` at the DTO, enforced in the service when
the policy says `required`). Billing reason code stays NOT NULL (OD-5). Audit events gain
`confirmationPolicy: { reason: 'required', … }` so the trail shows what was demanded (OD-4).

### 3.3 API

- `GET admin/settings/confirmations/effective` — every admin; the caller's effective policy map (console reads it).
- `GET` / `PUT admin/settings/confirmations` — platform admin; the catalogue + current values (If-Match).

### 3.4 Console

- New screen **`/action-confirmations`** (tier 10–19, nav "Governance → Action confirmations"): grouped
  by kind, one row per action, segmented control Off / Optional / Required, min length, lock icon on
  locked kinds, "Reset to default".
- Shared `useConfirmationPolicy(actionId)` hook + `ReasonField` and an extended `ConfirmDialog`
  (`reason` + `evidence` slots) so every dialog renders fields from policy, not constants.
- Migrate R1, R6, R7, R9 and the §2.3 dialogs to the shared pieces.

### 3.5 TDD test list

1. Resolver: absent row → catalogue default; SYSTEM row; tenant row (if OD-2 allows); locked kind ignores `off`.
2. `assertSatisfied`: required+missing → 400; minLength; optional passes; off ignores a supplied value? (keep it, audit it).
3. Each wired service: one test per action that flipping the policy changes the outcome.
4. Controller authz: matrix PUT super-admin-only (403), effective GET any admin.
5. Console: hook + `ReasonField` unit tests; screen tests; dialogs render/hide fields per policy.
6. e2e (`apps/api/tests/e2e/task-1057-*.spec.ts`): toggle restore reason off → restore without reason
   succeeds; on → 400; break-glass lock holds.
7. Console Playwright: toggle on `/action-confirmations`, observe the dialog change on `/checkpoints` and `/rbac/roles`.

### 3.6 Lanes (after go)

| Lane | Owns |
|---|---|
| L1 contract | `@arcaai/types` catalogue, descriptors, resolver, API controller + artifacts |
| L2 backend wiring | the R1–R8 services + optional-field services |
| L3 console | screen, hook, shared dialog pieces, migration of call sites |

Then orchestrator merge → gates → local e2e (ALaaS-free; local hope + console, logs + DB watched) →
report. Push + cluster rollout only on explicit owner instruction.

## 4. Owner Decisions (resolved 2026-10-09)

| # | Decision |
|---|---|
| OD-1 | Switchable **per domain operation** (one row per action, e.g. model residency load/unload, prompt template create/new version). Modes `required` / `not-required`; model-residency & LM Studio serving rows also keep `when-risky` (today's live-path / pinned / forced rule) as their default, so nothing changes until the platform admin flips them. |
| OD-2 | **Platform-only** (SYSTEM tier): `maxScope: 'system'`, `globalOnly: true`. No tenant override. |
| OD-3 | **Locked, never switchable**: break-glass (RBAC deletes/edits, checkpoint restore), **impersonation reason** (becomes REQUIRED — today it is optional; owner: "mandatory regardless"), password step-up (secret reveal/rotate), billing reason code. Shown read-only on the screen. |
| OD-4 | When off, the audit event MUST still record it: every confirmable action writes `confirmation: ActionConfirmationAuditStamp` (`note: "reason not required"` / `"reason required"`). |
| OD-5 | Billing reason code: locked (OD-3). |
| OD-6 | Typed-name confirmations stay **console-only**, governed by the same per-action setting. |
| OD-7 | One row per action, plus an "apply to all" per kind on the screen. |
| OD-8 | AI Operations cancel and agent-assignment set/remove get a real reason field when their row is `required`; otherwise they keep today's hard-coded text. |

Out of scope (clinical plane, not admin): consultation context / summary `changeReason`, summary
safety-override acknowledgement, feedback comments, harness internal escalation codes.

## 4b. Frozen contract (committed before fan-out)

| Artifact | Path |
|---|---|
| Catalogue, kinds, modes, audit stamp type, `CONFIRMATION_REQUIRED` | `packages/types/src/action-confirmations.ts` |
| One enum descriptor per unlocked row (`confirmation.<actionId>`, category "Action Confirmations") | `packages/applications/src/services/settings-registry/descriptors/action-confirmation.descriptors.ts` |
| `ActionConfirmationService` — `mode()`, `effective()`, `decide()`, `assert()` (exported by `EffectiveSettingsModule`) | `packages/applications/src/services/settings-registry/action-confirmation.service.ts` |
| Tests | `…/settings-registry/__tests__/action-confirmation.service.task1057.test.ts` |

Error contract: 400 `{ code: 'CONFIRMATION_REQUIRED', actionId, kind, minLength?, message }`.
Actions with their own refusal shape (residency 409 `LIVE_PATH_REASON_REQUIRED`, restore
`RESTORE_REASON_INVALID`, schema `SCHEMA_IMPACT_UNACKNOWLEDGED`) call `decide()` and keep their code.

## 4c. Lanes

| Lane | Tier | Owns |
|---|---|---|
| A — API + platform write | sonnet | `ActionConfirmationService` read/write extension, `settings-action-confirmations.controller.ts`, DTOs, artifacts (route manifest / openapi / portal / vox-node admin), e2e spec |
| B — backend wiring: agents, workflows, prompt templates, policies, content, consent | sonnet | the services of those rows (assert + stamp) |
| C — backend wiring: residency, LM Studio serving, checkpoint restore, impersonation, promote-to-system, schema ack, locked stamps | opus | those services |
| D — console screen + shared pieces | sonnet | `/action-confirmations` screen, nav, `useActionConfirmations` hook, `ReasonField`, `ConfirmDialog` policy wiring |
| E — console call sites | sonnet | every dialog in §2 + §9 reading the policy (after D's shared API is frozen in its brief) |

## 5. Implementation Summary

**What shipped (local `dev-2.2`, not pushed).**

- **Catalogue + policy** — `packages/types/src/action-confirmations.ts` (48 rows: 27 switchable reason/evidence/ack rows, 16 console-only typed-name rows, 5 locked rows), one SYSTEM-only enum setting per unlocked row (`confirmation.<actionId>`, category "Action Confirmations"), `ActionConfirmationService` (`mode` / `effective` / `decide` / `assert` / `readPlatform` / `applyPlatform`). Defaults = today's behaviour.
- **API** — `GET admin/settings/action-confirmations/effective` (every admin), `GET` / `PUT admin/settings/action-confirmations` (super admin, per-cell OCC, partial batch, `mode: null` = reset, idempotent).
- **Enforcement** — every unlocked server row asserts the policy before mutating and writes `confirmation: <stamp>` (incl. `note: "reason not required"`) on its audit / sys-event. Residency + LM Studio rows keep today's 409 shapes under `when-risky`; restore keeps `RESTORE_REASON_INVALID`; schema ack keeps `SCHEMA_IMPACT_UNACKNOWLEDGED`.
- **Locked** — impersonation reason is now REQUIRED on both routes (400 `CONFIRMATION_REQUIRED`); break-glass, secret step-up and billing reason code record a locked stamp.
- **New audit types** — `ResourceType.HarnessPolicy` / `HarnessLiveConfig` (migration `20261009210000_task_1057_resource_type_harness_audit`, two `ADD VALUE`s) so harness policy and live-engine switches write a forced audit event.
- **Console** — `/action-confirmations` (platform ops, tier 10–19, apply-to-all per kind, locked rows read-only); shared `useActionConfirmation` / `ReasonField` / policy-driven `ConfirmDialog`; ~40 dialogs wired; AI-ops cancel and agent assignments get a real field when required.

**Post-merge defects found by the gates / e2e and fixed** — a module import cycle (`GateEditMiningServiceModule` held an undefined import: workflow-assignment now provides the policy locally; global settings use a pure `lockedConfirmationStamp`); `ActionConfirmationService` DI failure in `GlobalSettingServiceModule` (write lane made optional); reset impossible (`@IsDefined` rejected `null`); re-setting the stored mode answered 400 "No changes" (now a no-op); impersonation START audit dropped the stamp; e2e spec lacked `If-Match`.

**Evidence (2026-10-10).** Gate pass after merge: types/domains/applications/api/console typecheck + lint green; tests — applications 18 858 passed, api 5 309, console 4 961, domains 2 093, types 240; `api:openapi:check`, `api:portal:check`, `vox-node gen:admin:check` green. Migration replayed on a shadow DB: `prisma migrate diff` → empty migration. API e2e (isolated gateway :8968 on throwaway Postgres :5533 / Redis :6480 — the standard test ports were held by the ALaaS e2e session): `task-1057-action-confirmations` 4/4, `user-impersonation` + `auth-advanced` all green. Console (browser, :5276 → :8968): switch a row to Required and save → the prompt-template editor shows `Change reason *`, Save disabled until a reason is typed, save succeeds; audit rows carry `reason required` / `reason not required`; Reset returns the row to `not-required`; the impersonate dialog requires a reason; no console errors.

**Known / out of scope.** `task-776-route-authz-matrix` A5b pins 42 public internal routes but the manifest has had 44 since before this ticket (`0af08501c`). After a reset the screen does not show the "Default" badge (the row persists with the default value). The local dev DB has unrelated `ConsultationStatus` drift, so the new enum values were applied there with `ALTER TYPE … ADD VALUE IF NOT EXISTS` rather than `db:push`. `AgentPromotion` entity still drops `metaData` (pre-existing; stamp is on the sys-event). Console surfaces absent for agent promote/sync, workflow promote/sync, review decide, invariant rules, DNA settings — server-enforced only.

## 6. Change History

| Date | Change |
|---|---|
| 2026-10-09 | Ticket opened; inventory scouted (backend + console); plan + OD round written |
| 2026-10-09 | Owner decisions recorded; contract frozen (catalogue, descriptors, service, tests) |
| 2026-10-10 | Lanes A, B1, B2, C, D, E1, E2, H merged; post-merge gate fixes; local e2e passed; status Review |

## 9. Appendix — TYPE_CONFIRM call sites

`features/tenants/components/tenant-lifecycle-dialogs.tsx:109`, `features/users/components/user-action-dialogs.tsx:202`,
`features/api-keys/components/api-keys-screen.tsx:410`, `features/storage/components/tenant-storage-screen.tsx:318`,
`features/storage-browser/components/object-actions-panel.tsx:112`, `features/knowledge/components/knowledge-documents-list.tsx:197`,
`features/departments/components/department-detail.tsx:423`, `features/agents/components/agent-deprecate-dialog.tsx:61`,
`features/agents/components/agent-detail.tsx:1207`, `shared/versioning/lifecycle-dialogs.tsx:162,207`,
`features/context-schemas/components/context-schema-detail-screen.tsx:368`, `features/prompt-templates/components/templates-tab.tsx:394`,
`features/document-templates/components/document-templates-list.tsx:160`, `features/identity-providers/components/identity-providers-screen.tsx:211`,
`features/workflow-studio/components/management/workflow-management-screen.tsx:619`, `features/harness-ops/components/workflow-detail-drawer.tsx:259`.
