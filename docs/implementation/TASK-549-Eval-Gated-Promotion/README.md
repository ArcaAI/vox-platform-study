# TASK-549 — Tenant-Scoped Approval, Department Golden Sets & Eval-Gated Promotion

- **Status:** Review (approval-scope half + FULL backend eval-execution/gate half + console half + live-stack runtime proof all landed and gate-verified; TASK-549-tail's three API-surface completions — EvalRun.triggerType/promptVersionNumber surfacing, GoldenSet.departmentId create-lane validation, barrel/export audit — DONE; only the departmentId e2e case remains, documented as a follow-up)
- **Type:** feature (applications + api + harness + admin-console)
- **Parent:** [TASK-544 §5.4](../TASK-544-Agent-Platform-Concept/README.md) — U4 "gold standards"; **OD-3**: tenant-admin approval for tenant-created templates + mandatory eval-gate; **OD-5**: no clinical SME for now — global AND tenant admins manage golden sets
- **Depends on:** TASK-546 (schema: `DepartmentAgent.goldenSetId`, pin re-point hook). Approval-scope + eval-persistence halves can start in parallel with 546.
- **Rules to read first:** `.claude/rules/04-application-services.md`, `.claude/rules/05-nestjs-api.md` (§Imperative Privilege Checks), `.claude/rules/06-python-services.md` (harness, hermetic CI), `.claude/rules/13-nextjs-apps.md` (console half)

## Execution Contract (mandatory — owner directive)

1. **Invoke the `fable-thinking` skill FIRST**, before any other action in the implementing session. Non-negotiable for every Sonnet-5 session on this ticket, including follow-ups.
2. Follow the 5-phase lifecycle in `.claude/rules/01-development-workflow.md`; TDD Red-Green-Refactor — no implementation before a failing test.
3. Paste ACTUAL command output (tests/build/lint) into §Implementation Summary as evidence.
4. Do NOT commit or push. `git add` (stage) completed work as you go — unstaged work has been destroyed by concurrent sessions in this tree before.
5. One implementing session per working tree. For parallel work use a separate git worktree and `git reset --hard fix/2605-review` in it first (worktrees base off `main` by default).
6. File:line refs were verified 2026-07-22/23 and will drift — re-verify before editing.

## Requirement

Make template promotion **eval-gated** and devolve approval per OD-3/OD-5:

1. **Approval scope (OD-3)**: tenant admins may APPROVE templates their tenant owns; SYSTEM/library templates stay global-admin-only.
2. **Golden sets (OD-5)**: department-scopeable, managed by global admins (SYSTEM sets) and tenant admins (their own sets) — no SME role.
3. **Persisted evals**: eval runs write to the existing `EvalRun`/`EvalScore` DB tables (today the harness eval engine emits JSON only).
4. **Promotion gate (mandatory per OD-3)**: approving a template version — or re-pointing an agent's pinned version — with a golden set attached triggers an eval run; **regression blocks the promotion**; no golden set ⇒ promotion proceeds with a recorded warning.
5. **Console surface** for golden sets + eval results (closes the M-09 "backend with zero screen" gap for `admin/harness/golden-sets*`).

Research grounding (TASK-544 §3.1): golden set = 4 buckets (production sample, adversarial, edge cases, shipped-failure replays); prompt/eval sets versioned as code; named eval gate before publish (Foundry pattern).

## Current State (verified 2026-07-22)

- **Approval today**: `POST admin/prompt-templates/:id/approve` → `PromptManagementService.approvePromptTemplate` (`prompt-management.service.ts:425-464`) — **imperative `isSuperAdmin` check, else 403**; flips `status=APPROVED`, snapshots a `PromptVersion`, OCC, idempotent. The route deliberately lacks a matching declarative decorator (M-13; see rule 05 §Imperative Privilege Checks — the `// AUTH-NOTE:` marker convention).
- **DB models exist and are adequate** (`packages/database/src/prisma/db_main/harness.prisma:43-207`): `GoldenSet` (with `pinnedVersion`), `GoldenCase` (encrypted transcript + reference note), `EvalRun`, `EvalScore` (`metric`: faithfulness/coverage/pdsqi9/…). Tenant-scoped, **no `departmentId`** yet.
- **Admin routes exist**: `admin/harness/golden-sets*` CRUD + `GET admin/harness/eval-runs` (`apps/api/src/modules/harness-admin/harness-admin.controller.ts:173-294`) — no console screen consumes them (M-09).
- **Harness eval engine** (`apps/harness/src/harness/eval/`): `ci.py` release runner (GoldenSetRunner scoring, calibration, pure `apply_gate`) — **results emit to JSON only, not Postgres** (`ci.py:19-20`); PDSQI-9 judge (`eval/judge/pdsqi.py`); judge calibration ICC(2,1) + Gwet's AC2, release gate ICC ≥ 0.8 (`eval/calibration/reliability.py:1-15`, `assert_judge_calibrated`).
- **Golden fixtures are synthetic**: `eval/golden/fixtures/` (`synthetic_v0.json`, `clinical_v1.*`, `concept_harm_v0.json`, `curated_v1.json`); `sources.py:10-14` flags the synthetic fixture as a placeholder. CI gate `harness-eval-gate` is `allow_failure: true` (F-013). Content curation stays admin-driven per OD-5 — this ticket builds the MACHINERY, not the clinical content.
- **Candidate stream**: clinician approve-vs-edit signal already mined into `GateEditExemplar` (`harness.prisma:426-472`, per-department, PHI-redacted `redactedAfter`) — GAP-A1 says it never becomes golden-set candidates.
- **Harness CI is hermetic** (rule 06 pitfall): `test-harness` stubs Temporal/LLM/reranker, Qdrant in-memory, NO DB/Redis. Anything needing live infra belongs in local/e2e runs, not the harness CI suite.

## Implementation Plan

### 1. Schema (small migration, `task_549_…`)

- `GoldenSet.departmentId String?` + index; optional `EvalRun.promptTemplateId`/`promptVersionNumber`/`triggerType (MANUAL|PROMOTION|CI)` columns so a run is attributable to the promotion that triggered it. Hand-authored domain-layer updates for changed models per rule 03 (the entities exist — extend them; `gen:model` + reconcile).

### 2. Approval scope change (OD-3)

In `PromptManagementService.approvePromptTemplate`:
- SYSTEM-tenant template (the library) → `isSuperAdmin` required (unchanged).
- Tenant-owned template (scope TENANT_DEFAULT/DEPARTMENT_DEFAULT/USER_PERSONAL, tenantId ≠ SYSTEM) → allow callers holding `manage:PromptTemplate` for that tenant; cross-tenant id → 404 (never 403 — the 404-over-403 posture applies to tenancy, 403 stays for the privilege boundary).
- Update the `// AUTH-NOTE:` marker at the route to describe the NEW split gate; keep the class-level decorator so the boot audit stays green. Update rule-05-referenced behavior ONLY in code comments (rules files are owned elsewhere).

### 3. Eval execution + persistence

- New harness FastAPI internal endpoint `POST /api/v1/internal/eval/run` (behind `X-Service-Token`): body = golden-set payload (cases inlined or referenced) + template content/version + task config; wraps `GoldenSetRunner` + `apply_gate`; returns scores + gate verdict. Keep it synchronous for small sets; enforce a case-count cap; document that large sets need the Temporal lane later (out of scope).
- Gateway `EvalRunService` (applications): loads the golden set (decrypting cases), calls harness, persists `EvalRun` + `EvalScore` rows, broadcasts a sys-event. Reuse the harness client/service-token plumbing from `HarnessGatewayService` (`harness-gateway.service.ts:86`).
- Manual trigger route: `POST admin/harness/golden-sets/:id/run` (tenant-admin for own sets, global for SYSTEM sets).

### 4. Promotion gate

- On approve (and on TASK-546's pin re-point): if the template's department agent(s) reference a `goldenSetId` → run eval synchronously (bounded set size) → **block with 409 + score payload on gate failure**; persist the `EvalRun` either way with `triggerType=PROMOTION`. No golden set ⇒ proceed + persist a warning marker (sys-event + response field). Add a settings-registry descriptor `agentic.eval.promotionGate` (`block` default per OD-3's "mandatory", `warn`, `off`; global-admin-only) as the operational escape hatch.

### 5. Console

- `/agents?tab=governance` gains an Eval panel: golden-set picker per department agent, last runs + scores, run-now button; golden-set CRUD screen (list/detail with cases count — case CONTENT is PHI: show metadata only unless a decrypt-on-read route already exists; do NOT build new PHI display surfaces without checking the existing summary/context read patterns).
- `GateEditExemplar` → "promote to golden case" affordance (the GAP-A1 candidate stream): copies a redacted exemplar into a `GoldenCase` draft.

## TDD Test List

1. Approval matrix (applications): tenant admin approves own tenant template → 200; tenant admin on SYSTEM template → 403; global admin on both → 200; cross-tenant template id → 404; boot audit still green (route decorated).
2. EvalRunService: persists `EvalRun`+`EvalScore` from a stubbed harness response; sys-event broadcast; harness 5xx → run recorded FAILED, promotion behavior per gate policy.
3. Promotion gate: with golden set + failing scores → 409, template stays PUBLISHED, EvalRun persisted with `triggerType=PROMOTION`; passing → APPROVED; no golden set → APPROVED + warning marker; `agentic.eval.promotionGate=off` bypasses.
4. Harness endpoint (hermetic): runner invoked with inlined cases, gate verdict returned; case-cap enforced; no DB/Temporal/network in tests.
5. Console: eval panel renders runs/scores; run-now calls the BFF route; golden-set CRUD screens render; promote-exemplar flow creates a draft case.
6. e2e: approve-blocked-by-eval happy path + cross-tenant golden-set spec (task-307 pattern).

## Verification Criteria / Gates

- `pnpm --filter @arcaai/applications build test`, `pnpm api:build`, `pnpm test:unit`, e2e green; `pnpm harness:test` green AND STILL HERMETIC; `pnpm harness:lint` + `py:harness:typecheck` clean.
- `pnpm --filter @arcaai/admin-console build lint test` green; `next-dev-loop` runtime pass; axe 0 on new screens; both themes.
- Runtime proof on the live dev stack: create golden set → attach to agent → approve template → paste the blocking 409 (failing set) and the success path evidence, plus psql rows for `EvalRun`/`EvalScore`.

## Constraints & Hazards

- **Harness CI hermeticity is a hard constraint** — the new endpoint's tests must stub the LLM judge; anything live-LLM goes to local runs only.
- `GoldenCase` transcript/reference-note fields are **PHI-encrypted** — every new read/write path must use the established `encryptPhiFields`/decrypt-delegate patterns (the F-031 class: a writer that skips the cipher silently loses content).
- Temporal determinism is untouched here (no workflow changes) — if you find yourself editing `workflows.py`, stop and re-scope.
- Migration: dev/test Postgres is `db push`-managed — apply SQL additively via psql; never reset. Rebuild database/domains dists before running dependent vitest suites.
- The judge-calibration gate (ICC ≥ 0.8) applies to PDSQI-9-judge metrics — surface `assert_judge_calibrated` failures as run warnings, don't silently skip.

## Implementation Summary

### Scope of this session (partial — approval-scope half, OD-3)

This ticket is scoped for multiple sessions (§Depends-on: "Approval-scope + eval-persistence halves can start in parallel"). This session delivers the **approval-scope half (OD-3, Plan §2 + TDD #1)** fully, TDD'd and gate-verified, and precisely defers the eval-execution/gate + console halves (rationale under "Deferred" below). No schema migration was written this session — the deferred columns (`GoldenSet.departmentId`, `EvalRun.triggerType`/`promptVersionNumber`) have zero consumers until the eval-gate half lands, so adding them now would be speculative; they move with the session that consumes them.

`fable-thinking` skill was **unavailable** in this environment (`Unknown skill: fable-thinking`) — recorded here per the Execution Contract fallback; proceeded.

### OD-3: tenant-scoped template approval (DONE)

`PromptManagementService.approveTemplate` (`packages/applications/src/services/prompt-management/prompt-management.service.ts`) previously required `isSuperAdmin` for **all** templates. Replaced with an ownership-split gate (`assertCanApprove`):

- **SYSTEM/library** template (`tenantId === '00000000-0000-0000-0000-000000000000'`) → GLOBAL_ADMIN-only privilege → **403** (existence is NOT hidden — the shared library is globally visible).
- **Tenant-owned** template (`tenantId !== SYSTEM`) → `assertOwnedByTenant` first (cross-tenant id → **404**, 404-over-403), then require `isSuperAdmin` **OR** `manage:PromptTemplate` for that tenant, else **403**.

The version-pin snapshot + OCC compare-and-set + idempotent-already-APPROVED path are unchanged. The route (`apps/api/src/modules/prompt-management/prompt-management.controller.ts` `POST admin/prompt-templates/:id/approve`) still inherits the class-level `@Authorize(['manage','PromptTemplate'])` (boot audit stays green); its `// AUTH-NOTE:` marker, `@ApiOperation` description, and 403 `@ApiResponse` were updated to describe the new split gate.

### Gate evidence (actual output)

TDD RED→GREEN (`approveTemplate authorization scope (OD-3)`), 7 cases:
```
# RED (before impl): Tests  3 failed | 4 passed | 136 skipped (143)
#   - tenant admin approves own-tenant template (got 403, want 200)
#   - cross-tenant template id (got 403, want 404)
#   - tenant caller lacking manage on own-tenant template (got wrong 403 path)
# GREEN (after impl):
 Test Files  1 passed (1)
      Tests  7 passed | 136 skipped (143)
```

Full prompt-management suite + builds + lint:
```
$ npx vitest run src/services/prompt-management/      → Test Files  3 passed (3) · Tests 163 passed (163)
$ pnpm --filter @arcaai/applications build            → tsc clean
$ pnpm api:build                                      → Tasks: 8 successful, 8 total (clean; one transient ENOTEMPTY rimraf race on first run, clean on retry)
$ npx vitest run apps/api .../prompt-management/__tests__  → Test Files 2 passed · Tests 66 passed
$ eslint prompt-management.service.ts                 → 0 errors (5 pre-existing prettier warnings in untouched code; my edited regions clean)
$ eslint prompt-management.controller.ts (apps/api)   → 0 errors (3 pre-existing require-description warnings, none mine)
```

### Deferred to follow-up sessions (with rationale)

The **eval-execution + promotion-gate + console** halves (Plan §1,§3,§4,§5; TDD #2–#6) are NOT built this session because they cannot be completed safely here:
- The promotion gate requires a **new harness FastAPI `POST /api/v1/internal/eval/run`** endpoint that runs a live LLM judge — inline testing of the *running* endpoint violates harness CI hermeticity (only its pure runner/`apply_gate` pieces are CI-testable), and the gateway `EvalRunService.runAndGate` orchestration would otherwise call into a non-existent endpoint (a dangling cross-service call — disallowed by "do NOT improvise around the architecture").
- Runtime proof (Verification Criteria: create golden set → approve → blocking 409 + psql `EvalRun`/`EvalScore` rows) needs the live dev stack on **:8868**, which is occupied by another session (hard rule 4 → e2e deferred).
- Note: the `EvalService` (persist `EvalRun`/`EvalScore`, PHI-encrypted golden cases) **already exists** from prior work — the remaining gap is *running* an eval (harness endpoint) and *gating* on it, not persistence.

See Follow-ups for the exact remaining build order.

### Scope of this session (backend remainder — Plan §1, §3, §4)

`fable-thinking` skill was **still unavailable** in this environment (`Unknown skill: fable-thinking`) — recorded per the Execution Contract fallback; proceeded.

Delivered the entire BACKEND remainder — schema, harness endpoint, gateway runner + manual route, and the promotion gate wired into BOTH approval and pin re-point — all TDD'd and gate-verified. The console half (Plan §5) remains for the frontend session.

#### 1. Schema + domain layer (Plan §1) — DONE

- `packages/database/src/prisma/db_main/harness.prisma`: `GoldenSet.departmentId String?` + `@@index([tenantId, departmentId])`; `EvalRun.promptVersionNumber Int?` + `EvalRun.triggerType String?` (free-form, mirrors `status`; MANUAL|PROMOTION|CI — no enum migration). `EvalRun.promptTemplateId` already existed.
- Two additive migrations (dev/test Postgres is db-push-managed with drift → `prisma migrate dev` wants a reset, which is forbidden; applied additively via psql to **both** 5432 dev and 5433 test, idempotent `IF NOT EXISTS`):
  - `20260723010000_task_549_eval_gated_promotion` — the 3 columns + index.
  - `20260723010500_task_549_resource_type_eval_run` — `ALTER TYPE "core"."ResourceType" ADD VALUE 'EvalRun'` (required so the runner's ResourceCreated sys-event persists to AuditLog — the TASK-366 failure mode; added to BOTH `audit.prisma` and `packages/domains/src/enums/generated/ResourceType.ts`, parity test green).
- Hand-authored domain-layer extensions per rule 03 (model regenerated via `gen:model`; entity/factory hand-edited; mapper auto-maps the new scalars). All three drift checks clean (below). EvalService inputs + `GoldenSetResponse` DTO carry the new fields.

#### 2. Harness FastAPI `POST /api/v1/internal/eval/run` (Plan §3) — DONE

- `apps/harness/src/harness/api/endpoints/eval.py` (mounted in `main.py` at `/api/v1/internal`): `X-Service-Token`-guarded, synchronous, wraps `GoldenSetRunner` + `apply_gate` (via `run_and_gate`) over an inlined golden set. Enforces a case-count cap (`EvalConfig.max_cases_per_run`, default 50 → **413** over-cap). Returns the `EvalRunResult` (scores + gate verdict) + prompt provenance echo + a flattened `caseScores` array (PDSQI mean / faithfulness derived Python-side).
- **Scoping decision (documented):** the endpoint JUDGES the notes supplied on each case; it does NOT run SMR generation (needs the LLM lane, not hermetic — "the MACHINERY, not the clinical content"). The gateway maps `transcript → source_documents`, `referenceNote → generated_note`; `promptTemplateId`/`promptVersion(Number)` ride as provenance.
- Hermetic tests (`tests/unit/api/test_eval_endpoint.py`, 5 cases) inject a deterministic stub judge on `app.state.eval_judge` — no LLM/DB/Temporal/network.

#### 3. Gateway `EvalRunService` + manual route (Plan §3) — DONE

- `packages/applications/src/services/eval/eval-run.service.ts`: loads the golden set (404-over-403), decrypts each case (established `decryptFieldsFromEntity` PHI path), calls `HarnessGatewayService.runEval` (new method reusing the `X-Service-Token` plumbing), persists `EvalRun` + per-case `EvalScore` via the existing `EvalService.recordEvalRunWithScores`, and broadcasts `ResourceCreated`. Non-throwing on a harness/gate failure (records a FAILED run so the attempt stays attributable; returns `passed=false`).
- Manual trigger route `POST admin/harness/golden-sets/:id/run` (`@Authorize(['manage','HarnessEval'])`, `triggerType=MANUAL`) on `HarnessAdminController` → `EvalRunTriggerResponse`. Tenant admins run their own sets; a SYSTEM set is global-admin-only (a cross-tenant id 404s via the existing tenant-scope resolver).

#### 4. Promotion gate + settings descriptor (Plan §4) — DONE

- Settings descriptor `agentic.eval.promotionGate` (`agentic-eval.descriptors.ts`, registered in the catalog): enum `block` (default, OD-3 mandatory) | `warn` | `off`, `global-kv`, global-admin-only. Resolved through `EffectiveSettingsService` (fail-safe → `block` on a resolver outage).
- `EvalPromotionGateService`: reads the mode, finds the template's bound agent(s) carrying a `goldenSetId`, runs the eval (`triggerType=PROMOTION`) per agent, and reports `blocked` only in block-mode on failure. No golden set ⇒ proceeds with a recorded `warning`; `off` ⇒ skips entirely.
- Wired (append-only `@Optional()` DI, no test-arity breakage) into **both**:
  - `PromptManagementService.approveTemplate` — gate runs after the OD-3 auth check + idempotent-already-APPROVED short-circuit, BEFORE flipping to APPROVED. `blocked` → `ConflictException` (409 + `{failures, runIds, aggregates}`); template status untouched.
  - `DepartmentAgentService.pin` — gate runs on a re-point to a new version with a golden set attached, after the no-op check, BEFORE `updateWithVersion`. `blocked` → 409; pin not applied.

#### Gate evidence (actual output, this session)

```
# Schema / domain drift + parity
gen:model:check        → check: no drift — 122 generated file(s) match
gen:entity:check       → no drift — 72 file(s) match; Schema coverage OK (74 models)
gen:factory:check      → no drift — 72 file(s) match; Schema coverage OK
resourceType.enum-parity.test.ts → 2 passed (domain ⇔ database)

# Domains
pnpm --filter @arcaai/database build → tsc clean
pnpm --filter @arcaai/domains build  → tsc clean
pnpm --filter @arcaai/domains test   → Test Files 118 passed | 2 skipped; Tests 1390 passed

# Applications (TDD RED→GREEN for eval-run + eval-promotion-gate + caller gate tests)
pnpm --filter @arcaai/applications build → tsc clean
pnpm --filter @arcaai/applications test  → Test Files 339 passed | 1 skipped; Tests 6829 passed | 4 skipped
  - eval-run.service.test.ts            → 4 passed
  - eval-promotion-gate.service.test.ts → 7 passed
  - prompt-management approve gate      → 145 passed (incl. 2 new: 409-blocks / warn-proceeds)
  - departmentAgent pin gate            → 30 passed (incl. 3 new: 409-blocks / passes / no-goldenset-skips)
eslint (new files) → 0 errors, 0 warnings (my regions prettier-clean; pre-existing harness-gateway signal* prettier warnings untouched)

# API
pnpm api:build          → Tasks: 8 successful, 8 total
pnpm test:unit (workspace) → Test Files 987 passed | 2 skipped; Tests 17206 passed | 4 skipped | 9 todo
eslint harness-admin.controller.ts → 0 errors

# Harness (hermetic + lint + typecheck)
py:harness:test (full tests/)  → 990 passed (hermetic — no DB/Temporal/network)
  - test_eval_endpoint.py      → 5 passed
ruff check apps/harness/src/   → All checks passed!
mypy apps/harness/src/         → Success: no issues found in 94 source files
```

#### Deferred to the frontend session (Plan §5, unchanged)

Console eval panel + golden-set CRUD screens + the `GateEditExemplar` "promote to golden case" affordance (TDD #5). And the live-stack runtime proof + e2e (TDD #6 — Verification Criteria: create golden set → attach to agent → approve → blocking 409 + psql `EvalRun`/`EvalScore` rows) is for the **runtime-proofs agent** on the live dev stack (:8868). Note: the DI graph (EvalServiceModule wired into prompt-management/departmentAgent/harness-admin modules) is acyclic by construction but was NOT boot-verified here (no full app boot / e2e run this session).

### Console half (Plan §5, TDD #5) — DONE

`fable-thinking` skill was invoked first per the Execution Contract and was **still unavailable** in this environment (`Unknown skill: fable-thinking`) — recorded here per the fallback; proceeded.

Adapted the plan to what the backend session actually shipped (verified routes/DTOs in `apps/api`/`packages/applications` before wiring, per the dispatch instructions): golden-set CRUD screens **already existed** (`GoldenSetsPanel`/`EvalRunsPanel` on `/harness/observability`, shipped in an earlier ticket) — closes M-09, so this session built the two genuinely-missing pieces:

1. **Eval panel on `/agents?tab=governance`** — `EvalPanel` (`apps/admin-console/src/features/agents/components/governance-tab.tsx`), rendered in `TemplateGovernanceDetail` between `VersionsPanel` and `ApprovePanel`. Finds the `DepartmentAgent` rows bound to the selected template (`useDepartmentAgents`), defaults the golden-set picker (`useEvalGoldenSets`) to the first attached set, shows an "Attached to: `<agent names>`" hint, lists the last 5 runs + aggregate-score badges for the picked set (`useAgentEvalRuns`), and a manual "Run now" (`useRunGoldenSetEval`) that toasts the pass/fail verdict — independent of the promotion gate that runs automatically on Approve/pin re-point. Empty states for "no bound agents" and "no golden sets yet" (with a plain-href deep link to `/harness/observability` — one authoritative editor per resource, rule 13, never a cross-feature import). The API plumbing this consumes (`useEvalGoldenSets`/`useAgentEvalRuns`/`useRunGoldenSetEval` + the golden-set picker already added to the DepartmentAgent Settings tab) was found **already staged** from an earlier interrupted attempt at this same console half — reused as-is, only the panel UI itself was net-new.
2. **Golden-set CRUD screens** — already shipped (`/harness/observability`'s `GoldenSetsPanel`); reused unchanged per the "do NOT build new PHI display surfaces" instruction (its case list stays PHI-safe metadata only).
3. **`GateEditExemplar` → "promote to golden case"** (GAP-A1) — new `GateEditExemplarsPanel` (`apps/admin-console/src/features/harness-ops/components/gate-edit-exemplars-panel.tsx`), added to the `/harness/observability` board (new API surface: `listGateEditExemplars`/`useGateEditExemplars` over the existing `GET admin/harness/gate-edit-exemplars`). Renders each PHI-**redacted-at-write** candidate (quality-signal badge, department, edit-ratio, redacted signed-note preview) with a `manage:HarnessEval`-gated "Promote to golden case" button. The dialog pre-fills a draft `CreateGoldenCaseRequest` from `redactedBefore`/`redactedAfter` (transcript/reference-note respectively) + an auto label, lets the admin pick the target set and edit both fields, and only creates the case on submit (`useCreateGoldenCase`) — the source candidate stays an unreviewed proposal (`reviewStatus: PENDING_SME_REVIEW`) until then, never auto-admitted.

TDD: both features were built test-first — `governance-tab.test.tsx` and `gate-edit-exemplars-panel.test.tsx` were written and run RED (component/behavior didn't exist yet — confirmed failing) before implementation, then driven GREEN.

**Runtime pass — partial, documented gap:** `next build` succeeded (full compile + typecheck of the new routes/components) and `curl` against the already-running dev stack (`:5176`/`:8868`, found live from another session, not started or touched by this one) confirmed `/agents` and `/harness/observability` serve without a 500 (redirect to `/login` as expected — unauthenticated). A full authenticated `next-dev-loop` visual pass was **not** performed: it would require driving a live browser login, and the credential-entry safety policy this session operates under prohibits entering any password into a form via browser automation, including a documented local dev-seed fixture account. This is a genuine gap, not a corner cut for convenience — flagging it explicitly rather than skipping the question. The RTL component tests (real DOM render + real hook/event wiring, not mocked) plus the axe scans in both themes are the runtime evidence in place of it; a follow-up session with a human-supplied login (or a test-only auth bypass already sanctioned for e2e) should still walk the two screens visually before this ticket closes for good.

#### Gate evidence (actual output, this session)

```
# TDD RED -> GREEN
$ npx vitest run src/features/agents/components/__tests__/governance-tab.test.tsx        (before impl) -> 8 failed
$ npx vitest run src/features/agents/components/__tests__/governance-tab.test.tsx        (after impl)  -> 8 passed
$ npx vitest run src/features/harness-ops/api/__tests__/harness-ops-api.test.ts           (before impl) -> 2 failed | 8 passed
$ npx vitest run src/features/harness-ops/api/__tests__/harness-ops-api.test.ts           (after impl)  -> 10 passed
$ npx vitest run src/features/harness-ops/components/__tests__/gate-edit-exemplars-panel.test.tsx (before impl) -> import error (file didn't exist)
$ npx vitest run src/features/harness-ops/components/__tests__/gate-edit-exemplars-panel.test.tsx (after impl)  -> 10 passed

# Full suites (apps/admin-console, its own vitest config — server .test.ts + client .test.tsx projects)
$ npx vitest run src/features/agents/            -> Test Files 6 passed | Tests 51 passed
$ npx vitest run src/features/harness-ops/       -> Test Files 6 passed | Tests 57 passed
$ npx vitest run                                 -> Test Files 156 passed | Tests 1211 passed

$ pnpm --filter @arcaai/admin-console lint       -> eslint src --max-warnings 0 (clean)
$ pnpm --filter @arcaai/admin-console build      -> next build: Compiled successfully, TypeScript clean, 67 routes generated (incl. /agents, /harness/observability)
```

Files touched: `apps/admin-console/src/features/agents/components/governance-tab.tsx` (+`EvalPanel`), `.../agents/components/__tests__/governance-tab.test.tsx` (new), `.../harness-ops/api/{types,client,keys,hooks}.ts` (+gate-edit-exemplars surface), `.../harness-ops/api/__tests__/harness-ops-api.test.ts`, `.../harness-ops/components/gate-edit-exemplars-panel.tsx` (new), `.../harness-ops/components/__tests__/gate-edit-exemplars-panel.test.tsx` (new), `.../harness-ops/components/harness-observability-screen.tsx` (+panel mount), `.../harness-ops/components/__tests__/harness-observability-screen.test.tsx` (+stub/assertion for the new panel). All staged (`git add`), not committed.

### TASK-549-tail: three API-surface completions — DONE (TDD, gate-verified)

`fable-thinking` skill invocation was attempted FIRST per the Execution Contract and returned `Unknown skill: fable-thinking` (still not installed in this environment) — recorded here per the fallback and proceeded with the 5-phase + TDD discipline.

Scope: three small, independent completions left over from the backend/console sessions above (flagged in the parent TASK-544 §7 Run-2 verdict as "optional DTO surfacings"). All three were TDD'd RED→GREEN and are backward compatible (no breaking wire-format changes — new fields are additive/nullable).

**1. Surfaced `EvalRun.triggerType` + `promptVersionNumber` end-to-end.** The columns were persisted (prior session) but never left the domain entity — `EvalRunResponse` (`packages/applications/src/services/harness-observability/dto/eval-run.response.ts`) and its mapper (`harness-observability.service.ts#evalRunToResponse`) silently dropped both fields on every read (`GET eval-runs`, `GET eval-runs/:id`). Added `promptVersionNumber: number | null` and `triggerType: string | null` to the response DTO + mapper (2 new RED→GREEN tests: value-present and null-on-legacy-rows). Threaded to the console: `EvalRun` (harness-ops `api/types.ts`) and the slim `AgentEvalRun` projection (agents `api/types.ts`) both gained `triggerType`/`promptVersionNumber`; `EvalRunsPanel` (`/harness/observability`, full eval-runs grid) gained a "Trigger" badge column (MANUAL=outline, PROMOTION=default, CI=secondary, em-dash for legacy null rows — new `eval-runs-panel.test.tsx`, none existed before); the governance-tab `EvalPanel`'s "last runs" list (`/agents?tab=governance`) gained the same badge next to the status badge (extended `governance-tab.test.tsx`).

**2. `GoldenSet.departmentId` on the create lane.** `CreateGoldenSetInput`/`GoldenSetResponse` already carried `departmentId` (prior session), but the actual HTTP request DTO never exposed it and NOTHING validated the department belonged to the tenant. Added `departmentId?: string` (`@IsOptional() @IsString()`) to `CreateGoldenSetRequest` (`apps/api/.../dto/golden-set.request.ts`); `HarnessAdminController.createGoldenSet` now forwards it to `EvalService.addGoldenSet`. `EvalService` gained an `@Optional() @Inject(DepartmentRepository)` constructor param (APPENDED after the existing optional `secretsService`, never inserted — the two direct-construction unit test files keep their 4-arg calls untouched) and a private `assertDepartmentInTenant` (mirrors `DepartmentAgentService.assertDepartmentInTenant`): a missing OR cross-tenant department → `DataNotFoundException` (404-over-403 — never a 403), enforced only when `departmentId` is actually supplied (a tenant-wide set never touches the department repository). 4 new RED→GREEN tests in `eval.service.test.ts` (valid department, missing department, cross-tenant department, omitted departmentId skips validation) + 1 new controller test asserting the field threads through.

**3. Dangling-barrel/export check (eval service folder + module exports).** Audited `packages/applications/src/services/eval/{index.ts,dto/index.ts}`, `eval.service.module.ts`, and the `harness-observability` dto barrel: all five artifacts (`EvalService`, `EvalRunService`, `EvalPromotionGateService`, `EvalServiceModule`, every DTO incl. `EvalRunTriggerResponse`/`GoldenSetResponse`/`EvalRunResponse`) are correctly exported and reach `apps/api` through `@arcaai/applications`'s barrel chain (`services/index.ts` → root `index.ts`) — confirmed by `harness-admin.controller.ts` already importing all of them without a workaround. No dangling exports or missing DI registrations were found; the two real gaps were the DTO field omissions (item 1) and the request-DTO/validation wiring (item 2) above, both now fixed. `pnpm api:build` (which drift-checks the whole workspace including this barrel chain) stayed green throughout.

**Deliberately out of scope (documented, not silently skipped):** e2e coverage for the new `departmentId` create-lane validation — `apps/api/tests/e2e/admin-golden-sets-webhooks.spec.ts` already has a golden-set create→read round-trip but no department-scoping case; adding one needs the live API (`pnpm test:up:api`), which was not started this session (not part of the requested gate list, and per the hard rule on verifying port ownership before touching 8868). A natural follow-up, not a hidden gap.

#### Gate evidence (actual output, this session)

```
# TDD RED (before impl) — 2 harness-observability + 4 eval.service + 1 harness-admin.controller cases
$ npx vitest run src/services/harness-observability/__tests__/harness-observability.service.test.ts
  → 2 failed (triggerType/promptVersionNumber undefined, expected 'PROMOTION'/3 and null/null)
$ npx vitest run src/services/eval/__tests__/eval.service.test.ts
  → 3 failed (department-scoping: create/missing-department/cross-tenant-department all resolved instead of rejecting)
$ npx vitest run apps/api/src/modules/harness-admin/__tests__/harness-admin.controller.test.ts
  → 1 failed (departmentId missing from the addGoldenSet call args)
$ npx vitest run src/features/agents/components/__tests__/governance-tab.test.tsx
  → 1 failed (no PROMOTION/MANUAL badge text found)
$ npx vitest run src/features/harness-ops/components/__tests__/eval-runs-panel.test.tsx (new file)
  → 2 failed (no Trigger column)

# GREEN (after impl)
$ npx vitest run src/services/harness-observability/ src/services/eval/         → Test Files 7 passed · Tests 77 passed
$ npx vitest run apps/api/src/modules/harness-admin/__tests__/harness-admin.controller.test.ts → Test Files 1 passed · Tests 46 passed
$ npx vitest run src/features/agents/ (admin-console)                          → Test Files 6 passed · Tests 52 passed
$ npx vitest run src/features/harness-ops/ (admin-console)                     → Test Files 7 passed · Tests 59 passed

# Full-package gates
$ pnpm --filter @arcaai/applications build   → tsc clean
$ pnpm --filter @arcaai/applications test    → Test Files 340 passed | 1 skipped (341) · Tests 6862 passed | 4 skipped
$ pnpm --filter @arcaai/applications lint    → 0 errors, 339 pre-existing warnings (none in my touched regions — verified line-by-line)
$ pnpm api:build                             → Tasks: 8 successful, 8 total
$ pnpm test:unit (workspace)                 → Test Files 988 passed | 2 skipped (990) · Tests 17243 passed | 4 skipped | 9 todo
$ pnpm --filter @arcaai/admin-console test    → Test Files 157 passed · Tests 1218 passed
$ pnpm --filter @arcaai/admin-console lint    → eslint src --max-warnings 0 (clean)
$ pnpm --filter @arcaai/admin-console build   → next build: Compiled successfully, 67 routes generated
```

Files touched: `packages/applications/src/services/harness-observability/dto/eval-run.response.ts`, `.../harness-observability.service.ts`, `.../__tests__/harness-observability.service.test.ts`; `packages/applications/src/services/eval/eval.service.ts`, `.../__tests__/eval.service.test.ts`; `apps/api/src/modules/harness-admin/dto/golden-set.request.ts`, `.../harness-admin.controller.ts`, `.../__tests__/harness-admin.controller.test.ts`; `apps/admin-console/src/features/harness-ops/api/types.ts`, `.../components/eval-runs-panel.tsx`, `.../components/__tests__/eval-runs-panel.test.tsx` (new), `.../components/__tests__/harness-observability-screen.test.tsx` (fixture fields only); `apps/admin-console/src/features/agents/api/types.ts`, `.../components/governance-tab.tsx`, `.../components/__tests__/governance-tab.test.tsx`. All staged (`git add`), not committed.

## Change History

- 2026-07-23 — Ticket authored from TASK-544 §7 breakdown (OD-3, OD-5, U4 gold standards).
- 2026-07-23 — **Approval-scope half (OD-3) implemented + gate-verified** (TDD, 7 new cases). `PromptManagementService.approveTemplate` split into a SYSTEM=global-admin-only / tenant-owned=`manage:PromptTemplate` gate (`assertCanApprove`); controller AUTH-NOTE + Swagger updated. applications build + 163 prompt-management tests + api build + 66 api controller tests + lint all green. `fable-thinking` skill unavailable (recorded per Execution Contract fallback). Eval-execution/promotion-gate/console halves deferred with rationale (harness live-LLM endpoint not yet built; hermeticity + :8868-busy constraints). Work staged, not committed.
- 2026-07-23 — **Backend remainder (Plan §1/§3/§4) implemented + gate-verified** (TDD). Schema: `GoldenSet.departmentId` + index, `EvalRun.triggerType`/`promptVersionNumber`, `ResourceType.EvalRun` (both enums + parity) — two additive psql migrations applied to dev(5432)+test(5433) (reset forbidden; DB is db-push-managed with drift). Hand-authored domain layer; gen model/entity/factory drift + coverage checks clean. Harness `POST /api/v1/internal/eval/run` (X-Service-Token, synchronous, 413 case-cap, hermetic stub-judge tests, 5 cases). Gateway `EvalRunService` (decrypt cases → `HarnessGatewayService.runEval` → persist EvalRun+EvalScore → ResourceCreated sys-event) + manual route `POST admin/harness/golden-sets/:id/run`. Promotion gate: `EvalPromotionGateService` + `agentic.eval.promotionGate` descriptor (block default | warn | off, global-admin-only), wired append-only into `approveTemplate` AND `DepartmentAgentService.pin` (blocked → 409 + score payload). Gates: applications build + 6829 tests; api build (8/8) + 17206 workspace unit tests; database + domains build + 1390 domains tests + parity; py:harness:test 990 hermetic + ruff + mypy clean; eslint clean (my regions). `fable-thinking` still unavailable (recorded). Console half (§5) + live-stack runtime proof/e2e deferred (runtime-proofs agent). Work staged, not committed.
- 2026-07-23 — **Console half (Plan §5) implemented + gate-verified** (TDD, `fable-thinking` still unavailable — recorded). Discovered golden-set CRUD screens already shipped on `/harness/observability` from an earlier ticket (closes M-09) and that a prior interrupted attempt at this console half had already staged the golden-set-picker/eval API plumbing in the `agents` feature — reused both rather than rebuilding. Net-new: (1) `EvalPanel` on `/agents?tab=governance` — golden-set picker defaulted from the selected template's bound `DepartmentAgent`s, last-5-runs + aggregate scores, manual run-now with a pass/fail toast; (2) `GateEditExemplarsPanel` on `/harness/observability` — lists PHI-redacted-at-write gate-edit candidates with a `manage:HarnessEval`-gated "Promote to golden case" dialog that pre-fills a draft `CreateGoldenCaseRequest` from `redactedBefore`/`redactedAfter`, editable before submit. New harness-ops API surface: `listGateEditExemplars`/`useGateEditExemplars` over the existing `GET admin/harness/gate-edit-exemplars`. Gates: `governance-tab.test.tsx` (8 tests, RED confirmed then GREEN), `gate-edit-exemplars-panel.test.tsx` (10 tests, RED then GREEN), harness-ops-api client/keys tests extended (10 passed), full `apps/admin-console` suite 156 files / 1211 tests green, lint clean (0 warnings), `next build` clean (compile + typecheck, 67 routes). Runtime gap: the dev stack (`:5176`/`:8868`) was found already running from another session (not started/touched here); confirmed via `curl` that `/agents` and `/harness/observability` serve without a 500, but a full authenticated `next-dev-loop` visual pass was skipped because it would require entering a password into a live browser session, which this session's safety policy prohibits even for a documented local dev-seed account — flagged as an explicit follow-up rather than silently skipped. Work staged (`git add`), not committed.

### 2026-07-23 — Runtime proof (RUNTIME-PROOFS agent) — PASS (full 409-block + passing approve)
Live dev API (:8868), gate mode default `block`, LLM judge `google/gemma-4-e4b` (LM Studio):
- **Manual eval** `POST admin/harness/golden-sets/:id/run`: passing case → runId, `passed=true`, pdsqi_mean 4.5; psql `EvalRun`(MANUAL/COMPLETED) + `EvalScore`(4.5/5, judge gemma-4-e4b). Unfaithful case → `passed=false, failures=[pdsqi_accurate=1.0<4.0,…]`.
- **Approve-gate 409:** DRAFT template + `DepartmentAgent` bound (`promptTemplateId` + `goldenSetId`=failing set). `POST admin/prompt-templates/:id/approve` → **HTTP 409** `{reason:EVAL_GATE_FAILED, failures, runIds:[…], aggregates}`; template stayed DRAFT; `EvalRun` `triggerType=PROMOTION status=FAILED` + `EvalScore` persisted.
- **Passing approve:** repointed agent → passing set, re-approve → **HTTP 200**, template `status=APPROVED`.
- Proof artifacts (golden sets/cases/agent/template) soft-deleted; EvalRuns kept as audit trail.

- 2026-07-23 — **TASK-549-tail: three API-surface completions (DONE, gate-verified)**. `fable-thinking` unavailable (recorded). (1) `EvalRun.triggerType`/`promptVersionNumber` surfaced through `EvalRunResponse` + its mapper (were persisted but silently dropped on every read) and threaded to the console: `EvalRunsPanel` (`/harness/observability`) and the governance-tab `EvalPanel` (`/agents?tab=governance`) both gained a Trigger badge (MANUAL/PROMOTION/CI) on their "last runs" lists. (2) `GoldenSet.departmentId` added to `CreateGoldenSetRequest` + threaded to `HarnessAdminController.createGoldenSet`; `EvalService` gained an optional `DepartmentRepository` (appended, never inserted) and `assertDepartmentInTenant` — a missing/cross-tenant department 404s (never 403), enforced only when `departmentId` is supplied. (3) Audited the eval service folder barrel + module exports — no dangling exports found; the two real gaps were (1) and (2) above, both fixed. TDD throughout (RED confirmed then GREEN for 2 harness-observability + 4 eval.service + 1 controller + 1 governance-tab + 2 new eval-runs-panel cases). Gates: applications build + 6862 tests + lint (0 errors); build:api 8/8 + workspace test:unit 17243 passed; admin-console build (67 routes) + lint (0 warnings) + 1218 tests. Deliberately deferred: e2e coverage for the departmentId 404 case (needs the live API; not part of the requested gate list). Work staged (`git add`), not committed.
