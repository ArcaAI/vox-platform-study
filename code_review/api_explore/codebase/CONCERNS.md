# Concerns

> Issues identified from code inspection, audits, route inventory, and test coverage. All items include evidence paths/lines where possible.

## Critical / High

### 1) Controllers with zero test references (routes untested by unit/e2e scans)
| Controller | Module | Routes | Notes | Evidence |
|---|---|---|---|---|
| `MyTenantDocumentTemplateController` | `document-template` | 1 | Class line ~199, has auth decorators (`@Authorize()`, `@RequiredScopes('tenant:document-template:read')`), no unit/e2e references found. | [inventory/controllers.json](./inventory/controllers.json), [inventory/summary.json:28-32](./inventory/summary.json#L28-L32), [apps/api/src/modules/document-template/document-template.controller.ts:199](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/modules/document-template/document-template.controller.ts#L199) |
| `StorageAccessKeyController` | `storage-access-key` | 3 | Admin routes, `@ForbidApiKey()`, `@RequiredSvcScopes('svc:admin:storage-key:manage')`, `@CanManage('Tenant')`. No tests. | [inventory/controllers.json](./inventory/controllers.json), [apps/api/src/modules/storage-access-key/storage-access-key.controller.ts:17](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/modules/storage-access-key/storage-access-key.controller.ts#L17) |
| `WorkflowInvariantRuleController` | `workflow-invariant-rule` | 5 | Admin routes, `@ForbidApiKey()`, `@ForbidServiceAccount()`, `@CanManage('WorkflowInvariantRule')`, 1 route has `requiresIfMatch`. No tests. Coverage 30%. | [inventory/controllers.json](./inventory/controllers.json), [docs/06a-COVERAGE-BY-AREA.md:82-83](./docs/06a-COVERAGE-BY-AREA.md#L82-L83), [apps/api/src/modules/workflow-invariant-rule/workflow-invariant-rule.controller.ts:49](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/modules/workflow-invariant-rule/workflow-invariant-rule.controller.ts#L49) |

**Action:** Add unit tests (and e2e where appropriate) for these controllers; verify authz behavior matches route-manifest.

### 2) Extremely low coverage areas
| Area/File | Coverage | Notes | Evidence |
|---|---|---|---|
| `src/services/graceful-shutdown.service.ts` | 4.76% stmts | Critical lifecycle component. | [docs/06a-COVERAGE-BY-AREA.md:131-148](./docs/06a-COVERAGE-BY-AREA.md#L131-L148), [apps/api/src/services/graceful-shutdown.service.ts](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/services/graceful-shutdown.service.ts) |
| `src/modules/throttle/route-catalog.service.ts` | 7.81% stmts | Throttling/catalog logic. | [docs/06a-COVERAGE-BY-AREA.md:131-148](./docs/06a-COVERAGE-BY-AREA.md#L131-L148), [apps/api/src/modules/throttle/route-catalog.service.ts](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/modules/throttle/route-catalog.service.ts) |
| `src/modules/workflow-sandbox-run/workflow-sandbox-stream.service.ts` | 8.51% stmts | Sandbox streaming. | [docs/06a-COVERAGE-BY-AREA.md:131-148](./docs/06a-COVERAGE-BY-AREA.md#L131-L148), [apps/api/src/modules/workflow-sandbox-run/workflow-sandbox-stream.service.ts](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/modules/workflow-sandbox-run/workflow-sandbox-stream.service.ts) |
| `src/openapi/operation-security.ts` | 18.97% stmts | OpenAPI security mapping. | [docs/06a-COVERAGE-BY-AREA.md:131-148](./docs/06a-COVERAGE-BY-AREA.md#L131-L148), [apps/api/src/openapi/operation-security.ts](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/openapi/operation-security.ts) |
| `src/workers/vault-rotation.worker.module.ts` | 43.4% stmts | Vault rotation worker. | [docs/06a-COVERAGE-BY-AREA.md:131-148](./docs/06a-COVERAGE-BY-AREA.md#L131-L148), [apps/api/src/workers/vault-rotation.worker.module.ts](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/workers/vault-rotation.worker.module.ts) |
| `src/modules/workflow-invariant-rule/*` | 30% stmts | Module/controller no tests. | [docs/06a-COVERAGE-BY-AREA.md:82-83](../../rereview/api_explore/docs/06a-COVERAGE-BY-AREA.md#L82-L83) |
| `src/modules/document-template/*` | 26.32% stmts | No tests. | [docs/06a-COVERAGE-BY-AREA.md:45-46](./docs/06a-COVERAGE-BY-AREA.md#L45-L46) |
| `src/modules/storage-access-key/*` | 42.86% stmts | No tests, 0% functions. | [docs/06a-COVERAGE-BY-AREA.md:89-90](./docs/06a-COVERAGE-BY-AREA.md#L89-L90) |
| `src/modules/consent/*` | 37.5% stmts | 0% functions/branches. | [docs/06a-COVERAGE-BY-AREA.md:41-42](./docs/06a-COVERAGE-BY-AREA.md#L41-L42) |
| `src/modules/consultation-context-schema/*` | 35% stmts | Low coverage. | [docs/06a-COVERAGE-BY-AREA.md:43-44](./docs/06a-COVERAGE-BY-AREA.md#L43-L44) |
| `src/services/*` | 34.78% stmts | Overall low. | [docs/06a-COVERAGE-BY-AREA.md:88-89](./docs/06a-COVERAGE-BY-AREA.md#L88-L89) |
| `src/openapi/*` | 30.88% stmts | Overall low. | [docs/06a-COVERAGE-BY-AREA.md:75-76](./docs/06a-COVERAGE-BY-AREA.md#L75-L76) |
| `src/modules/workflow-sandbox-run/*` | 23.33% stmts | Overall low. | [docs/06a-COVERAGE-BY-AREA.md:109-110](./docs/06a-COVERAGE-BY-AREA.md#L109-L110) |
| `src/modules/throttle/route-catalog.service.ts` | 7.81% stmts | Extremely low. | [docs/06a-COVERAGE-BY-AREA.md:131-148](./docs/06a-COVERAGE-BY-AREA.md#L131-L148) |

**Action:** Prioritize testing services/guards/interceptors with low coverage, especially lifecycle (graceful shutdown), throttling catalog, sandbox streaming, and OpenAPI operation security.

### 3) Many routes without e2e route references
463 routes lack direct e2e route path references; 9 lack any test reference. Unit tests may cover them, but integration/e2e coverage is uneven. [inventory/summary.json:23-25](./inventory/summary.json#L23-L25)

**Action:** Review high-value routes (admin/service-account/internal/OCC/consent) for e2e coverage.

### 4) Routes with no permission/scope declared
78 routes have no `requiredPermissions` and no `svcScopes`. Many may be public or API-excluded. Need to verify each is intentional and audited. [inventory/summary.json:22](./inventory/summary.json#L22)

**Action:** Cross-reference with route-manifest and boot audits; ensure `@Public()` or explicit permissions present.

### 5) Architecture/deployment concerns
- **Guard order load-bearing:** Reordering can break security. [apps/api/src/app.module.ts:191-267](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/app.module.ts#L191-L267)
- **Filter order load-bearing:** Last-registered wins. [apps/api/src/app.module.ts:276-300](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/app.module.ts#L276-L300)
- **Base proxy unused:** `src/shared/base-proxy.controller.ts` has no subclasses; could be dead code or future pattern. [apps/api/README.md:246](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/README.md#L246)
- **Legacy Jest scaffold:** `apps/api/test/` unused. [apps/api/README.md:251](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/README.md#L251)
- **Documentation artifacts drift:** Must regenerate together; not checked by `pnpm verify`. [apps/api/README.md:232-248](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/README.md#L232-L248)
- **E2e requires live gateway:** Hard to run in CI without setup. [apps/api/README.md:249](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/README.md#L249)
- **Platform OIDC tier retired:** Factory returns null. [apps/api/README.md:170](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/README.md#L170)

### 6) Security/operational notes from code
- **UnifiedAuthGuard:** Ambiguous credentials rejected; API keys require scopes + abilities; service accounts separate principal. [packages/applications/src/authorization/unified-auth.guard.ts:458-760](https://github.com/ArcaAI/project-hope/tree/dev-2.2/packages/applications/src/authorization/unified-auth.guard.ts#L458-L760)
- **Stream tickets:** Single-use, 30s TTL, query param only for streams. [apps/api/src/modules/auth/stream-ticket.service.ts:25-110](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/modules/auth/stream-ticket.service.ts#L25-L110), [apps/api/src/guards/jwtauth.guard.ts:32-200](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/guards/jwtauth.guard.ts#L32-L200)
- **Origin binding:** Fails closed on lookup failure (denies). [apps/api/src/guards/origin-tenant-binding.guard.ts:188-197](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/guards/origin-tenant-binding.guard.ts#L188-L197)
- **Tenant lock:** Fails closed (503) when lock state unreadable. [apps/api/src/guards/tenant-lock.guard.ts:16-54](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/guards/tenant-lock.guard.ts#L16-L54)
- **Patient consent:** Unconditional, no kill-switch; boot audit checks coverage. [apps/api/src/guards/patient-consent.guard.ts:6-140](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/guards/patient-consent.guard.ts#L6-L140)
- **SSE tenant ownership:** Pre-stream guard + periodic recheck. [apps/api/src/common/tenant-owned-resource-sse.guard.ts](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/common/tenant-owned-resource-sse.guard.ts)
- **Trust proxy not set:** Correct per comments (Cloudflare/Traefik). [apps/api/src/main.ts:222-240](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/main.ts#L222-L240)

## Evidence
- Inventory: [inventory/summary.json](./inventory/summary.json), [inventory/routes.csv](./inventory/routes.csv)
- Coverage: [docs/06a-COVERAGE-BY-AREA.md](./docs/06a-COVERAGE-BY-AREA.md)
- Controllers: [inventory/controllers.json](./inventory/controllers.json)
- AppModule: [apps/api/src/app.module.ts](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/app.module.ts)
- UnifiedAuthGuard: [packages/applications/src/authorization/unified-auth.guard.ts](https://github.com/ArcaAI/project-hope/tree/dev-2.2/packages/applications/src/authorization/unified-auth.guard.ts)
- API README: [apps/api/README.md](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/README.md)