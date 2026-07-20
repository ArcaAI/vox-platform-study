# TASK-532 — Governance Tightening & Console IA Cleanup

- **Status**: Pending
- **Type**: feature (E3 governance locks) / refactor (console IA)
- **Program**: Phase 5 of the [2026-07-20 agentic platform program plan](../SOTA-Track/2026-07-20-agentic-platform-program-plan.md) (§4 Phase 5, AD-7); findings source: [2026-07-20 review findings](../SOTA-Track/2026-07-20-agentic-platform-review-findings.md) (E3-L1/L2, E3-D1, GAP-G1/G2, M-01…M-14)
- **Ticket number**: suggested by the program plan (TASK-523…534 block). Highest allocated number is TASK-534 (sibling docs exist for 524/525/526/528/529/531/534) — **confirm at open time** per the CLAUDE.md ticket workflow.
- **Size**: L · **Lanes**: B (applications + api) + C (admin-console)
- **Dependencies**: **TASK-523** (P0 comment/copy sweep D-16…D-18, D-21 — the stale "tenants may override" copy must be gone before this ticket changes the semantics again) · **TASK-524** (the AD-1 descriptor-driven enforcement point; see §3.1 fallback if 524 has not landed)
- **Owner decisions recorded** (program plan §8): **OD-2 default adopted — lock all five toggles to global-admin** (`safetyEnabled`, `phiEnabled`, `phiFailClosed`, `pipeline.harnessEnabled`, `pipeline.autoNerEnabled`); **OD-6 default adopted — fold `/prompt-studio` into `/agents` + redirect**. Both are owner-confirmable at plan approval; a reversal shrinks work-stream A/B respectively without restructuring the ticket.
- **Design-gate preconditions (rule 12 — blocking for the affected screens only)**: the **AI Services panel** (new screen) and the **merged policy editor / demoted harness-policy tabs** (changed screens) each need an approved Figma frame **or a recorded owner waiver** (frame inventory or waiver text + date recorded in this README) before their screen code is written. Precedent: the TASK-512 wave ran on an explicit waiver (plan §2.3). Non-visual work (service locks, RBAC subjects, seed, decorator swaps, rules-doc edits) is never design-gated.

---

## 1. Requirement Analysis

### 1.1 E3 strict reading (owner expectation: "guardrail and nlp services controlled ONLY by global admins")

Model *selection* already conforms (findings §3-E3): all `guardrail.*`/`nlp.*`/`smr.*`/`harness.*` task keys are global-admin-only via `GLOBAL_ADMIN_ONLY_TASK_PREFIXES` (`packages/applications/src/services/ai-task-default/constants.ts:64`, enforced `ai-task-default.service.ts:98-100`, unit-tested). What does **not** conform under a strict reading are the **on/off switches**:

