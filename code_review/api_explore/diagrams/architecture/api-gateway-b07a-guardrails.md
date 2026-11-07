# API Gateway B07a — Guardrails

Companion explainer for `api-gateway-b07a-guardrails.html`.

## Scope
`B07a` (part of B07-guardrails-ops): `guardrail-availability` (4/1), `guardrail-evaluation-internal` (1/1), `guardrail-notice` (6/2), `guardrail-policy` (17/2), `guardrail-tenant-policy` (3/2) — **31 routes / 8 controllers**. Repo @ `8cb2e5e8e6bbddf5ee7c676782ebb5ad683c23a0`.

## Endpoint groups

| Group | Key routes/surfaces | Controllers | Key services | Downstream |
|---|---|---|---|---|
| Guardrail admin config | `/admin/guardrail*` availability, policy, metrics, tenant policy, rule test | `GuardrailPolicyController`, `GuardrailMetricsController`, `GuardrailAvailabilityController`, `GuardrailTenantPolicyController`, `GuardrailRuleTestController` | `GuardrailPolicyService` (`guardrail-policy.service.ts:232`), `GuardrailAvailabilityService` (`guardrail-availability.service.ts:75`), `GuardrailTenantPolicyService`, `GuardrailRuleTestService` | Guardrail config/policy data |
| Consultation notices | `/consultations` guardrail notice endpoints | `GuardrailNoticeController` (`guardrail-notice.controller.ts:48`) | `GuardrailNoticeService` (`guardrail-notice.service.ts:100`), `GuardrailHoldService` (`guardrail-hold.service.ts:214`) | Notice/hold state |
| Admin consultation evaluations | `/admin/consultations` guardrail evaluation reads | `AdminGuardrailEvaluationController` (`admin-guardrail-evaluation.controller.ts:22`) | `GuardrailEvaluationAdminService` (`guardrail-evaluation-admin.service.ts:114`) | Evaluation data |
| Internal evaluation ingest | `POST /internal/guardrail/evaluations` (service-to-service) | `GuardrailEvaluationInternalController` (`guardrail-evaluation-internal.controller.ts:40`) | `GuardrailEvaluationIngestService` (`guardrail-evaluation-ingest.service.ts:87`) | Evaluation ingest/persistence; internal producers |

## Example input/output (representative)
- **Policy/availability/tenant policy/rule test:** admin config requests -> policy/availability/config responses; rule test evaluates sample inputs -> test result.
- **Guardrail notices:** consultation notice list/read/ack flows -> notice/hold state (verify PHI-safety semantics).
- **Internal evaluation ingest:** `POST /internal/guardrail/evaluations` with service token + tenant context -> persisted evaluation/ingest result. Verify DTO/idempotency/auth.

## Security / validation / limitations
- **Internal:** evaluation internal controller uses `@Public`/`@ApiExcludeController` with `InternalServiceTokenGuard` + `InternalTenantLockGuard` (service token for guardrail service; per controller comments).
- Archify finalize **pass** (`validate/deliver/check/browser-check`). Browser evidence pass; visual review not requested.
- Limitations: grouped endpoint nodes (31 routes/8 controllers); reconcile exact route/DTO contracts, notice/evaluation schemas, and hold/reconciliation behavior with OpenAPI/implementation.
