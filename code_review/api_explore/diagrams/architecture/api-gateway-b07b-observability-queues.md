# API Gateway B07b — Observability & Queues

Companion explainer for `api-gateway-b07b-observability-queues.html`.

## Scope
`B07b` (part of B07-guardrails-ops): `health` (6/2), `monitoring` (4/1), `platform-metrics` (3/1), `audit-log` (6/1), `queue-admin` (17/2), `admin-rate-limit` (13/1) — **49 routes / 8 controllers**. Repo @ `8cb2e5e8e6bbddf5ee7c676782ebb5ad683c23a0`.

## Endpoint groups

| Group | Modules/routes | Controllers | Key services | Downstream |
|---|---|---|---|---|
| Health/monitoring/metrics | `/health`, `/admin/health/services`, `/admin/monitoring`, `/admin/platform` (13 routes) | `ApiHealthController`, `AdminHealthServicesController`, `MonitoringController`, `PlatformMetricsController` | `PlatformMetricsService` (`platform-metrics.service.ts:58`), `PrometheusQueryService` (`prometheus-query.service.ts:47`); health/monitoring wiring verify | Prometheus/metrics, health deps |
| Audit logs | `/admin/audit-logs` (6) | `AuditLogController` (`audit-log.controller.ts:40`) | Controller wiring verified (service path verify) | Audit log data store |
| Queue & scheduler admin | `/admin/queues` (17) + `/admin/schedulers` | `QueueAdminController` (`queue-admin.controller.ts:41`), `SchedulerAdminController` (`scheduler-admin.controller.ts:24`) | Controller wiring verified (service path verify) | Redis/BullMQ queue runtime, queue metadata |
| Rate limit admin | `/admin/rate-limit` (13) | `RateLimitAdminController` (`rate-limit-admin.controller.ts:56`) | `RateLimitAdminService` (`rate-limit-admin.service.ts:47`), `RateLimitRuleService` (`rate-limit-rule.service.ts:40`) | Rate-limit config store |

## Example input/output (representative)
- **Health:** `GET /health` and admin health/service endpoints -> liveness/readiness/service health status payloads.
- **Monitoring/platform metrics:** admin metric/session/usage queries -> observability payloads; platform metrics may query Prometheus-backed data.
- **Queue/scheduler admin:** list/inspect/retry/pause/resume/clean/drain-style operations -> queue/scheduler/job state (BullMQ/runtime dependent). Verify destructive-operation safeguards.
- **Audit/rate limit:** audit log query/export -> audit records; rate-limit rule/settings CRUD -> effective rate-limit configuration. Verify sensitive-field redaction and access controls.

## Validation / limitations
- Archify finalize **pass** (`validate/deliver/check/browser-check`). Browser evidence pass; visual review not requested.
- Advisory route readability: 1 crossing (`svc_ops→ext_obs` vs `svc_rate→data_ops`) and 1 detour (`svc_rate→data_ops`, 3 bends). Gates pass.
- Limitations: grouped endpoint nodes (49 routes/8 controllers); audit-log, health, monitoring, and queue-admin application service implementation paths not all separately verified in this pass; reconcile exact route/DTO contracts and destructive queue/rate-limit operations with OpenAPI/implementation.
