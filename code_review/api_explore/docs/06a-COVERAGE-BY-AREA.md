# Coverage by area (Vitest/V8)

Command: `pnpm --filter @arcaai/api exec vitest run --coverage --coverage.reportsDirectory=../review/api_explore/coverage` (run from repo root; date 2026-10-23).

**Overall:** statements 87.72% (10883/12407) · branches 78.04% (6062/7768) · functions 86.12% (2153/2500) · files 450

| Area | Files | Statements | Branches | Functions |
|---|---:|---:|---:|---:|
| `admin-rate-limit` | 4 | 78.48% | 0.0% | 0.0% |
| `admin-usage` | 3 | 100.0% | 92.86% | 100.0% |
| `agent` | 8 | 86.15% | 74.15% | 83.7% |
| `agent-admin` | 3 | 86.96% | 78.12% | 82.14% |
| `agent-promotion` | 3 | 80.0% | 100.0% | 66.67% |
| `agent-trajectory` | 2 | 100.0% | 100.0% | 100.0% |
| `agentic-admin` | 2 | 94.74% | 93.33% | 100.0% |
| `ai-inference` | 8 | 92.94% | 77.03% | 97.06% |
| `ai-model` | 7 | 95.27% | 79.59% | 96.0% |
| `ai-provider-connection` | 2 | 78.95% | 50.0% | 72.73% |
| `ai-routing-policy` | 2 | 62.5% | 84.62% | 50.0% |
| `ai-service-admin` | 5 | 97.44% | 86.76% | 100.0% |
| `api-key` | 4 | 60.53% | 61.11% | 41.67% |
| `audit-log` | 2 | 90.0% | 92.86% | 71.43% |
| `auth` | 24 | 96.15% | 84.28% | 100.0% |
| `billing` | 4 | 93.1% | 100.0% | 88.89% |
| `bootstrap` | 15 | 84.79% | 68.43% | 98.28% |
| `changelog` | 3 | 100.0% | 100.0% | 100.0% |
| `common` | 7 | 87.56% | 82.01% | 90.0% |
| `config` | 3 | 95.18% | 94.55% | 84.62% |
| `consent` | 2 | 37.5% | 0.0% | 0.0% |
| `consultation` | 19 | 87.31% | 78.32% | 86.47% |
| `consultation-context-schema` | 2 | 35.0% | 0.0% | 16.67% |
| `consultation-history` | 3 | 100.0% | 100.0% | 100.0% |
| `database` | 1 | 100.0% | 100.0% | 100.0% |
| `decorators` | 10 | 95.45% | 89.39% | 86.67% |
| `department` | 2 | 68.18% | 100.0% | 36.36% |
| `dna-writing-style` | 7 | 97.14% | 90.27% | 94.55% |
| `document-template` | 2 | 26.32% | 0.0% | 0.0% |
| `entitlements` | 7 | 100.0% | 83.33% | 100.0% |
| `filters` | 9 | 89.92% | 82.22% | 97.37% |
| `global-setting` | 2 | 100.0% | 100.0% | 100.0% |
| `governed-prompt` | 2 | 100.0% | 100.0% | 100.0% |
| `guardrail-availability` | 2 | 100.0% | 100.0% | 100.0% |
| `guardrail-evaluation-internal` | 2 | 100.0% | 100.0% | 100.0% |
| `guardrail-notice` | 2 | 100.0% | 66.67% | 100.0% |
| `guardrail-policy` | 3 | 100.0% | 50.0% | 100.0% |
| `guardrail-tenant-policy` | 3 | 100.0% | 100.0% | 100.0% |
| `guards` | 8 | 97.62% | 88.65% | 100.0% |
| `harness-admin` | 4 | 91.54% | 80.72% | 89.13% |
| `health` | 3 | 96.61% | 80.0% | 92.86% |
| `inference-engines` | 2 | 71.43% | 100.0% | 50.0% |
| `interceptors` | 8 | 96.96% | 91.47% | 95.24% |
| `internal` | 12 | 95.16% | 92.91% | 93.33% |
| `knowledge` | 2 | 100.0% | 100.0% | 100.0% |
| `mcp-admin` | 2 | 100.0% | 100.0% | 100.0% |
| `media` | 2 | 100.0% | 91.67% | 100.0% |
| `model-publisher` | 1 | 100.0% | 100.0% | 100.0% |
| `model-residency` | 2 | 72.0% | 75.0% | 53.33% |
| `monitoring` | 4 | 56.67% | 0.0% | 0.0% |
| `nlp-task-instructions` | 2 | 100.0% | 100.0% | 100.0% |
| `notification` | 2 | 100.0% | 100.0% | 100.0% |
| `observability` | 6 | 100.0% | 85.71% | 100.0% |
| `openapi` | 3 | 30.88% | 33.33% | 71.43% |
| `platform-knobs` | 2 | 83.33% | 68.18% | 100.0% |
| `platform-metrics` | 2 | 100.0% | 100.0% | 100.0% |
| `prompt-inspector` | 3 | 100.0% | 100.0% | 100.0% |
| `prompt-management` | 5 | 100.0% | 94.74% | 100.0% |
| `pstudio` | 5 | 96.67% | 87.5% | 100.0% |
| `queue-admin` | 7 | 98.13% | 100.0% | 90.91% |
| `rbac` | 10 | 87.16% | 65.28% | 72.09% |
| `resource-subscription` | 2 | 87.5% | 100.0% | 85.71% |
| `scripts` | 1 | 100.0% | 100.0% | 100.0% |
| `security-policy` | 2 | 100.0% | 100.0% | 100.0% |
| `service-account` | 4 | 50.0% | 19.05% | 81.82% |
| `service-release` | 4 | 100.0% | 100.0% | 100.0% |
| `services` | 4 | 34.78% | 36.36% | 36.36% |
| `settings-catalog` | 10 | 97.46% | 84.07% | 89.29% |
| `shared` | 3 | 87.04% | 80.0% | 88.46% |
| `speech` | 6 | 89.96% | 80.38% | 90.41% |
| `src/(root)` | 10 | 95.48% | 88.68% | 92.31% |
| `storage` | 5 | 82.29% | 56.41% | 66.67% |
| `storage-access-key` | 2 | 42.86% | 100.0% | 0.0% |
| `streaming` | 17 | 89.36% | 79.59% | 92.04% |
| `tenant` | 7 | 79.25% | 85.71% | 70.0% |
| `tenant-allowed-origin` | 2 | 100.0% | 100.0% | 100.0% |
| `tenant-bucket` | 2 | 83.33% | 83.33% | 78.57% |
| `tenant-checkpoint` | 2 | 100.0% | 100.0% | 100.0% |
| `tenant-frontend-config` | 2 | 100.0% | 100.0% | 100.0% |
| `tenant-idp-config` | 2 | 88.24% | 100.0% | 80.0% |
| `tenant-storage-config` | 2 | 100.0% | 100.0% | 100.0% |
| `throttle` | 9 | 72.09% | 62.93% | 72.34% |
| `user` | 17 | 91.58% | 85.71% | 89.06% |
| `voice-profile` | 7 | 87.3% | 77.78% | 92.86% |
| `webhook` | 4 | 88.0% | 100.0% | 77.78% |
| `workers` | 2 | 53.79% | 33.87% | 44.44% |
| `workflow-assignment` | 2 | 77.78% | 75.0% | 66.67% |
| `workflow-definition` | 2 | 89.74% | 85.71% | 86.96% |
| `workflow-invariant-rule` | 2 | 30.0% | 0.0% | 0.0% |
| `workflow-node` | 2 | 100.0% | 100.0% | 100.0% |
| `workflow-run` | 5 | 78.57% | 75.0% | 55.56% |
| `workflow-sandbox-run` | 4 | 23.33% | 0.0% | 33.33% |
| `workflow-test-fixture` | 2 | 100.0% | 100.0% | 100.0% |
| `workflows` | 15 | 87.88% | 77.22% | 90.5% |

