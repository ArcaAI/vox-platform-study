# Test Coverage Gaps

**Repository:** [ArcaAI/project-hope](https://github.com/ArcaAI/project-hope/tree/dev-2.2)  
**Source of truth:** [logs/vitest-coverage.log](../logs/vitest-coverage.log), [docs/06a-COVERAGE-BY-AREA.md](./06a-COVERAGE-BY-AREA.md), [inventory/summary.json](../inventory/summary.json), [inventory/controllers.json](../inventory/controllers.json), [inventory/routes.json](../inventory/routes.json)

## Overall coverage

| Metric | Value | Files |
|---|---|---|
| Statements | 87.72% | 450 files |
| Branches | 78.04% | 450 files |
| Functions | 86.12% | 450 files |
| Test files | 444 passed / 2 skipped | - |
| Tests | 5336 passed / 11 skipped | - |

Coverage run: `vitest run --coverage` with `--coverage.reportsDirectory` redirected to `../review/api_explore/coverage/`.

## Controllers with no test references

From [inventory/summary.json](../inventory/summary.json):

| Controller | Routes | Notes |
|---|---|---|
| `MyTenantDocumentTemplateController` | 1 | No test file references found in inventory. |
| `StorageAccessKeyController` | 3 | No test file references found in inventory. |
| `WorkflowInvariantRuleController` | 5 | No test file references found in inventory. |

## Routes with no tests or e2e coverage

| Category | Count | Source |
|---|---|---|
| Routes with no permission/scope declared | 78 | [inventory/summary.json](../inventory/summary.json) |
| Routes without any test reference | 9 | [inventory/summary.json](../inventory/summary.json) |
| Routes without direct e2e route reference | 463 | [inventory/summary.json](../inventory/summary.json) |
| API-excluded routes | 57 | [inventory/summary.json](../inventory/summary.json) |

See [codebase/CONCERNS.md](../codebase/CONCERNS.md) for context and [inventory/routes.csv](../inventory/routes.csv) for full route details.

## Lowest coverage areas (from coverage report)

Top low-coverage files/areas (from [docs/06a-COVERAGE-BY-AREA.md](./06a-COVERAGE-BY-AREA.md)):

| File/Area | Statements | Branches | Functions | Notes |
|---|---|---|---|---|
| `graceful-shutdown.service.ts` | 4.76% | 0% | 0% | Operational/shutdown path. |
| `route-catalog.service.ts` | 7.81% | 3.13% | 4.55% | Route catalog generation/serving. |
| `workflow-sandbox-stream.service.ts` | 8.51% | 2.13% | 0% | Workflow sandbox streaming. |
| `openapi/operation-security.ts` | 18.97% | 20% | 14.29% | OpenAPI security mapping. |
| `document-template/...` (related) | Low | Low | Low | MyTenantDocumentTemplateController area. |
| `storage-access-key/...` (related) | Low | Low | Low | Storage access keys. |
| `workflows/invariant-rules/...` | Low | Low | Low | Workflow invariant rules. |
| `consent/...` | Low (in places) | Low | Low | Consent flows need careful testing. |
| `sandbox/...` | Low | Low | Low | Workflow sandbox features. |

## Recommended test additions

| Priority | Target | Suggested tests | Rationale |
|---|---|---|---|
| P0 | `MyTenantDocumentTemplateController` | Unit + e2e tests for the 1 route (authz, tenant isolation, validation). | No test references; likely admin/tenant feature. |
| P0 | `StorageAccessKeyController` | Unit + e2e tests for 3 routes (create/list/revoke, scope checks). | No test references; security-sensitive (keys). |
| P0 | `WorkflowInvariantRuleController` | Unit + e2e tests for 5 routes (CRUD, validation, authz). | No test references; workflow governance. |
| P0 | Routes with no permission/scope (78) | Review and add coverage/e2e where appropriate. | Potential security posture gaps. |
| P1 | `graceful-shutdown.service.ts` | Unit tests for shutdown hooks, timeouts, cleanup. | Critical for reliability. |
| P1 | `route-catalog.service.ts` | Unit tests for catalog building/filtering. | Used for discovery/ops. |
| P1 | Workflow sandbox/invariants | Unit + integration tests. | Low coverage areas. |
| P1 | High-risk admin routes | Expand e2e coverage to reduce 463-route gap. | Admin surfaces need protection. |

## How to reproduce

```bash
# From repo root
cd apps/api
pnpm vitest run --coverage --coverage.reportsDirectory /path/to/review/api_explore/coverage
```

Or see existing artifacts in this folder: [logs/vitest-coverage.log](../logs/vitest-coverage.log) and [coverage/](../coverage/).

## References

- [inventory/summary.json](../inventory/summary.json)
- [inventory/controllers.json](../inventory/controllers.json)
- [docs/06a-COVERAGE-BY-AREA.md](./06a-COVERAGE-BY-AREA.md)
- [codebase/CONCERNS.md](../codebase/CONCERNS.md)
- [codebase/TESTING.md](../codebase/TESTING.md)
