# Traceability Matrix

**Repository:** [ArcaAI/project-hope](https://github.com/ArcaAI/project-hope/tree/dev-2.2)  
**Purpose:** Trace routes → controllers → modules → tests → coverage → docs/diagrams.

## Key artifacts

| Artifact | What it provides | Path |
|---|---|---|
| Route inventory (JSON) | Full route details with decorators, auth rules, test refs | [inventory/routes.json](../inventory/routes.json) |
| Route inventory (CSV) | Tabular route data for analysis | [inventory/routes.csv](../inventory/routes.csv) |
| Routes by module | Grouping for navigation | [inventory/routes-by-module.md](../inventory/routes-by-module.md) |
| Controllers map | Controller → file/line/decorators/routes/test refs | [inventory/controllers.json](../inventory/controllers.json) |
| Modules map | Module → file/line/controllers/services/test counts | [inventory/modules.json](../inventory/modules.json) |
| Inventory summary | Aggregate stats and issues | [inventory/summary.json](../inventory/summary.json) |
| Coverage by area | Per-area and lowest-file coverage | [docs/06a-COVERAGE-BY-AREA.md](./06a-COVERAGE-BY-AREA.md) |
| Test gaps | Detailed gap analysis | [docs/09-TEST-COVERAGE-GAPS.md](./09-TEST-COVERAGE-GAPS.md) |
| Architecture docs | Bootstrap/guards/modules | [codebase/ARCHITECTURE.md](../codebase/ARCHITECTURE.md) |
| Concerns | Security/coverage issues | [codebase/CONCERNS.md](../codebase/CONCERNS.md) |
| Diagrams | Visual maps with source references | [diagrams/README.md](../diagrams/README.md), [diagrams/api-gateway-internals-deep-dive.html](../diagrams/api-gateway-internals-deep-dive.html) |

## Traceability examples

| Topic | Trace |
|---|---|
| Global guard order | [app.module.ts](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/app.module.ts) (APP_GUARD wiring) → [codebase/ARCHITECTURE.md](../codebase/ARCHITECTURE.md) → [diagrams/api-gateway-internals-deep-dive.html](../diagrams/api-gateway-internals-deep-dive.html) |
| AuthN/AuthZ | [UnifiedAuthGuard](https://github.com/ArcaAI/project-hope/tree/dev-2.2/packages/applications/src/authorization/unified-auth.guard.ts), [AuthorizationGuard](https://github.com/ArcaAI/project-hope/tree/dev-2.2/packages/applications/src/authorization/authorization.guard.ts) → [docs/08-CODE-REVIEW.md](./08-CODE-REVIEW.md) → diagrams |
| Tenant isolation | [database/tenant-context.provider.ts](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/database/tenant-context.provider.ts), [ClsGuard](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/app.module.ts) → [codebase/ARCHITECTURE.md](../codebase/ARCHITECTURE.md) |
| Untested controllers | [inventory/summary.json](../inventory/summary.json) → [docs/09-TEST-COVERAGE-GAPS.md](./09-TEST-COVERAGE-GAPS.md) → [docs/08-CODE-REVIEW.md](./08-CODE-REVIEW.md) |
| Boot audits | [main.ts](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/main.ts) → [codebase/ARCHITECTURE.md](../codebase/ARCHITECTURE.md) → diagrams |

## Using the traceability

1. Start with [README.md](../README.md) for navigation.
2. For a route: look in [inventory/routes.json](../inventory/routes.json) or [inventory/routes-by-module.md](../inventory/routes-by-module.md) to find controller/module/tests.
3. For implementation: follow controller → module imports in [inventory/modules.json](../inventory/modules.json) and source files.
4. For security/coverage: check [codebase/CONCERNS.md](../codebase/CONCERNS.md), [docs/08-CODE-REVIEW.md](./08-CODE-REVIEW.md), [docs/09-TEST-COVERAGE-GAPS.md](./09-TEST-COVERAGE-GAPS.md).
5. For big-picture: open [diagrams/api-gateway-internals-deep-dive.html](../diagrams/api-gateway-internals-deep-dive.html) and click nodes to see source references.
