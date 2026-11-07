# API Explore - Executive Summary

**Repository:** `/Users/apple/repos/VOX/project-hope` (apps/api NestJS gateway)  
**HEAD:** `4e1434992f4eed101836aa532311b31c3402ac47` (clean)  
**Documentation output:** `/Users/apple/repos/VOX/review/api_explore` (no writes to repo)  
**Generated:** 2026-10-23

## What is documented
- **Codebase knowledge (7 docs):**
  - [codebase/STACK.md](./codebase/STACK.md)
  - [codebase/STRUCTURE.md](./codebase/STRUCTURE.md)
  - [codebase/ARCHITECTURE.md](./codebase/ARCHITECTURE.md)
  - [codebase/CONVENTIONS.md](./codebase/CONVENTIONS.md)
  - [codebase/INTEGRATIONS.md](./codebase/INTEGRATIONS.md)
  - [codebase/TESTING.md](./codebase/TESTING.md)
  - [codebase/CONCERNS.md](./codebase/CONCERNS.md)
- **Route inventory:**
  - [inventory/routes.json](./inventory/routes.json)
  - [inventory/routes.csv](./inventory/routes.csv)
  - [inventory/routes-by-module.md](./inventory/routes-by-module.md)
  - [inventory/summary.json](./inventory/summary.json)
- **Source maps:**
  - [inventory/controllers.json](./inventory/controllers.json)
  - [inventory/modules.json](./inventory/modules.json)
- **Coverage:**
  - [docs/06a-COVERAGE-BY-AREA.md](./docs/06a-COVERAGE-BY-AREA.md)
  - [inventory/coverage-summary.json](./inventory/coverage-summary.json)
  - [coverage/](./coverage/)
- **Skills/plan logs:**
  - [00-skills-and-plan.md](./00-skills-and-plan.md)
  - [01-code-documentation-skills.md](./01-code-documentation-skills.md)
  - [02-install-set.md](./02-install-set.md)
- **Tools/scripts:**
  - [tools/build_inventory.py](./tools/build_inventory.py)
  - [tools/build_sourcemap.py](./tools/build_sourcemap.py)
  - [tools/coverage_report.py](./tools/coverage_report.py)
- **Diagrams:**
  - [diagrams/README.md](./diagrams/README.md)
  - [diagrams/api-system-context.html](./diagrams/api-system-context.html)
  - [diagrams/api-gateway-internals-deep-dive.html](./diagrams/api-gateway-internals-deep-dive.html)

## Key numbers
| Metric | Value | Source |
|---|---|---|
| Routes | 818 | [inventory/summary.json](./inventory/summary.json) |
| Controllers | 148 | [inventory/summary.json](./inventory/summary.json) |
| Modules | 77 | [inventory/summary.json](./inventory/summary.json) |
| OpenAPI paths | 607 | [inventory/summary.json](./inventory/summary.json) |
| Public routes | 62 | [inventory/summary.json](./inventory/summary.json) |
| API-key forbidden | 573 | [inventory/summary.json](./inventory/summary.json) |
| API-key allowed | 189 | [inventory/summary.json](./inventory/summary.json) |
| OCC (`requiresIfMatch`) | 69 | [inventory/summary.json](./inventory/summary.json) |
| API-excluded | 57 | [inventory/summary.json](./inventory/summary.json) |
| Routes with no permission/scope | 78 | [inventory/summary.json](./inventory/summary.json) |
| Routes with no any test reference | 9 | [inventory/summary.json](./inventory/summary.json) |
| Routes with no e2e route reference | 463 | [inventory/summary.json](./inventory/summary.json) |
| Controllers with no test refs | 3 | [inventory/summary.json](./inventory/summary.json) |
| Vitest: test files passed/skipped | 444/2 | [logs/vitest-coverage.log](./logs/vitest-coverage.log) |
| Vitest: tests passed/skipped | 5336/11 | [logs/vitest-coverage.log](./logs/vitest-coverage.log) |
| Coverage: statements/branches/functions | 87.72% / 78.04% / 86.12% | [docs/06a-COVERAGE-BY-AREA.md](./docs/06a-COVERAGE-BY-AREA.md) |

## Top issues to fix
1. **Untested controllers:** `MyTenantDocumentTemplateController` (1 route), `StorageAccessKeyController` (3 routes), `WorkflowInvariantRuleController` (5 routes). Add tests. [codebase/CONCERNS.md#1](./codebase/CONCERNS.md#1)
2. **Very low coverage:** `graceful-shutdown.service.ts` (4.76%), `route-catalog.service.ts` (7.81%), `workflow-sandbox-stream.service.ts` (8.51%), `openapi/operation-security.ts` (18.97%), plus low-coverage modules (sandbox, invariant rules, document template, storage-access-key, consent). [codebase/CONCERNS.md#2](./codebase/CONCERNS.md#2)
3. **E2e coverage gaps:** 463 routes without direct e2e route references. [codebase/CONCERNS.md#3](./codebase/CONCERNS.md#3)
4. **Routes with no permission/scope:** 78 routes need review. [codebase/CONCERNS.md#4](./codebase/CONCERNS.md#4)

## Quick navigation
- **Understand bootstrap/guards:** [codebase/ARCHITECTURE.md](./codebase/ARCHITECTURE.md)
- **Visual architecture:** [diagrams/README.md](./diagrams/README.md) — two clickable Archify diagrams with source references
- **Find routes by module/controller:** [inventory/routes-by-module.md](./inventory/routes-by-module.md), [inventory/controllers.json](./inventory/controllers.json)
- **Check coverage:** [docs/06a-COVERAGE-BY-AREA.md](./docs/06a-COVERAGE-BY-AREA.md)
- **Security posture:** [codebase/CONCERNS.md#6](./codebase/CONCERNS.md#6)

## Notes
- All outputs written to `../review/api_explore` (outside repo). No files modified in `apps/api`.
- Coverage run redirected to `coverage/` in this folder.
- Route inventory generated from `route-manifest.json` + `openapi.json` with test cross-references.
- Diagrams: Standalone Archify HTML artifacts in `diagrams/` (system context and gateway internals deep dive), finalized with all gates passing. Each node links to source files at the pinned revision.