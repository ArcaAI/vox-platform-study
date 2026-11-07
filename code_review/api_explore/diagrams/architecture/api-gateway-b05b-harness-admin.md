# API Gateway B05b — Harness Admin

Companion explainer for `api-gateway-b05b-harness-admin.html`.

## Scope
`B05b` (part of B05-agent-workflow): `harness-admin` — **29 routes, 1 controller** (`HarnessAdminController`, `/admin/harness`). Grouped by concern for readability. Repo @ `8cb2e5e8e6bbddf5ee7c676782ebb5ad683c23a0`.

## Endpoint groups

| Group | Key routes | Controller | Key services | Downstream |
|---|---|---|---|---|
| Policy/audit | `GET/PATCH policy`, `GET/PATCH policy/global`, `GET audit` | `HarnessAdminController` (`harness-admin.controller.ts:77,105+`) | `HarnessPolicyService` (`harness-policy.service.ts:330`), `HarnessObservabilityService` (`harness-observability.service.ts:74`) | Policy/audit data |
| Eval & golden sets | `eval-runs` list/get, `golden-sets` CRUD/list/get, cases, run, promote-to-golden-set | same | `EvalService` (`eval.service.ts:90`), `EvalRunService` (`eval-run.service.ts:257`), `GoldenCasePromotionService` (`golden-case-promotion.service.ts:61`) | Eval/golden-set data |
| Gate queue/edit exemplars | `gate-queue`, `edit-burden`, `gate-edit-exemplars` list/export/curation/promote | same | `GateEditMiningService` (`gate-edit-mining.service.ts:243`) | Exemplar/mining data |
| Workflows/live admin | workflows list/get/cancel/terminate/signal, live sessions/capabilities/config read+patch | same | `LiveDocumentationService` (injected), `HarnessOpsClient`/workflow ops deps (controller-injected) | Harness/workflow runtime ops, live sessions |

## Example input/output (representative)
- **Policy:** `GET/PATCH /admin/harness/policy` or `/policy/global` -> effective/updated policy (scope per handler).
- **Golden set run:** `POST /admin/harness/golden-sets/:id/run` -> eval run/result metadata. Exemplar curation/promote updates exemplar/promotion state.
- **Workflow control:** `POST /admin/harness/workflows/:id/cancel|terminate|signal` -> control result (action confirmation/reason policies may apply; optional confirmation/event services are injected).
- **Live config:** `GET/PATCH /admin/harness/live/config` -> live documentation config/state.

## Validation / limitations
- Archify finalize **pass** (`validate/deliver/check/browser-check`). Browser evidence pass; visual review not requested.
- Advisory route readability: 1 detour (`ctl_harness→svc_policy`, 3 bends). Gates pass.
- Limitations: grouped endpoint nodes (29 routes in 1 controller); `HarnessOpsClient` location/runtime topology summarized as external ops; reconcile exact DTO schemas, RBAC scopes, and workflow-engine/live runtime integration with OpenAPI/implementation.
