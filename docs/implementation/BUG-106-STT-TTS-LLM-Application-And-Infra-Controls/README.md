# BUG-106: Define & Implement Application and Infrastructure Controls for STT/TTS & LLM Engine

| | |
|---|---|
| **Status** | `Pending` |
| **Type** | change-request / feature (controls baseline + documentation); largely already implemented under other tickets |
| **Source** | https://github.com/ArcaAI/ALaaSv3.0/issues/106 (labels: enhancement, ALaaS; opened 2025-07-11; no comments) |
| **Severity** | Medium (compliance posture, not a runtime defect) |
| **Still applicable on dev-2.2?** | Partially. Most controls exist in a different shape; four concrete gaps remain (section 3). |
| **Date** | 2026-10-06 |

## 1. Requirement Analysis

The issue asks for a codified control set for the STT / TTS / LLM subsystems:

- Application controls: input validation (reject unsupported or >100 MB audio, cap prompt length), authN/authZ on every STT/TTS/LLM endpoint, rate limits (STT 10 audio-min per min per session, LLM 5 req/min per clinician), structured audit logs (immutable, retained >= 90 days), standard errors plus an exposed circuit-breaker state.
- Infrastructure controls: private subnet and gateway-only ingress, vault-held secrets rotated every 90 days, Prometheus metrics with alerts (>5 % errors, >2 s latency), autoscaling and >= 2 instances per region, monthly patching, IaC with reviewed PRs.
- Deliverable: a `CONTROLS.md` describing each control, rationale and how to test it; runbooks updated.

Its premises are written for the ALaaS v1 world (Azure Key Vault, regions, ARM/Terraform, per-service API tokens). The platform it describes is now HOPE (this repo) plus the separate `hope-v2-deployment` repo on a single k3s node.

## 2. Current State Evaluation (read 2026-10-06, branch `dev-2.2`)

| Control asked | Current implementation | Verdict |
|---|---|---|
| Auth on every endpoint | Gateway `UnifiedAuthGuard` is deny-by-default with a boot audit that refuses startup if a route lacks `@Public()` or a permission decorator (`.claude/rules/05-nestjs-api.md` "Global Request Pipeline"); Python services use `X-Service-Token` middleware (`apps/text/src/text/api/middleware/auth.py`, rule 06). Four credential classes tested by the generated authz matrix (`apps/api/tests/e2e/task-776-route-authz-matrix.spec.ts`). | Done (differs: JWT/API-key/service-account, not one shared token) |
| Role-based "Clinical AI service accounts only" for LLM | CASL abilities plus `@RequiredSvcScopes`; service accounts are a distinct credential class (rule 08). | Done in a stronger form |
| Rate limiting | TASK-785 rate-limit service (`packages/applications/src/services/rate-limit/`, `apps/api/src/modules/throttle/`), precedence chain tenant x route > tenant > plan > platform (`docs/operations/rate-limiting.md` section 1); capacity work in `docs/implementation/TASK-993-Platform-Capacity-And-Rate-Limits/` (Review). Limits are per credential/tenant/route and DB-governed. | Partially. No per-session "10 audio-minutes per minute" STT quota and no per-clinician "5 LLM req/min" rule were found; the doc itself notes a tenant cap divides across doctors (`rate-limiting.md:86`). |
| Upload size validation | Audio/attachment size ceilings are settings, `media.upload.maxAudioSizeMb` default 250 (`packages/applications/src/services/settings-registry/descriptors/media-upload.descriptors.ts:25`), enforced at the media route (`apps/api/src/modules/media/media.controller.ts:70`). | Done, but default is 250 MB not 100 MB (configurable per tenant; hardcoded 100 would violate the no-hardcoded-config rule, `00-project-context.md`) |
| Max prompt length | Not found as a gateway rule. Token budgets are agent/model parameters and TASK-995 (LLM timeout/KV budget) and the egress screening work (TASK-1035/1047) bound inputs indirectly. | Gap (unverified: no single documented cap) |
| Structured audit logs for every STT/TTS/LLM request | Sys-event fan-out writes `AuditLog` rows (`SysEventService`, rule 04); JSON logs via `hope_obs` / `LoggingService` with PHI redaction (rule 06, rule 05 "Errors & Logging"); telemetry per TASK-999. | Done |
| Logs immutable and retained >= 90 days | Loki and Tempo were shortened from 90 days to 30 (`hope-v2-deployment/docs/observability-retention.md:4-5`). No DB trigger or rule making `AuditLog` append-only was found in the Prisma migrations (search for trigger/immutable/revoke on audit_log returned nothing). | Gap |
| Standard error code + circuit-breaker state for UI | `apps/text` has per-engine circuit breakers (`apps/text/src/text/services/circuit_breaker.py`, created at `main.py:256-259`); gateway exposes `health.controller.ts` and `admin-health-services.controller.ts`. Whether breaker state reaches a clinician-facing "disable Get Summary" control was not verified. | Partially (unverified for UI) |
| Private subnet, gateway-only ingress | Everything is an in-cluster k3s workload, ingress is Traefik behind in-cluster `cloudflared` (`09-infrastructure-devops.md`). NetworkPolicy manifests exist for only some workloads (search hits: vllm, stt, tts-v2 in `hope-v2-deployment/deployment/k8s/base`). | Partially, verify a default-deny policy |
| Vault secrets, 90-day rotation | In-cluster Vault, AppRole, dynamic DB creds, Transit (rule 09, `docs/operations/vault/`); JWT rotation in `docs/operations/jwt-secret-rotation.md`. No automatic 90-day rotation job identified. | Partially |
| Prometheus metrics and alerts | Prometheus/Grafana/Loki/Tempo/Alertmanager in-cluster; rules `deployment/k8s/base/prometheus/platform.rules.yml`; SLOs in `observability-slos.md`; receiver not wired (`observability-alerting.md` section 4 "TODO(owner)"). | Done except alert receiver |
| Autoscaling, >= 2 instances per region | Single node, single namespace, time-sliced GPUs (rule 09 Topology); `zero-downtime-deployments.md` describes the honest scope. No HPA assumption is valid. | Not applicable on the current estate (aspirational for prod/EKS overlays) |
| Patch management / IaC | GitOps (`hope-v2-deployment`, Argo CD, render/validate CI with eight blocking jobs, Trivy + gitleaks in CI). No scheduled monthly patch process is documented. | Partially |
| `CONTROLS.md` | Does not exist. Closest: `docs/operations/*`, `docs/architecture/*`. | Gap |

