# TASK-511 — Global-Admin Control-Plane Backend (TASK-508 Phase 3A)

| Field | Value |
|---|---|
| **Ticket** | TASK-511 |
| **Parent** | TASK-508 (Agentic SOTA Program), Phase 3, section **3A** |
| **Type** | feature (backend) |
| **Status** | Completed |
| **Scope** | `packages/database`, `packages/domains`, `packages/applications`, `apps/api`, `apps/harness` |
| **Out of scope** | 3B console (TASK-512), production inference engines (TASK-513/514, separate landed work) |

---

## Requirement Analysis

Phase 3A consolidates the global-admin **configuration** control plane for the agentic
harness so that loop behaviour, context strategy, model routing, prompt governance, and the
effective instruction inventory are all **versioned + audited + privilege-gated**, with a
consistent `@CanManage(...)` + cross-tenant-404 posture and `If-Match` OCC on every mutation.

Authoritative spec: `docs/implementation/TASK-508-Agentic-SOTA-Program/README.md` §3A
(the knob-group table). Precedents: per-field env-fallthrough (`harness-policy.service.ts`),
`guardrail.*` GLOBAL_ADMIN 403, and the Temporal replay-compat contract (additive-optional
activity inputs only — no command-sequence changes).

The work splits into seven items. Items 1–5 (DB, domain, applications-layer) were landed by
the prior agent; items **A/B/C** (the API tails + the Python harness consumption) are this
pass.

---

## Current State Evaluation (baseline at resume)

- **DB** already `db:push`-synced; `db:generate` + `@arcaai/database` build + `@arcaai/domains`
  build GREEN (parent-verified). Migrations are additive-only (no DROP/DELETE/TRUNCATE).
- **Applications** suite GREEN (6344) with items 1–5 present.
- **Remaining:** the `POST admin/prompt-templates/:id/approve` API tail (A), the agentic
  instructions inventory service + `GET admin/agentic/instructions` API (B), and the harness
  Python consumption of the 7 new policy knobs (C).

---

## Implementation Plan (as executed, TDD RED→GREEN)

1. **A** — controller test RED (approve endpoint missing) → add `POST :id/approve`
   (`@RequiresIfMatch`, GLOBAL_ADMIN 403 via applications guard, cross-tenant 404, 428 missing
   If-Match) wired to the existing `approveTemplate` service method → GREEN.
2. **B** — new `AgenticInstructionsService` (applications) aggregating harness policy + prompt
   tier + judge pin, DTOs, module, barrel; new `AgenticAdminController`
   (`GET admin/agentic/instructions`, `@CanManage('HarnessPolicy')`, cross-tenant 404); register
   in `app.module.ts`. Vitest service + controller tests RED→GREEN.
3. **C** — extend harness `HarnessPolicy` (`models.py`) with 7 additive-optional knobs +
   `from_api` mapping; add `_resolve_flag` per-field fallthrough helper in `activities.py`;
   thread the activity-consumed knobs (`nerPriorsEnabled`, `retrievalEnabled`, `atomicFactEnabled`)
   as additive activity-input fields and the workflow-consumed knobs
   (`optimisticDeliveryEnabled`, `maxEditReruns`) from deterministic workflow state. pytest
   RED→GREEN; replay-compat MUST stay green.

Verification gates: domains build → applications build+test → api build+test → harness pytest →
lint (treat `packages/*` only-warn as errors).

---

## Implementation Summary

### Items 1–5 (prior agent — verified, not redone)

| Item | What | Key files |
|---|---|---|
| 1 | 7 new nullable `HarnessPolicy` loop knobs | `packages/database/src/prisma/db_main/harness.prisma`, migration `20260719020000_task_511_harness_policy_agentic_knobs`; `HarnessPolicyEntity/Model/Factory` |
| 2 | `agentic.context.*` settings namespace, consumed replacing consts | `settings-registry/descriptors/agentic-context.descriptors.ts`, `effective-settings.service.ts`, `registry.ts`, `live-documentation.service.ts` |
| 3 | Model routing: `AiTaskDefault` keys `smr.live`/`smr.finalize` + `resolveSmrSelection` precedence | `ai-task-default/constants.ts` + `.service.ts`, `harness-policy.service.ts`, seed `16-ai-task-default.ts` |
| 4 | Privilege guard — `agentic.*`/`smr.*` writable by `GLOBAL_ADMIN` only (real 403) | settings service guard |
| 5 | Prompt-resolution gating (`status=APPROVED` required for clinical flows) + applications approve method | `prompt-resolution.service.ts`, `prompt-management.service.ts`, `IPromptManagementService.ts`, `prompt-management/dto/approve-prompt-template.request.ts`; migrations `..._task_511_prompt_template_status_approved`, `..._task_511_prompt_template_approve_seed`, seed `07-prompt-template.ts`; `PromptTemplateEntity`, `PromptTemplateStatus` enum |