## Lowest-coverage files (≤60% statements, ≥20 statements)

| File | Statements | Branches | Functions | Uncovered |
|---|---:|---:|---:|---:|
| `src/services/graceful-shutdown.service.ts` | 4.76% | 0.0% | 0.0% | 60/63 |
| `src/modules/throttle/route-catalog.service.ts` | 7.81% | 0.0% | 0.0% | 59/64 |
| `src/modules/workflow-sandbox-run/workflow-sandbox-stream.service.ts` | 8.51% | 0.0% | 0.0% | 43/47 |
| `src/openapi/operation-security.ts` | 18.97% | 25.0% | 33.33% | 47/58 |
| `src/workers/vault-rotation.worker.module.ts` | 43.4% | 31.03% | 30.77% | 60/106 |
| `src/modules/throttle/throttle.module.ts` | 50.0% | 21.43% | 75.0% | 10/20 |
| `src/modules/api-key/api-key.controller.ts` | 53.33% | 61.11% | 45.45% | 14/30 |
| `src/modules/rbac/roles.controller.ts` | 54.05% | 57.14% | 60.0% | 17/37 |
| `src/modules/ai-routing-policy/ai-routing-policy-admin.controller.ts` | 60.0% | 84.62% | 50.0% | 12/30 |

## Highest-coverage large files (≥90%, ≥50 statements)