## 3. Root Cause / Gap

Not a code defect. The issue pre-dates HOPE and is a controls-documentation epic. Concrete gaps against the issue as filed:

1. No single controls document mapping control -> where implemented -> how to test.
2. Log retention (30 d) is below the requested >= 90 d; audit-row immutability is not enforced in the database.
3. No per-clinician LLM or per-session STT quota matching the numbers in the issue.
4. No documented maximum prompt length, and unverified UI exposure of circuit-breaker state.

## 4. Implementation Plan (only if the owner wants the issue closed as a deliverable)

Write the doc first; fix gaps only after owner decisions (section 5).

1. Tests first: none for the doc itself. For gap 2, a migration test asserting an `AuditLog` UPDATE/DELETE is rejected (RED), then the guard. For gap 3, rate-limit service unit tests with a rule keyed by user id and by STT session.
2. Order: (a) `docs/operations/controls.md` (not repo root; follow the existing docs layout) with a table per control, owner decision references and a "how to test" command each (`pnpm test:e2e <spec>`, `pnpm stack:dev:doctor`); (b) retention decision applied in `hope-v2-deployment` (Loki/Tempo values) and an audit-retention descriptor in the settings registry if kept in DB; (c) rate-limit rules via the existing `RateLimitRule` table (data, not code).
3. Verification: doc links resolve; `pnpm api:openapi:check` unaffected; for (b)/(c) run only the new/changed test files.

## 5. Risks / Open Questions (owner decisions)

- OD-1: Is >= 90 d the real requirement? It was explicitly reduced to 30 d on 2026-09-02 for observability; audit-log (DB) retention is a separate question from log retention. PHI minimisation argues against longer retention.
- OD-2: Are the per-clinician LLM (5/min) and STT (10 audio-min/min) numbers still wanted? Per-clinician limits conflict with tenant-plan limits, and TASK-993 owns capacity design.
- OD-3: Should this stay one issue? Recommend closing it as superseded by TASK-785/993/999/1015/1035 plus one docs ticket for `controls.md`.
- OD-4: Hardcoding 100 MB is out of bounds (config principles); keep it a setting and change the default only if desired.
- Not verified: breaker-state exposure to the UI; NetworkPolicy default-deny; Vault 90-day rotation job.

## 6. Implementation Summary

Not started.

## 7. Change History

| Date | Change |
|---|---|
| 2026-10-06 | Created from ALaaSv3.0#106 after review of hope-v2 `dev-2.2`. |