### A) `POST admin/prompt-templates/:id/approve` (item 5 tail) — this pass

- **Endpoint:** `apps/api/src/modules/prompt-management/prompt-management.controller.ts`
  `@Post(':id/approve')` `@HttpCode(200)` `@RequiresIfMatch()`. `If-Match` folds over body
  `expectedVersion` (header wins), delegating to `promptService.approveTemplate(id, request)`.
- **Privilege / posture:** GLOBAL_ADMIN-only 403, cross-tenant/unknown 404, version-drift 412 —
  all enforced by the existing applications `approveTemplate`; missing `If-Match` → 428 (param
  decorator). Idempotent (approving an already-APPROVED template returns the current row).
- **Test:** `__tests__/prompt-management.controller.test.ts` — delegation, header-precedence,
  response shape, `ForbiddenException` (403), `NotFoundException` (404 cross-tenant), and
  `@RequiresIfMatch()` metadata (428).

### B) Agentic instructions inventory (item 6) — this pass

- **Applications service:** `packages/applications/src/services/agentic-instructions/`
  - `agentic-instructions.service.ts` — `AgenticInstructionsService extends BaseService`
    (read-only; broadcasts no sys-event). Aggregates `HarnessPolicyService.getEffectivePolicy`
    (sensor thresholds + safety criteria + policy source) and `PromptResolutionService.resolve`
    (prompt tier), plus the vendored **PDSQI-9** judge-prompt pin (constant identity:
    `version 1.0.0`, source/license/DOI, rubric dimensions, and a deterministic SHA-256
    `promptHash`; `editable: false`).
  - `IAgenticInstructionsService.ts` (Symbol-token DI), `dto/` (+ barrel), module
    (`agentic-instructions.service.module.ts` importing the harness-policy + prompt-resolution
    modules), `index.ts`; barrel export added to `services/index.ts`.
- **API controller:** `apps/api/src/modules/agentic-admin/agentic-admin.controller.ts`
  `GET admin/agentic/instructions` `@CanManage('HarnessPolicy')`. Tenant-bound callers are
  pinned to their CLS tenant; a foreign `?tenantId=` → 404 (no existence leak); platform admins
  target any tenant via `?tenantId=`. Module `agentic-admin.module.ts` registered in
  `apps/api/src/app.module.ts`.
- **Tests:** applications service vitest + api controller vitest (roles, tenant resolution,
  cross-tenant 404, `@CanManage` metadata).

### C) Harness Python — consume the 7 new policy knobs — this pass

- **DTO / model:** `apps/harness/src/harness/temporal/models.py` — `HarnessPolicy` gains 7
  additive-optional knobs (`optimistic_delivery_enabled`, `atomic_fact_enabled`,
  `retrieval_enabled`, `warm_start_enabled`, `ner_priors_enabled`, `max_edit_reruns`,
  `regen_feedback_enabled`), all defaulting to `None`. `HarnessPolicy.from_api` maps the
  camelCase API fields; missing/explicit-null ⇒ `None` (per-field env fallthrough). Activity
  inputs `ExtractEntitiesInput` (`ner_priors_enabled`), `RetrieveContextInput`
  (`retrieval_enabled`), `RunInferentialSensorsInput` (`atomic_fact_enabled`) gain matching
  additive-optional fields.
- **Fallthrough helper:** `apps/harness/src/harness/temporal/activities.py` — `_resolve_flag(policy_value, *, env_default)`
  returns `env_default` when `policy_value is None`, else the policy value. Wired at
  `extract_entities` (NER priors), `retrieve_context` (retrieval), `run_inferential_sensors`
  (atomic-fact).