- **E3-L1** — `HarnessPolicy.safetyEnabled` / `phiEnabled` / `phiFailClosed` are tenant-admin-writable: a tenant admin can switch off the guardrail safety gate and the PHI fail-closed posture for their tenant.
- **E3-L2** — `PipelinePolicy.autoNerEnabled` / `harnessEnabled` are tenant/department-writable with **no privilege check at all**: a tenant admin can disable NLP auto-extraction or the whole harness (guardrail's primary caller).

**Flag for the owner (OD-2)**: these are per-tenant *feature toggles*, not model control. Locking them **escalates previously-tenant-writable capability to global-only** — tenants that rely on flipping them lose a capability (see §7 Risks). This ticket adopts the plan default (lock all five) and records it here; the owner confirms or narrows at approval.

### 1.2 E7 console IA (route/interface alignment)

The M-register items this ticket executes: **M-02** (duplicate global-policy/live-config editors), **M-03/OD-6** (prompt governance split across `/agents` and `/prompt-studio`), **M-08** (`/prompt-studio` vs `/pstudio` naming collision), **M-09** (four backend admin surfaces with zero console screen), **M-12** (borrowed `HarnessPolicy` RBAC subject on mcp/trajectory controllers), **M-13** (undecorated-looking approve route + read-declared write routes), **M-01/M-14** (rules 12/13 tier-taxonomy drift).

### 1.3 Closure map and split with sibling tickets

| ID | Closed by | Notes |
|---|---|---|
| GAP-G1 (E3-L1/L2) | **this ticket** (work-stream A) | OD-2 default |
| GAP-G2 (doc drift + RBAC) | **this ticket** (M-12, M-13) + TASK-523 (D-16…D-18 copy) | 523 owns the copy sweep; this ticket owns RBAC + marker comments |
| M-01, M-14 | **this ticket** (rules 12/13 edits) | |
| M-02, M-03, M-08, M-09, M-12, M-13 | **this ticket** | |
| M-04 | **partial** — tenant leg (`/ai-model-defaults` → `/ai-configuration`) is TASK-526; `/ai-models` unhide is TASK-528; **this ticket** finishes the platform-screen file-name alignment (§4 B-7) | split stated per plan §4-P5 |
| M-05, M-11 | TASK-526 (tenant "AI Configuration" screen) | not this ticket |
| M-06, M-07, M-10 | TASK-523 (D-16/D-17/D-14) | not this ticket |

---

## 2. Current State Evaluation (code-verified 2026-07-20, working tree on `fix/2605-review`)

### 2.1 E3-L1 — the harness-policy lock list and assert mechanics

- `packages/applications/src/services/harness-policy/harness-policy.service.ts:102-114` — `GLOBAL_ADMIN_ONLY_POLICY_KEYS` currently holds 11 keys: `safetyProvider`, `safetyModel`, `smrProvider`, `smrModel`, `optimisticDeliveryEnabled`, `atomicFactEnabled`, `retrievalEnabled`, `warmStartEnabled`, `nerPriorsEnabled`, `maxEditReruns`, `regenFeedbackEnabled` (`as const satisfies readonly (keyof HarnessPolicyKnobs)[]`). **`safetyEnabled`/`phiEnabled`/`phiFailClosed` are absent** — the comment at `:98-100` even documents "Tenant admins may still patch … PHI toggles" as intended.
- Enforcement mechanics (all in place, list-driven — the fix is *only* extending the list):
  - Tenant PATCH: `updatePolicy` (`:364-369`) → `assertNoGlobalAdminOnlyPolicyWrites` (`:375-381`) throws `ForbiddenException` listing offending keys when any listed key is present in the DTO. Global PATCH (`updateGlobalDefault` `:384-386`) bypasses the assert.
  - Runtime overlay: `getEffectivePolicy` (`:255-261`) overwrites every listed key on a tenant-row response with the SYSTEM row's value — so **extending the list instantly neutralizes pre-existing tenant-row values at runtime** (grandfathered values are ignored, not deleted).
- DTO fields exist and stay: `dto/update-harness-policy.request.ts:55,60,65` (`safetyEnabled?`, `phiEnabled?`, `phiFailClosed?`) — needed by the global editor.
- Controller: `apps/api/src/modules/harness-admin/harness-admin.controller.ts:79-103` (`PATCH admin/harness/policy`, `@Authorize(['manage','HarnessPolicy'])` + OCC) and `:115+` (`PATCH policy/global`, `assertPlatform()` at `:136`; reads at `:111`).
- Test anchor: `packages/applications/src/services/harness-policy/__tests__/harness-policy.service.test.ts:411` already asserts `ForbiddenException` for the existing locked keys — extend the same spec family.

### 2.2 E3-L2 — the missing pipeline-policy privilege check

- `packages/applications/src/services/pipeline-policy/pipeline-policy.service.ts:163-256` (`upsertRow`) performs exactly ONE guard: `assertWithinMaxScope` (`:173`, impl `:404-412`) — a **scope-depth clamp** (e.g. `harnessEnabled` cannot pin at DOCTOR), **not a privilege check**. `WRITABLE_TOGGLE_KEYS` (`:31`) = `autoSummaryEnabled`, `autoNerEnabled`, `harnessEnabled`. No `isSuperAdmin`, no `ForbiddenException` import, no descriptor `globalOnly` read anywhere in the file.
- Write route: `apps/api/src/modules/pipeline-policy-admin/pipeline-policy-admin.controller.ts:85-86` — `PUT admin/pipeline-policy/row` gated `@Authorize(['manage','PipelinePolicy'])`, which tenant admins hold (`packages/database/src/prisma/db_main/seed/01-policy.ts:157` in `tenant-full-access`, `:446` in `harness-tenant-manage`).
- Descriptors: `packages/applications/src/services/settings-registry/descriptors/pipeline.descriptors.ts:34-45` generates the four `pipeline.*` descriptors by mapping over the config-resolver's `PIPELINE_SETTING_DESCRIPTORS` — **no `globalOnly` field is set on any of them** (the `SettingDescriptor` type supports it: `registry.types.ts:52` `globalOnly?: boolean`). Note the clamp the service applies reads the **config-resolver** descriptor map directly (`pipeline-policy.service.ts:16,407`), not the registry mirror — two descriptor sources for the same keys.
- TASK-524 §3.3 step 5 explicitly leaves `db-config`-tier writes to "their dedicated services (pipeline-policy, tts-config) until those adopt the enforcement point (TASK-532)" — **this ticket is that adoption for pipeline-policy**.

### 2.3 M-12 — borrowed RBAC subject (verified per controller)

- `apps/api/src/modules/mcp-admin/mcp-admin.controller.ts` — reads `@CanRead('HarnessPolicy')` (`:42`, `:57`), writes `@CanManage('HarnessPolicy')` (`:68` create, `:84` patch, delete below); writes are additionally global-only via a service-level 403 (comment `:24-26` correctly frames it as "privilege boundary; NOT the 404-over-403 tenancy posture").
- `apps/api/src/modules/agent-trajectory/agent-trajectory.controller.ts:34` — class-level `@CanManage('HarnessPolicy')` on a **read-only** controller; the header comment (`:20-24`) self-flags the dedicated `AgentTrajectory` ResourceType as deferred.
- `apps/api/src/modules/agentic-admin/agentic-admin.controller.ts:34` — `GET admin/agentic/instructions` also uses `@CanManage('HarnessPolicy')`; **deliberately kept** (the instructions document IS a harness-policy aggregate — resolved thresholds + prompt tier), documented in §4 A-3.
- Enum/subject facts: CASL subjects in policy rules are free strings (seed JSON), but the audit `ResourceType` Prisma enum (`packages/database/src/prisma/db_main/audit.prisma:104`) **already contains `McpServer`** (appended with the MCP registry) and **does NOT contain `AgentTrajectory`**. The trajectory controller is read-only and broadcasts no mutation sys-events → **no enum migration is required** (documented decision, §3.2).
- Seed grants today: `manage:HarnessPolicy` in `tenant-full-access` (`01-policy.ts:147`), `harness-platform-manage` (`:418`, unconditional) and `harness-tenant-manage` (`:439`) is what currently lets tenant admins read the MCP registry and their own trajectories. Seed tests asserting these policies: `packages/database/src/__tests__/seed.test.ts:327-390`.

### 2.4 M-02 — duplicate editors (component overlap)

Both screens edit the SAME two backend rows (`PATCH admin/harness/policy/global`, `admin/harness/live/config`):

- `apps/admin-console/src/features/agentic-policy/components/agentic-policy-screen.tsx` — tier 10-19, elevated-gated up front (`:92-102`), tabs `policy | engine | context` (`:19`), `GlobalPolicyTab` (`:39-68`) + `LiveEngineTab` + read-only `AgenticContextTab`.
- `apps/admin-console/src/features/harness-policy/components/harness-policy-screen.tsx` — tier 30-49, `WorkingTenantGate`d, tabs `policy | live | global` (`:32`), elevated-only triggers/panels (`:260-262`, `:277-286`), `GlobalDefaultTab` (`:196-228`) re-mounting the same `HarnessPolicyForm` against `policy/global`, `LiveConfigTab` (`live-config-tab.tsx`) duplicating the engine kill-switch editor.
- The duplication is self-acknowledged: `features/agentic-policy/api/types.ts:2-9` ("these deliberately duplicate the harness-policy feature's overlapping types" — rule 13, features never import each other).
- Tenant editor detail that intersects work-stream A: `features/harness-policy/components/policy-fields.ts:38-40` renders `safetyEnabled`/`phiEnabled`/`phiFailClosed` as editable switches in the tenant tab; `harness-policy-form.tsx:84-85` builds a **sparse patch** (only dirty fields sent), so untouched saves survive the new lock, but flipping a locked switch would 403 at save — the tenant form must render them disabled (§4 A-1c).

### 2.5 M-03 — prompt governance split

- `/agents` (tier 30-49): `features/agents/` — full tenant CRUD on `admin/prompt-templates` (`api/client.ts:30`), **already has** versions list/read, server-side diff, and version-activate (`client.ts:59-76`); screen `agents-screen.tsx:321-333` wraps `WorkingTenantGate`, no tabs today.
- `/prompt-studio` (tier 10-19, nav-config.ts:138): `features/prompt-studio/` — same `admin/prompt-templates` base (`api/client.ts:13`), adds only the **approve** OCC write (`client.ts:40-41` → `POST :id/approve` with If-Match) + a governance list + `versions-panel.tsx`; screen `prompt-studio-screen.tsx:264` also wraps `WorkingTenantGate` (`:270` — the M-01 "global tier, per-tenant data" case), approve panel at `:140-190`.
- Routes: `src/app/(console)/(global)/prompt-studio/{page,loading}.tsx`; `(tenant)/agents/{page,loading}.tsx`. The `(global)` group layout 404s non-elevated sessions (`(global)/layout.tsx:9-14`).

### 2.6 M-08 — `/pstudio`

- Nav entry `nav-config.ts:152` (label "Prisma Studio", `IconDatabaseSearch`, tier 10-19, `manage:all`); route `(global)/pstudio/{page,loading}.tsx`; feature `features/pstudio/` (`api/client.ts:5` → `GET admin/pstudio/status`; `components/pstudio-screen.tsx:21` iframes `/api/hope/admin/pstudio`). The **gateway** module `apps/api/src/modules/pstudio/` and its `admin/pstudio` paths are NOT renamed (backend untouched — console naming only).

### 2.7 M-09 — unused backend surfaces + exact response shapes

Zero console references exist to any of these (grep-verified: no `ai-services`, `edit-burden`, `golden-sets`, `agentic/instructions` hits under `apps/admin-console/src`):

- `apps/api/src/modules/ai-service-admin/ai-service-admin.controller.ts:21-51` — class `@Authorize(['manage','all'])`, three GETs: `admin/ai-services/guardrail/status` (upstream guardrail `GET /api/health` **proxied verbatim** — `Record<string, unknown>`: engine/GLiNER/Redis component checks), `admin/ai-services/guardrail/config` (`GuardrailConfigResult` = `{ medicalValidation, analysisTypes }`, both upstream-owned `Record<string, unknown>` — `ai-service-proxy.client.ts:16-22`), `admin/ai-services/nlp/status` (upstream NLP `GET /api/v1/health` verbatim: per-model component checks). Error contract: upstream HTTP passes through, transport failure → 503 (`ai-service-proxy.client.ts:36-41`). Shapes are upstream-owned → the panel renders **defensively** (status badges where recognizable + key/value fallback), never re-validates.
- `apps/api/src/modules/agentic-admin/agentic-admin.controller.ts:33-60` — `GET admin/agentic/instructions?tenantId&departmentId&promptType` → `AgenticInstructionsResponse` (resolved prompt tier, vendored PDSQI judge pin version/hash, sensor thresholds, safety criteria). Tenant-scoped read; global admins target `?tenantId=` (elevated working-tenant fallback), foreign tenantId → 404.
- `apps/api/src/modules/harness-admin/harness-admin.controller.ts:198-288` — 5 golden-set routes (`GET golden-sets`, `GET golden-sets/:id`, `GET golden-sets/:id/cases` — PHI-safe metadata only, encrypted payloads never surfaced — `POST golden-sets`, `POST golden-sets/:id/cases`), gated `read`/`manage` on `HarnessEval`; `:304-322` — `GET edit-burden?consultationId` (`@Authorize(['manage','HarnessPolicy'])`) → `EditBurdenResponse` derived scalars (edit distance, deferral, time-to-sign), 404 for absent/cross-tenant consultation.
- Natural console home for the tenant-tier pair: `features/harness-ops/components/harness-observability-screen.tsx:135-148` (audit + evals + gate queue, `WorkingTenantGate`; client base `api/client.ts:21` `admin/harness`).

### 2.8 M-13 — auth-decorator readability

- `apps/api/src/modules/prompt-management/prompt-management.controller.ts` — class-level `@Authorize(['manage','PromptTemplate'])` (`:43`); `POST :id/approve` (`:326+`) carries **no handler-level permission decorator** — the GLOBAL_ADMIN 403 is imperative in the service (`isSuperAdmin`), already explained in the long comment `:314-325`. The boot-time route audit passes (class decorator covers it); the M-13 defect is *readability*, fixed with a standardized marker + a rule 05 note.
- `apps/api/src/modules/prompt-management/prompt-template.controller.ts:79-88` (`POST` createPersonal), `:90-119` (`PATCH :id` updatePersonal), and the delete below all declare `@Authorize(['read','PromptTemplate'])` on **write** routes. Review verdict: **deliberate** — these are clinician self-service routes for USER_PERSONAL prompts; `read` is the "can use prompts at all" ability and OWNERSHIP is enforced in the service (non-owned → 403, cross-tenant → 404, per the Swagger text `:96-99`). Changing the decorator to `create/update:PromptTemplate` would break clinicians (they hold read only). Action: document intent (marker comments), not change decorators.

### 2.9 M-01/M-14 — rules drift + nav entries

- M-01: three `(global)` screens wrap `WorkingTenantGate`: `prompt-studio-screen.tsx:270`, `ai-operations-runs-screen.tsx:56`, `ai-operations-metrics-screen.tsx:148`. After M-03 retires prompt-studio, the sub-pattern remains real for the two ai-operations screens → document it, don't "fix" it.
- M-14: `.claude/rules/12-design-workflow.md` §3 still shows tier 50-59 as "*(reserved)* Playground — deferred to TASK-420" (stale — 5 playground screens shipped, nested under `(console)/(tenant)` with a nav-level role check, `nav-config.ts:332-349,352-355`); `.claude/rules/13-nextjs-apps.md` Routing documents only three route groups (no 50-59 row, no sub-pattern).
- Nav config: `apps/admin-console/src/shared/navigation/nav-config.ts` — entries this ticket changes: `:138` (`/prompt-studio` — REMOVE), `:152` (`/pstudio` — RENAME `/db-studio`, label "Database Studio"), plus ONE NEW tier-10-19 entry `/ai-services`. Tests: `__tests__/nav-config.test.ts` asserts total 43 / 17 in tier 10-19 (`:19-24`), route uniqueness (`:48-52`), icon uniqueness (`:74-79`), implemented-set equality (`:107-111`). Net tier-10-19 count stays 17 (−prompt-studio, +ai-services); total stays 43. **Shared-file caution**: TASK-526 (row 12/13 of its file table) and TASK-528 (rows 16/17) also edit `nav-config.ts` + its test — sequence these three tickets on this file (plan §2.3 exclusive-ownership rule; append/rebase discipline like the barrel rule).

---

## 3. Architecture, Patterns & Best Practices

### 3.1 Descriptor metadata as the single enforcement point (AD-1)

The pipeline-policy lock is enforced FROM descriptor metadata, not a new hand-rolled key list: `pipeline.harnessEnabled` and `pipeline.autoNerEnabled` descriptors gain `globalOnly: true`, and `PipelinePolicyService.upsertRow` gains `assertGlobalOnlyToggles(dto)` that resolves each supplied toggle's registry descriptor and throws `ForbiddenException` for non-elevated callers when `globalOnly` is set. Preferred: call TASK-524's exported enforcement helper (its write-lane §3.3 step 3 is the same check); **fallback if 524 has not landed**: implement the assert locally against `HOPE_SETTINGS_REGISTRY.getOrThrow('pipeline.<key>')` — same metadata, same semantics, converges when 524 lands (the plan's "use or mirror" instruction). `maxScope` values stay untouched (the cascade shape is unchanged; only WHO may write changes). The harness-policy lock stays list-driven (`GLOBAL_ADMIN_ONLY_POLICY_KEYS`) — that list is the established, tested mechanism for HarnessPolicy and already feeds both the write assert and the runtime SYSTEM overlay; migrating it to descriptors is out of scope.

### 3.2 403 vs 404, and dedicated RBAC resources with additive grandfathering

- The new locks are **ROLE checks on same-tenant writes** → `ForbiddenException` (403) is correct, exactly like `GLOBAL_ADMIN_ONLY_TASK_PREFIXES` (`ai-task-default.service.ts:98-100`) and the MCP write path (`mcp-admin.controller.ts:24-26`: "privilege boundary; NOT the 404-over-403 tenancy posture"). Cross-tenant reads/writes keep returning 404 everywhere — no change to that posture.
- M-12 subjects: mcp-admin reads → `@CanRead('McpServer')`, writes → `@CanManage('McpServer')` (service-level global-only 403 unchanged — defense in depth); agent-trajectory class → `@CanRead('AgentTrajectory')` (read-only controller; `CanManage` was borrowed overkill). `agentic-admin` keeps `@CanManage('HarnessPolicy')` — the instructions doc is a policy aggregate; noted in its header comment.
- **Additive grandfathering** (no one loses access): seed adds tenant-scoped `manage:McpServer` + `read:AgentTrajectory` to `tenant-full-access` and `harness-tenant-manage`, and unconditional `manage:McpServer` + `read:AgentTrajectory` to `harness-platform-manage`; `manage:all` already covers global admins. Existing **custom** DB policies that granted `manage:HarnessPolicy` to reach mcp/trajectory will lose that side door — release-note + operator action (§7), deliberately NOT auto-migrated.
- No Prisma enum migration: `McpServer` already exists in `ResourceType` (`audit.prisma:104` block); `AgentTrajectory` is not needed there (read-only surface, no audit `resourceType` emissions). If a later ticket adds trajectory mutations, the append-only ADD VALUE migration happens then.

### 3.3 IA principles

- **One authoritative editor per backend resource** (M-02): `/agentic-policy` (tier 10-19) owns editing `policy/global` + `live/config`; `/harness/policy` keeps the tenant editor and demotes its Global/Live tabs to read-only summaries with a deep link (`/agentic-policy?tab=policy`, `?tab=engine`). Rule 13 feature isolation holds: the read-only summary is built inside `features/harness-policy` (no cross-feature import); deep links are plain hrefs.
- **Redirect discipline**: retired/renamed routes keep a `redirect()` page for one release (plan §7; TASK-526 file-table row 11 precedent): `/prompt-studio` → `/agents?tab=governance`, `/pstudio` → `/db-studio`. Note the tier shift on prompt governance is behavior-neutral: `/prompt-studio` already required a working tenant (`WorkingTenantGate`, M-01), and `/agents` gates identically; approve authority stays server-side (global-only 403 in the service) — the console only hides the Governance tab from non-elevated sessions (elevated-tab precedent: `harness-policy-screen.tsx:260-286`).
- **Boot audit**: this ticket adds NO new gateway routes (all M-09 backends exist); decorator swaps keep every route decorated, so the deny-by-default boot audit stays green. New console routes are Next.js pages under the `(global)`/`(tenant)` group layouts (tier guards inherited).
- Console quality bars per rules 10/11/13: skeleton loading states shaped like content, axe 0 violations, both themes, `ScreenTemplate` + `TabsList variant="line"`, EmptyState/ErrorState, TanStack Query via the BFF proxy.

---

## 4. Implementation Plan

Two independently reviewable work-streams. Order within each stream is binding; the streams may run in parallel (disjoint files except `nav-config.ts`/test, which only stream B touches).

### Work-stream A — E3 governance locks + RBAC (lanes B; no design gate)

| # | Step | Files |
|---|---|---|
| A-1a | Extend `GLOBAL_ADMIN_ONLY_POLICY_KEYS` with `safetyEnabled`, `phiEnabled`, `phiFailClosed`; rewrite the `:98-100` comment (tenant admins may patch clinical thresholds ONLY); note in the service header that the SYSTEM overlay (`:255-261`) now also governs the three toggles | UPDATE `packages/applications/src/services/harness-policy/harness-policy.service.ts` |
| A-1b | Extend the service tests (§5 T-1); update any fixture asserting tenant-editable safety/PHI | UPDATE `…/harness-policy/__tests__/harness-policy.service.test.ts` |
| A-1c | Console: tenant policy editor renders the three locked switches disabled with a "Global admins only" hint (new `lockedKeys` prop on `HarnessPolicyForm`; the global tab passes none). The sparse-patch builder (`:84-85`) already protects untouched saves | UPDATE `apps/admin-console/src/features/harness-policy/components/{policy-fields.ts,harness-policy-form.tsx}` + tests |
| A-2a | Add `globalOnly: true` to the `pipeline.harnessEnabled` + `pipeline.autoNerEnabled` registry descriptors (per-key metadata record in the mapping; `autoSummaryEnabled`/`dnaStyleEnabled` untouched) | UPDATE `packages/applications/src/services/settings-registry/descriptors/pipeline.descriptors.ts` |
| A-2b | `PipelinePolicyService.upsertRow`: new `assertGlobalOnlyToggles(dto)` before `assertWithinMaxScope` — descriptor-driven 403 for non-elevated callers (524 helper or local mirror, §3.1); needs `ClsService` user read (`isSuperAdmin` from `common/tenant-guards`) | UPDATE `packages/applications/src/services/pipeline-policy/pipeline-policy.service.ts` |
| A-2c | Service tests (§5 T-2); Swagger on `PUT admin/pipeline-policy/row` gains the 403 response row | UPDATE `…/pipeline-policy/__tests__/pipeline-policy.service.test.ts`, `apps/api/src/modules/pipeline-policy-admin/pipeline-policy-admin.controller.ts` (docs only) |
| A-2d | Console: pipeline-policy screen disables the two locked toggles for non-elevated sessions (hint + docs link); existing pinned rows still display (read side unchanged) | UPDATE `apps/admin-console/src/features/pipeline-policy/components/{pipeline-policy-screen.tsx,scope-row-editor.tsx}` + tests |
| A-3a | Decorator swaps: mcp-admin `HarnessPolicy`→`McpServer` (reads `:42,:57`; writes `:68,:84`, delete); agent-trajectory class `@CanManage('HarnessPolicy')`→`@CanRead('AgentTrajectory')` (`:34`); rewrite both header comments (the "deferred" note at `agent-trajectory.controller.ts:20-24` dies); agentic-admin comment states why it deliberately keeps `HarnessPolicy` | UPDATE `apps/api/src/modules/mcp-admin/mcp-admin.controller.ts`, `…/agent-trajectory/agent-trajectory.controller.ts`, `…/agentic-admin/agentic-admin.controller.ts` (comment only) |
| A-3b | Seed grants (additive, §3.2): `tenant-full-access` + `harness-tenant-manage` gain tenant-scoped `manage:McpServer` + `read:AgentTrajectory`; `harness-platform-manage` gains both unconditional; comments cite this ticket | UPDATE `packages/database/src/prisma/db_main/seed/01-policy.ts` |
| A-3c | Seed tests same MR (plan §5 rule 7): extend the `:327-390` harness-policy spec family with the new subjects | UPDATE `packages/database/src/__tests__/seed.test.ts` |
| A-4 | M-13 markers: standardized `// AUTH-NOTE(TASK-532):` comments on `prompt-management.controller.ts:314+` (imperative global-admin approve) and the three read-declared personal-CRUD routes in `prompt-template.controller.ts` (deliberate: ownership enforced in service); rule 05 gains a short "imperative privilege checks" paragraph naming both patterns | UPDATE both controllers (comments), `.claude/rules/05-nestjs-api.md` |

### Work-stream B — Console IA (lane C + rules docs; design gate on B-2/B-4 screens)

| # | Step | Files |
|---|---|---|
| B-1 | **M-02**: demote `/harness/policy` Global + Live tabs → read-only summary cards (reuse `SettingsComparisonGrid`/`EffectiveResolveCard` style) + deep-link buttons to `/agentic-policy?tab=policy|engine` (elevated-only, as today `:260-262`); delete `GlobalDefaultTab`'s form mount (`:196-228`) and the editing half of `live-config-tab.tsx`; tenant tab untouched (bar A-1c) | UPDATE `apps/admin-console/src/features/harness-policy/components/{harness-policy-screen.tsx,live-config-tab.tsx}` + tests |
| B-2 | **M-03/OD-6**: `/agents` gains an elevated-only "Governance" tab (`Tabs` wrapper per the harness-policy precedent): template governance list + versions/diff (client already has them, `client.ts:59-76`) + approve panel with OCC. Components MOVED from `features/prompt-studio` into `features/agents` (rule 13 — no cross-feature import); `approveTemplate` client ported (`prompt-studio/api/client.ts:40-41`). Then retire the route: `(global)/prompt-studio/page.tsx` → `redirect('/agents?tab=governance')` (loading.tsx deleted; keep one release); delete `features/prompt-studio` once moved | UPDATE `features/agents/{api,components}/**`; NEW `features/agents/components/governance-tab.tsx` (+ moved panels); UPDATE `(global)/prompt-studio/page.tsx` (redirect); DELETE `features/prompt-studio/**`, `(global)/prompt-studio/loading.tsx` |
| B-3 | **M-08**: rename route folder `(global)/pstudio` → `(global)/db-studio`; old path becomes `redirect('/db-studio')`; feature folder `features/pstudio` → `features/db-studio` (`db-studio-screen.tsx`, label/title "Database Studio"); gateway `admin/pstudio` paths and iframe src untouched (comment states the split) | RENAME/NEW/UPDATE per above |
| B-4 | **M-09 global**: NEW `(global)/ai-services` route + `features/ai-services` — tabs "Guardrail" / "NLP" / "Instructions": guardrail status+config (two queries, status badges + defensive key-value rendering, upstream-shape warning in comments), NLP per-model status, agentic-instructions viewer (working-tenant-scoped read of `admin/agentic/instructions`; this screen is a documented instance of the M-01 sub-pattern). Skeleton/empty/error states, axe, both themes | NEW `features/ai-services/{api/{client,hooks,keys,types}.ts,components/{ai-services-screen.tsx,guardrail-panel.tsx,nlp-panel.tsx,instructions-panel.tsx}}` + `__tests__`; NEW `(global)/ai-services/{page,loading}.tsx` |
| B-5 | **M-09 tenant**: harness observability gains `GoldenSetsPanel` (sets list → detail sheet: PHI-safe case metadata; create set/case behind `manage:HarnessEval`) + `EditBurdenCard` (consultationId lookup → derived scalars); client adds the 6 routes (§2.7) | UPDATE `features/harness-ops/api/{client,hooks,keys,types}.ts`, `components/harness-observability-screen.tsx`; NEW `components/{golden-sets-panel.tsx,edit-burden-card.tsx}` + tests |
| B-6 | **Nav-config** (exact entries): REMOVE `:138` `/prompt-studio`; UPDATE `:152` → `{ route: '/db-studio', label: 'Database Studio', icon: IconDatabaseSearch }`; ADD `/ai-services` `{ tier: '10-19', label: 'AI services', icon: IconServerCog (unique), required: [['manage','all']], implemented: true }`; update the tier 10-19 header comment. Test updates per §5 T-6 | UPDATE `apps/admin-console/src/shared/navigation/nav-config.ts`, `__tests__/nav-config.test.ts` |
| B-7 | **M-04 remainder**: align the platform feature file name — `features/ai-task-defaults/components/ai-task-defaults-platform-screen.tsx` stays; the tenant-screen rename is TASK-526's (do NOT touch `ai-model-defaults-tenant-screen.tsx` here if 526 is in flight — coordinate) | UPDATE (rename only if 526 landed) |
| B-8 | **M-01/M-14 rules docs**: rule 13 Routing — add the 50-59 row (`(tenant)`-nested, role-gated nav) + the "global-admin-only, per-tenant-data" sub-pattern ((global) screen wrapping `WorkingTenantGate`; instances: `/ai-operations/*`, `/ai-services` Instructions tab); rule 12 §3 — replace the stale "(reserved) … deferred to TASK-420" 50-59 row with the shipped state; changelog entries in both | UPDATE `.claude/rules/13-nextjs-apps.md`, `.claude/rules/12-design-workflow.md` |

**Ownership manifest (exclusive)**: everything in the two file tables above, plus this README. Explicitly NOT owned: `nav-config.ts:311-322` + tenant screen files (TASK-526), `/ai-models` nav flip + `features/ai-models/**` (TASK-528), `admin/pstudio` gateway module, `ai-task-defaults-platform-screen.tsx` copy (TASK-523 D-16), settings write-lane files (TASK-524), MCP enable-path DTO/service/UI (TASK-533-A D-24).

**Comment deltas (binding)**: `harness-policy.service.ts:98-100`; `agent-trajectory.controller.ts:16-30`; `mcp-admin.controller.ts:15-30`; `agentic-admin.controller.ts` header; `pipeline-policy.service.ts` header (+ new assert docstring); the two M-13 `AUTH-NOTE`s; `db-studio` screen header (gateway path unchanged); rules 05/12/13; `docs/traceability-matrix.md` rows for the moved/renamed/new routes.

**Out of scope**: tenant AI-configuration screen + `/ai-model-defaults` rename (TASK-526); `/ai-models` hub + unhide (TASK-528); pipeline/tts `db-config` writes migrating onto the literal write-lane route (532 adopts the enforcement *check*, not the route); guardrail/NLP mutation routes (none exist upstream — deliberately not invented, `ai-service-admin.controller.ts:14-17`); e2e execution (authored here where new, executed in TASK-534).

---

## 5. TDD Plan (RED first — paste failing output in §9 before implementing)

| # | Test (exact path) | RED assertion |
|---|---|---|
| T-1 | `packages/applications/src/services/harness-policy/__tests__/harness-policy.service.test.ts` | tenant `updatePolicy({ safetyEnabled: false })` → `ForbiddenException` naming the key (same for `phiEnabled`, `phiFailClosed`; anchor `:411`); `updateGlobalDefault` still accepts all three; **overlay**: tenant row `safetyEnabled:false` + SYSTEM `true` → `getEffectivePolicy` returns `true` |
| T-2 | `packages/applications/src/services/pipeline-policy/__tests__/pipeline-policy.service.test.ts` | non-elevated `upsertRow` with `harnessEnabled` → 403; with `autoNerEnabled` → 403; with only `autoSummaryEnabled` → succeeds; elevated caller succeeds for all; spy proves the check reads descriptor `globalOnly` (no hand-rolled list) |
| T-3 | `packages/applications/src/services/settings-registry/__tests__/settings-registry.test.ts` | `pipeline.harnessEnabled` + `pipeline.autoNerEnabled` descriptors carry `globalOnly: true`; the other two `pipeline.*` do not; catalog filtering for non-elevated callers hides them (existing behavior extended) |
| T-4 | `apps/api/src/modules/mcp-admin/__tests__/mcp-admin.controller.test.ts` + `…/agent-trajectory/__tests__/agent-trajectory.controller.test.ts` | route decorator metadata resolves subjects `McpServer` / `AgentTrajectory` (not `HarnessPolicy`); cross-tenant read still 404; MCP tenant-admin write still 403 (service guard intact) |
| T-5 | `packages/database/src/__tests__/seed.test.ts` | `tenant-full-access`/`harness-tenant-manage` contain tenant-scoped `manage:McpServer` + `read:AgentTrajectory`; `harness-platform-manage` contains both unconditional (grandfathering decision locked by test) |
| T-6 | `apps/admin-console/src/shared/navigation/__tests__/nav-config.test.ts` | `/prompt-studio` absent; `/db-studio` present with label "Database Studio"; `/ai-services` present (tier 10-19, `[['manage','all']]`, implemented); counts still 43 total / 17 in 10-19 (`:19-24`); icon + route uniqueness hold (`:48-52`, `:74-79`) |
| T-7 | redirect tests — `apps/admin-console/src/app/(console)/(global)/{prompt-studio,pstudio}/__tests__/redirect.test.tsx` | page module calls `next/navigation` `redirect('/agents?tab=governance')` / `redirect('/db-studio')` (TASK-526 row-11 precedent) |
| T-8 | `apps/admin-console/src/features/ai-services/components/__tests__/ai-services-screen.test.tsx` | loading skeletons (rule 10 shape), error state on 503, populated guardrail/NLP/instructions renders from fixtures, **axe 0 violations, both themes** |
| T-9 | `apps/admin-console/src/features/agents/components/__tests__/governance-tab.test.tsx` | Governance tab hidden for non-elevated session, visible + approve flow (OCC If-Match, 412 reload-merge) for elevated; approve panel ports its existing prompt-studio specs |
| T-10 | `features/harness-policy/components/__tests__/…` | tenant form renders `safetyEnabled`/`phiEnabled`/`phiFailClosed` disabled with hint; Global/Live tabs render read-only summary + deep link (no form submit present) |
| T-11 | `features/harness-ops/components/__tests__/{golden-sets-panel,edit-burden-card}.test.tsx` | list/detail/create states; PHI-safe fields only; edit-burden 404 → EmptyState; axe + themes |
| T-12 | `features/pipeline-policy/components/__tests__/…` | locked toggles disabled for non-elevated with hint; still editable for elevated |

**Gates (all must pass, output pasted in §9)**: `pnpm --filter @arcaai/applications build test` · `pnpm --filter @arcaai/database test` · `pnpm build:api` + `pnpm test:unit` · `pnpm --filter @arcaai/admin-console build lint test` · `pnpm lint` (only-warn warnings in `packages/*` treated as errors) · runtime verification of the changed screens via the `next-dev-loop` skill (compiling ≠ working) · e2e: update `apps/api/tests/e2e/mcp-admin.spec.ts` + `trajectory-admin` spec expectations for the new subjects, author `harness-policy-lock.spec.ts` (tenant PATCH `safetyEnabled` → 403) — **executed in TASK-534**.

---

## 6. Acceptance & DoD

- [ ] Tenant PATCH carrying any of `safetyEnabled`/`phiEnabled`/`phiFailClosed` → 403; effective policy resolves the three from SYSTEM regardless of tenant-row values; global editor unaffected.
- [ ] Non-elevated `PUT admin/pipeline-policy/row` carrying `harnessEnabled`/`autoNerEnabled` → 403, driven by descriptor `globalOnly` metadata; `autoSummaryEnabled` tenant path unchanged; scope clamp (400) unchanged.
- [ ] `McpServer`/`AgentTrajectory` subjects live on the two controllers; seeded roles keep today's access (T-5); 404-over-403 posture intact; boot route-audit green.
- [ ] `/agentic-policy` is the only editor for `policy/global` + `live/config`; `/harness/policy` shows read-only summaries + deep links.
- [ ] `/agents` Governance tab (elevated-only) covers list/version/diff/approve; `/prompt-studio` and `/pstudio` redirect (one release); `/db-studio` + `/ai-services` in nav; nav tests green with counts preserved.
- [ ] AI-Services panel + instructions viewer + golden-sets + edit-burden render with skeleton/empty/error states, axe 0 violations, both themes; design gate satisfied (frame or recorded waiver in this README) BEFORE screen code.
- [ ] M-13 markers + rules 05/12/13 updated; comment-delta list executed; traceability matrix rows updated.
- [ ] All §5 gates green with pasted evidence; RED runs recorded.

## 7. Risks & Rollback

| Risk | Mitigation / rollback |
|---|---|
| **Tenants relying on the previously-writable toggles** (a tenant that intentionally set `safetyEnabled:false` gets it force-reverted by the SYSTEM overlay at read time) | OD-2 owner sign-off REQUIRED before merge; comms note listing affected tenants (query `HarnessPolicy` rows whose three toggles differ from SYSTEM); values are overlaid, not deleted — rollback = remove keys from the list, tenant rows resume effect. Same for pipeline pins: existing rows keep resolving (read side untouched); only new writes are blocked, and global admins can clear pins via the same PUT |
| **Custom RBAC policies** (non-seeded) that granted `manage:HarnessPolicy` to reach MCP/trajectory lose that access after the subject swap | Additive seed fixes seeded roles only (§3.2); release note documents the operator action (add `McpServer`/`AgentTrajectory` grants to custom roles); no auto-migration of tenant-authored policies (deliberate — mutating custom policies silently is worse) |
| Redirect gaps break deep links / bookmarks | Redirect pages kept one release at both retired paths; nav test T-6 + redirect tests T-7 lock the mapping; `matchNavEntry` longest-prefix logic unaffected |
| Shared-file collisions on `nav-config.ts`/test with TASK-526/528 | Sequence the three tickets on that file (plan §2.3); this ticket's entries are enumerated in §2.9/B-6 so rebases are mechanical |
| 524 slippage blocks the descriptor enforcement | §3.1 fallback: local mirror against `HOPE_SETTINGS_REGISTRY` — same metadata; converge in a follow-up when 524 lands |
| Governance-tab fold regresses prompt approval during transition | Approve stays server-enforced (global-only 403) regardless of surface; the moved panels port their existing tests (T-9) before the old route is retired |

## 8. References

- Findings: `docs/implementation/SOTA-Track/2026-07-20-agentic-platform-review-findings.md` §3-E3 (E3-L1/L2/D1), §6 (M-01…M-14), §7 (GAP-G1/G2)
- Plan: `docs/implementation/SOTA-Track/2026-07-20-agentic-platform-program-plan.md` §3 AD-7, §4 Phase 5, §8 OD-2/OD-6
- Siblings: `docs/implementation/TASK-524-Config-Plane-Core/README.md` (§3.3 write-lane / enforcement point; step 5 delegates pipeline-policy adoption here) · `TASK-526-BYO-Cloud-Credentials/README.md` (M-04 tenant leg: `/ai-configuration` rename + redirect precedent) · `TASK-528-Model-Discovery-Hub/README.md` (`/ai-models` unhide + nav test flips)
- Key code: `harness-policy.service.ts:102-114,255-261,375-381` · `pipeline-policy.service.ts:31,163-256,404-412` · `pipeline.descriptors.ts:34-45` · `registry.types.ts:52` · `constants.ts:64` · `01-policy.ts:147,157,409-448` · `mcp-admin.controller.ts` · `agent-trajectory.controller.ts:20-34` · `ai-service-admin.controller.ts` + `ai-service-proxy.client.ts` · `harness-admin.controller.ts:198-288,304-322` · `agentic-admin.controller.ts:33-60` · `nav-config.ts:136-152` + `__tests__/nav-config.test.ts` · `harness-policy-screen.tsx:196-286` · `agentic-policy-screen.tsx` · `prompt-studio-screen.tsx:264-304` · `agents/api/client.ts:30-76` · rules `.claude/rules/{05,12,13}-*.md`

## 9. Implementation Summary

_Pending_

## 10. Change History

| Date | Change |
|---|---|
| 2026-07-20 | Ticket README authored (execution-ready): code-verified current state for every M-item and both E3 locks, two work-streams (A governance / B console IA), descriptor-driven enforcement architecture, additive RBAC grandfathering, TDD plan T-1…T-12, OD-2/OD-6 defaults recorded, design-gate preconditions stated. |
| 2026-07-20 | Program plan §2.5 **Completion & Cleanup Doctrine** adopted as BINDING for this ticket (owner directive): incorrect implementations in the owned surface are removed completely with the fix; partial implementations are finished end-to-end (or explicitly retired); redundant implementations are converged and deleted. Reviewer enforces the §2.5 classification table, plan-conformance (deviations = recorded decision rows), full-closure traceability of the claimed GAP/D/M IDs, and the performance gates. |