- `src/modules/streaming/stt-ws.gateway.ts` — 91.0% (622 statements)
- `src/modules/streaming/text-proxy.controller.ts` — 93.97% (464 statements)
- `src/modules/auth/auth.controller.ts` — 94.92% (374 statements)
- `src/modules/throttle/tiered-throttler.guard.ts` — 92.66% (177 statements)
- `src/modules/user/user.controller.ts` — 90.85% (164 statements)
- `src/modules/speech/speech-proxy.controller.ts` — 93.51% (154 statements)
- `src/modules/workflows/__tests__/fake-redis-streams.ts` — 96.58% (146 statements)
- `src/modules/workflows/workflow-run-completion.service.ts` — 92.19% (128 statements)
- `src/modules/ai-inference/ai-inference.controller.ts` — 90.55% (127 statements)
- `src/bootstrap/occ-coverage-audit.ts` — 93.39% (121 statements)
- `src/modules/ai-model/ai-model-discovery.service.ts` — 95.8% (119 statements)
- `src/interceptors/exception.interceptor.ts` — 98.31% (118 statements)
- `src/common/tenant-owned-resource.interceptor.ts` — 91.0% (100 statements)
- `src/modules/streaming/stt-run-transcript-mirror.ts` — 91.86% (86 statements)
- `src/modules/auth/admin-impersonation.controller.ts` — 98.77% (81 statements)
- `src/config/env.schema.ts` — 94.59% (74 statements)
- `src/modules/ai-service-admin/mlflow-proxy.client.ts` — 95.95% (74 statements)
- `src/modules/dna-writing-style/dna-writing-style-job-stream.ts` — 95.59% (68 statements)
- `src/modules/admin-rate-limit/dto/rate-limit.dto.ts` — 100.0% (59 statements)
- `src/modules/queue-admin/dto/queue-admin.dto.ts` — 96.55% (58 statements)
- `src/modules/streaming/run-stream-orphan-sweeper.ts` — 92.86% (56 statements)
- `src/modules/consultation/consultation-lifecycle-vocabulary.interceptor.ts` — 96.15% (52 statements)
- `src/interceptors/context.interceptor.ts` — 100.0% (51 statements)
- `src/modules/dna-writing-style/dna-writing-style.controller.ts` — 98.04% (51 statements)
- `src/modules/rbac/permission-check.controller.ts` — 90.0% (50 statements)