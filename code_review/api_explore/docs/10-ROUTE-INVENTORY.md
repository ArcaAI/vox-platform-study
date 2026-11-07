# Route Inventory

**Repository:** [ArcaAI/project-hope](https://github.com/ArcaAI/project-hope/tree/dev-2.2)  
**Sources:** `apps/api/route-manifest.json`, `apps/api/openapi.json` (compiled), test files under `apps/api/src` and `apps/api/test`/e2e.  
**Generated artifacts:** [inventory/routes.json](../inventory/routes.json), [inventory/routes.csv](../inventory/routes.csv), [inventory/routes-by-module.md](../inventory/routes-by-module.md), [inventory/summary.json](../inventory/summary.json), [inventory/controllers.json](../inventory/controllers.json), [inventory/modules.json](../inventory/modules.json)

## Summary

| Metric | Value |
|---|---|
| Total routes | 818 |
| Controllers | 148 |
| Modules | 77 |
| OpenAPI paths | 607 |
| Public routes | 62 |
| API-key forbidden | 573 |
| API-key allowed | 189 |
| Requires If-Match (OCC) | 69 |
| API-excluded | 57 |
| Routes with no permission and no scope | 78 |
| Routes without any test reference | 9 |
| Routes without e2e route reference | 463 |

Method breakdown: GET 404, POST 267, PATCH 63, PUT 31, DELETE 53.

## How routes are discovered

The inventory is built by:
1. Reading `route-manifest.json` and `openapi.json` from the built API artifacts.
2. Mapping routes to controllers/modules.
3. Cross-referencing against test files (unit/integration/e2e) for route mentions and e2e coverage.
4. Extracting decorators and metadata (permissions, scopes, API key rules, OCC requirements, etc.).

See [tools/build_inventory.py](../tools/build_inventory.py) for details.

## Key files

- [inventory/routes.json](../inventory/routes.json) - Full route details (path, method, controller, module, decorators, test refs).
- [inventory/routes.csv](../inventory/routes.csv) - CSV export for analysis.
- [inventory/routes-by-module.md](../inventory/routes-by-module.md) - Routes grouped by module.
- [inventory/controllers.json](../inventory/controllers.json) - Controller → file/line/decorators/routes/test refs.
- [inventory/modules.json](../inventory/modules.json) - Module → file/line/controllers/services/test counts.
- [inventory/summary.json](../inventory/summary.json) - Aggregate statistics.

## Notable findings

- **Untested controllers:** `MyTenantDocumentTemplateController`, `StorageAccessKeyController`, `WorkflowInvariantRuleController` (see [summary.json](../inventory/summary.json)).
- **Many routes lack e2e coverage:** 463/818 routes have no direct e2e route reference (see [docs/09-TEST-COVERAGE-GAPS.md](./09-TEST-COVERAGE-GAPS.md)).
- **Routes with no permission/scope:** 78 routes need review for authorization coverage.
- **OCC coverage:** 69 routes require If-Match; OCC coverage is audited at boot (warn-only).

## References

- [codebase/ARCHITECTURE.md](../codebase/ARCHITECTURE.md) - Request pipeline and guard order
- [codebase/CONCERNS.md](../codebase/CONCERNS.md) - Security/coverage concerns
- [docs/09-TEST-COVERAGE-GAPS.md](./09-TEST-COVERAGE-GAPS.md) - Detailed test gaps
- [diagrams/api-gateway-internals-deep-dive.html](../diagrams/api-gateway-internals-deep-dive.html) - Visual map of guards/interceptors/filters and modules
