# API Gateway B05c — Workflows

Companion explainer for `api-gateway-b05c-workflows.html`.

## Scope
`B05c` completes `B05-agent-workflow`: `workflows` (15/4), `workflow-definition` (22/1), `workflow-assignment` (5/1), `workflow-invariant-rule` (5/1), `workflow-node` (1/1), `workflow-run` (5/1), `workflow-sandbox-run` (4/1), `workflow-test-fixture` (5/1) — **62 routes / 11 controllers**. Repo @ `8cb2e5e8e6bbddf5ee7c676782ebb5ad683c23a0`.

## Endpoint groups

| Group | Modules/routes | Controllers | Key services | Downstream |
|---|---|---|---|---|
| Workflow config admin | definitions, assignments, nodes, invariant rules, test fixtures | `WorkflowDefinitionController` (`workflow-definition.controller.ts:63`), `WorkflowAssignmentController`, `WorkflowInvariantRuleController`, `WorkflowNodeController`, `WorkflowTestFixtureController` | `WorkflowDefinitionService` (`workflow-definition.service.ts:332`), `WorkflowAssignmentService` (`workflow-assignment.service.ts:57`), `WorkflowInvariantRuleService` (`workflow-invariant-rule.service.ts:61`), `WorkflowTestFixtureService` (`workflow-test-fixture.service.ts:33`) | Workflow config data store |
| Workflow runs admin | admin workflow-runs, run traces, sandbox-runs | `WorkflowRunController` (`workflow-run.controller.ts:47`), `WorkflowRunTraceController` (`workflows/workflow-run-trace.controller.ts:41`), `WorkflowSandboxRunController` (`workflow-sandbox-run.controller.ts:37`) | `WorkflowRunService` (`workflow-run.service.ts:175`), `WorkflowRunTraceAccessService` (`run-trace-access.ts:34`), `WorkflowSandboxRunService` (`workflow-sandbox-run.service.ts:47`) | Run/trace data; execution runtime |
| Workflow facade/runtime | `/workflows`, `/consultations/:consultationId/workflows` | `WorkflowsController` (`workflows.controller.ts:95`), `ConsultationWorkflowRunsController` (`consultation-workflow-runs.controller.ts:70`) | Facade/orchestration services (implementation-specific; related to workflow runs) | Workflow state; runtime/orchestration |
| Workflow hooks | `/hooks/workflows` callbacks | `WorkflowHooksController` (`workflow-hooks.controller.ts:24`) | Hook handling delegates to runtime/integration paths | Hook callers; workflow engine/runtime |

## Example input/output (representative)
- **Workflow config:** admin CRUD/publish/webhook-secret DTOs -> definition/assignment/rule/fixture records (verify versioning and secret handling).
- **Runs/sandbox:** create/list/get run or sandbox-run requests -> run/trace/sandbox state; sandbox runs are scoped to `definitionId`.
- **Facade/consultation runs:** workflow discovery/run orchestration requests -> workflow/run responses (verify service wiring).
- **Hooks:** callback payloads to `/hooks/workflows` -> hook handling/result (auth/signature verification is implementation-specific).

## Validation / limitations
- Archify finalize **pass** (`validate/deliver/check/browser-check`). Browser evidence pass; visual review not requested.
- Advisory route readability: 1 crossing (`svc_facade→data_wf` vs `svc_run→ext_engine`) and 1 detour (`svc_facade→ext_engine`, 4 bends). Gates pass.
- Limitations: grouped endpoint nodes (62 routes/11 controllers); `WorkflowNodeService` and some workflows-facade service names not separately verified; reconcile route/DTO/hook auth/versioning semantics with OpenAPI/implementation. Workflow execution may involve Temporal/harness/sandbox runtime.