- **Workflow:** `apps/harness/src/harness/temporal/workflows.py` — in the `policy is not None`
  branch, `optimistic_delivery_enabled` + `max_edit_reruns` prefer the policy value when non-null
  (else the input-snapshotted `inp.gate` default); the three activity-consumed knobs are read
  into locals (`None` when no policy) and threaded onto the activity inputs at their call sites.
  No new Temporal command / patch marker — all reads are from deterministic workflow state ⇒
  replay-safe.
- **Test:** `apps/harness/src/harness/tests/unit/temporal/test_policy_knobs.py` — `from_api`
  mapping (all 7, missing → None, explicit null → None), model defaults, `_resolve_flag`
  fallthrough, and `retrieve_context` honouring the policy override over the env flag.

---

## Gate Evidence (actual output)

```
$ pnpm --filter @arcaai/domains build
> tsc                                              # exit 0

$ pnpm --filter @arcaai/applications build
> rimraf dist tsconfig.tsbuildinfo && tsc          # exit 0

$ pnpm --filter @arcaai/applications test
 Test Files  304 passed | 1 skipped (305)
      Tests  6350 passed | 4 skipped (6354)        # +6 over 6344 baseline (new agentic-instructions tests)

$ pnpm --filter @arcaai/api build
> rimraf dist && nest build && tsc-alias           # exit 0

$ pnpm --filter @arcaai/api test
 Test Files  140 passed | 2 skipped (142)
      Tests  2281 passed | 4 skipped (2285)

$ conda run -n arcaenv --no-capture-output pytest apps/harness/src/harness/tests/ -q
 804 passed, 3 warnings in 27.30s                  # includes test_replay_compat.py (replay-compat GREEN)

$ pnpm --filter @arcaai/api lint                   # exit 0, clean
$ pnpm --filter @arcaai/applications lint          # 0 errors; only pre-existing prettier warnings
                                                   #   in files NOT touched here; new agentic-instructions
                                                   #   files are CLEAN
$ conda run -n arcaenv ruff check <changed harness files>
 All checks passed!
```

### Compliance confirmation

- **No git writes** of any kind (status/read-only inspection only).
- **Additive-only DB** — no DROP/DELETE/TRUNCATE; no `migrate reset`.
- **No DO-NOT-TOUCH edits** — `apps/smr/**`, `apps/guardrail/**`, `infrastructure/**`,
  `deployment/**`, `.env.*`, `turbo.json`, `docs/operations/inference/**` untouched. No
  `vllm`/`llama-cpp` engine values added.
- **Replay-compat** suite GREEN (`test_replay_compat.py`), Temporal command sequence unchanged
  (additive-optional activity inputs only).

---

## Files Created / Modified (this pass)

**Created**
- `packages/applications/src/services/agentic-instructions/{agentic-instructions.service.ts, IAgenticInstructionsService.ts, agentic-instructions.service.module.ts, index.ts, dto/agentic-instructions.response.ts, dto/index.ts}`
- `apps/api/src/modules/agentic-admin/{agentic-admin.controller.ts, agentic-admin.module.ts, __tests__/agentic-admin.controller.test.ts}`
- `apps/harness/src/harness/tests/unit/temporal/test_policy_knobs.py`
- `docs/implementation/TASK-511-Control-Plane-Backend/README.md` (this file)

**Modified**
- `apps/api/src/modules/prompt-management/prompt-management.controller.ts` (+ `__tests__/prompt-management.controller.test.ts`)
- `apps/api/src/app.module.ts` (register `AgenticAdminModule`)
- `packages/applications/src/services/index.ts` (barrel export)
- `apps/harness/src/harness/temporal/{models.py, activities.py, workflows.py}`

---

## Change History

| Date | Change |
|---|---|
| 2026-07-19 | Prior agent: items 1–5 (DB knobs + migrations/seeds, domain entities/enum, applications settings/model-routing/privilege/prompt-gating + approve method). |
| 2026-07-19 | This pass: A) `POST admin/prompt-templates/:id/approve` API + test; B) `AgenticInstructionsService` + `GET admin/agentic/instructions` API + tests + module registration; C) harness consumes the 7 policy knobs (`models.py`/`activities.py`/`workflows.py`) + pytest. All gates GREEN. |
