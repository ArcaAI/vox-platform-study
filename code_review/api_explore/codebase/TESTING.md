# Testing

## Test suite overview
| Type | Location | Runner | Count/notes | Evidence |
|---|---|---|---|---|
| **Unit** | `apps/api/src/**/*.test.ts`, `apps/api/tests/unit/**/*.test.ts` | Vitest | 441 in `src/`, 1 in `tests/unit/` | [apps/api/vitest.config.ts:19-33](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/vitest.config.ts#L19-L33), [shell results](./logs/vitest-coverage.log) |
| **Integration** | `apps/api/tests/integration/*.spec.ts` | Vitest | 4 specs (`auth-coverage`, `full-route-walk`, `summary-provenance`, `test-app-module`) | [apps/api/tests/integration/](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/tests/integration/), [apps/api/vitest.config.ts:19-33] |
| **E2E** | `apps/api/tests/e2e/*.spec.ts` | Playwright | 165 specs (31 cross-tenant). Requires live gateway on port 8968. | [apps/api/package.json:70](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/package.json#L70), [playwright.config.ts:212-260](https://github.com/ArcaAI/project-hope/tree/dev-2.2/playwright.config.ts#L212-L260), [apps/api/README.md:249] |

## Latest Vitest coverage (2026-10-23)
- **Command:** `pnpm --filter @arcaai/api exec vitest run --coverage --coverage.reportsDirectory=../review/api_explore/coverage` (from repo root)
- **Results:** `444 passed | 2 skipped` test files, `5336 passed | 11 skipped` tests. Duration ~181s. Exit 0.
- **Coverage:** Statements **87.72%** (10883/12407), Branches **78.04%** (6062/7768), Functions **86.12%** (2153/2500). 450 instrumented files.
- **Details:** [docs/06a-COVERAGE-BY-AREA.md](./docs/06a-COVERAGE-BY-AREA.md)
  - [inventory/coverage-summary.json](./inventory/coverage-summary.json)
  - [coverage/](./coverage/)

## Route/test traceability (from manifest)
- **Routes:** 818, **Controllers:** 148, **Modules:** 77, **OpenAPI paths:** 607.
- **Public:** 62, **API-key forbidden:** 573, **API-key allowed:** 189, **OCC (`requiresIfMatch`):** 69, **API-excluded:** 57.
- **Routes with no permission/scope declared:** 78.
- **Routes with no unit or e2e test reference:** 9.
- **Routes with no e2e route reference:** 463.
- **Controllers with no test references:** `MyTenantDocumentTemplateController`, `StorageAccessKeyController`, `WorkflowInvariantRuleController`.
- **Details:** [inventory/summary.json](./inventory/summary.json)
  - [inventory/routes.csv](./inventory/routes.csv)
  - [inventory/routes-by-module.md](./inventory/routes-by-module.md)
  - [inventory/controllers.json](./inventory/controllers.json)

## Lowest coverage areas (by statements)
| Area | Files | Statements | Branches | Functions | Notes |
|---|---:|---:|---:|---:|---|
| `workflow-sandbox-run` | 4 | 23.33% | 0.0% | 33.33% | Sandbox stream service very low. |
| `workflow-invariant-rule` | 2 | 30.0% | 0.0% | 0.0% | Controller **0% functions/branches**, no tests. |
| `openapi` | 3 | 30.88% | 33.33% | 71.43% | Operation security logic low. |
| `services` | 4 | 34.78% | 36.36% | 36.36% | Graceful shutdown/service release registration low. |
| `consent` | 2 | 37.5% | 0.0% | 0.0% | Consent module low coverage. |
| `consultation-context-schema` | 2 | 35.0% | 0.0% | 16.67% | Low coverage. |
| `document-template` | 2 | 26.32% | 0.0% | 0.0% | Controller for tenant document template has **no tests** (1 route). |
| `storage-access-key` | 2 | 42.86% | 100.0% | 0.0% | **No tests** (3 routes, admin/service-account). |
| `service-account` | 4 | 50.0% | 19.05% | 81.82% | Low branches. |
| `monitoring` | 4 | 56.67% | 0.0% | 0.0% | Low. |
| `api-key` | 4 | 60.53% | 61.11% | 41.67% | Controller low. |
| `ai-routing-policy` | 2 | 62.5% | 84.62% | 50.0% | Low functions. |
| `throttle` | 9 | 72.09% | 62.93% | 72.34% | Route catalog service very low (7.81%). |
| `workers` | 2 | 53.79% | 33.87% | 44.44% | Vault rotation worker module low. |

## Lowest coverage files (≥20 statements, ≤60%)
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

## Key test patterns
- **Route auth matrix:** Uses `route-manifest.json` to sweep all routes; tests public/authz/credential class behavior. [apps/api/tests/e2e/task-776-route-authz-matrix.spec.ts](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/tests/e2e/task-776-route-authz-matrix.spec.ts)
- **Credential classes:** Tests JWT/API-key/service-account behavior. [apps/api/tests/e2e/task-776-credential-classes.spec.ts](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/tests/e2e/task-776-credential-classes.spec.ts)
- **Integration boot:** `test-app-module` helper with many overrides to boot full app without live infra. [apps/api/tests/helpers/test-app-module.ts](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/tests/helpers/test-app-module.ts), [apps/api/tests/integration/full-route-walk.spec.ts](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/tests/integration/full-route-walk.spec.ts)
- **Auth coverage:** Static metadata walk ensures routes have `@Public()` or permissions. [apps/api/tests/integration/auth-coverage.spec.ts](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/tests/integration/auth-coverage.spec.ts)

## Evidence
- Vitest log: [logs/vitest-coverage.log](./logs/vitest-coverage.log)
- Coverage report: [docs/06a-COVERAGE-BY-AREA.md](./docs/06a-COVERAGE-BY-AREA.md)
- Route inventory: [inventory/summary.json](./inventory/summary.json)
- Route manifest helper: [apps/api/tests/e2e/helpers/route-manifest.helper.ts](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/tests/e2e/helpers/route-manifest.helper.ts)
- Playwright config: [playwright.config.ts](https://github.com/ArcaAI/project-hope/tree/dev-2.2/playwright.config.ts)