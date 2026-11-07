# Conventions

## Code organization
- **Feature modules:** Each business surface in `src/modules/<name>/` typically contains `<name>.module.ts`, `<name>.controller.ts`, services, DTOs, entities/types. [apps/api/README.md:40]
- **Global wiring:** Interceptors/guards/filters/providers wired in `AppModule`. [apps/api/src/app.module.ts:617-620](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/app.module.ts#L617-L620)
- **Bootstrap separation:** Boot-time audits live in `src/bootstrap/`. [apps/api/src/bootstrap/](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/bootstrap/)
- **Shared utilities:** `src/shared/`, `src/common/`, `src/services/`, `src/workers/`. [apps/api/README.md:40-47]

## Naming
- **Controllers:** `*Controller` (e.g., `ConsultationController`). [inventory/controllers.json](./inventory/controllers.json)
- **Modules:** `*Module`. [apps/api/src/app.module.ts:305-358](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/app.module.ts#L305-L358)
- **Guards/Interceptors/Filters:** `*Guard`, `*Interceptor`, `*Filter`. [apps/api/src/guards/](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/guards/)
  - [apps/api/src/interceptors/](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/interceptors/)
  - [apps/api/src/filters/](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/filters/)

## Authorization conventions
- **Deny by default:** `UnifiedAuthGuard` is global; `@Public()` only opt-out. [packages/applications/src/authorization/unified-auth.guard.ts:377-448](https://github.com/ArcaAI/project-hope/tree/dev-2.2/packages/applications/src/authorization/unified-auth.guard.ts#L377-L448)
- **API keys:** Must declare `@RequiredScopes(...)`; scopes + bound principal abilities both required. [packages/applications/src/authorization/unified-auth.guard.ts:331-377](https://github.com/ArcaAI/project-hope/tree/dev-2.2/packages/applications/src/authorization/unified-auth.guard.ts#L331-L377)
- **Service accounts:** `@ForbidServiceAccount()`, `svc:*` scopes. [packages/applications/src/authorization/unified-auth.guard.ts:620-760](https://github.com/ArcaAI/project-hope/tree/dev-2.2/packages/applications/src/authorization/unified-auth.guard.ts#L620-L760)
- **Admin routes:** Typically `@CanManage('X')` or permission decorators; class-level auth patterns vary. [apps/api/README.md:230-240]
- **404-over-403:** Cross-tenant access returns 404. [apps/api/README.md:239]
- **OCC:** Use `@RequiresIfMatch()` + `@ExpectedVersion()`. [apps/api/README.md:227-229]

## Error handling
- **Unified envelope:** `{statusCode, code, message, correlationId, details?, metadata?}`. [apps/api/src/filters/error-envelope.ts](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/filters/error-envelope.ts)
- **Filter order:** Last-registered wins (AllExceptions → HttpExceptionEnvelope → DataNotFound → Consent). [apps/api/src/app.module.ts:276-300](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/app.module.ts#L276-L300)
- **Guards throw before interceptors:** 401/403/429 from guards not seen by `ExceptionInterceptor`. [apps/api/README.md:195]

## Testing conventions
- **Unit:** `*.test.ts` under `src/` or `tests/unit/`. [apps/api/vitest.config.ts:19-33]
- **Integration:** `tests/integration/*.spec.ts` (Vitest). [apps/api/vitest.config.ts:19-33]
- **E2E:** Playwright `tests/e2e/*.spec.ts`. [apps/api/package.json:70, playwright.config.ts]
- **Route auth matrix:** `tests/e2e/task-776-route-authz-matrix.spec.ts` uses `route-manifest.json`. [apps/api/tests/e2e/task-776-route-authz-matrix.spec.ts](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/tests/e2e/task-776-route-authz-matrix.spec.ts), [apps/api/tests/e2e/helpers/route-manifest.helper.ts](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/tests/e2e/helpers/route-manifest.helper.ts)
- **Credential classes:** `tests/e2e/task-776-credential-classes.spec.ts`. [apps/api/tests/e2e/task-776-credential-classes.spec.ts](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/tests/e2e/task-776-credential-classes.spec.ts)

## Configuration
- **Env schema:** `src/config/env.schema.ts`, descriptors in `src/config/env.descriptors.ts`. Fail-fast via `apiEnv()`. [apps/api/src/main.ts:64](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/main.ts#L64), [apps/api/src/config/](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/config/)
- **Global prefix:** `API_GLOBAL_PREFIX='api/v1'`, excluded `/metrics`. [apps/api/src/global-prefix.config.ts](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/global-prefix.config.ts)
- **Documentation artifacts:** Must regenerate `route-manifest.json`, `openapi.json`, `api:portal`, `vox-node gen:admin` together. [apps/api/README.md:232-248]

## Gotchas
- `route-manifest.json` and `openapi.json` are generated artifacts; do not edit manually. [apps/api/README.md:232-248]
- Guard order is load-bearing. [apps/api/src/app.module.ts:191-267](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/app.module.ts#L191-L267)
- `Shared/base-proxy.controller.ts` has no subclasses (unused). [apps/api/README.md:246]
- `apps/api/test/` is legacy Jest scaffold (unused); real tests in `apps/api/tests/`. [apps/api/README.md:251]
- `pnpm api:test:e2e` needs live gateway on port 8968. [apps/api/README.md:249]

## Evidence
- AppModule: [apps/api/src/app.module.ts](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/app.module.ts)
- UnifiedAuthGuard: [packages/applications/src/authorization/unified-auth.guard.ts](https://github.com/ArcaAI/project-hope/tree/dev-2.2/packages/applications/src/authorization/unified-auth.guard.ts)
- Vitest config: [apps/api/vitest.config.ts](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/vitest.config.ts)
- Playwright config: [playwright.config.ts](https://github.com/ArcaAI/project-hope/tree/dev-2.2/playwright.config.ts)
- Route manifest helper: [apps/api/tests/e2e/helpers/route-manifest.helper.ts](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/tests/e2e/helpers/route-manifest.helper.ts)