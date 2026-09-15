# API Gateway — NestJS entry point for HOPE

The `@arcaai/api` NestJS 11 application. It is the single entry point for every client
(web, mobile, API-key integrator, service account): it terminates HTTP/WebSocket traffic on
port 8868 under the `api/v1` global prefix, enforces auth/tenancy/consent, and proxies or
health-monitors the six downstream Python services (STT, Text, Guardrail, NLP, Harness, TTS).
Business logic lives one layer down in `@arcaai/applications`/`@arcaai/domains` — this app holds
no Prisma access and no domain rules of its own.

## Layout

| Path | What it holds |
|---|---|
| `src/main.ts` | Bootstrap: env load, global prefix, validation pipe, ETag interceptor, session cookie, security headers, and the boot-time audits (below) |
| `src/app.module.ts` | Root module — global guards/interceptors/filters, and the import list for all feature modules |
| `src/modules/` | 71 feature module directories (one per business/admin surface), each `<name>.controller.ts` + `<name>.module.ts` |
| `src/bootstrap/` | The boot-time audit functions `main.ts` runs (route-permission, API-key/service-account scope, consent coverage, OCC coverage, CASL-enforce reachability, WS gateway ownership) |
| `src/guards/` | `JwtAuthGuard`, `OidcAuthGuard`, `OriginTenantBindingGuard`, `PatientConsentGuard` |
| `src/interceptors/` | `ContextInterceptor`, `ExceptionInterceptor`, `MaintenanceInterceptor`, `ImpersonationAuditInterceptor`, `MetricsInterceptor`, `ETagInterceptor` |
| `src/filters/` | `HttpExceptionEnvelopeFilter`, `DataNotFoundExceptionFilter`, `ConsentExceptionFilter` |
| `src/decorators/` | `@RequiresIfMatch()`/`@ExpectedVersion()` (OCC), `@ApiEndpoint(...)`, `@ApiDeprecated()` |
| `src/common/` | `TenantOwnedResourceSseGuard`/interceptor/decorator (404-over-403 for `@Sse()` routes), the `pipelineId` deprecation shim |
| `src/openapi/` | `tags.ts` (the `@ApiTags` taxonomy), `api-exclude-metadata.ts`, `operation-security.ts` |
| `src/scripts/` | `emit-openapi.ts`, `emit-route-manifest.ts` — the offline generators behind `pnpm api:openapi`/`api:route-manifest` |
| `src/config/` | `env.schema.ts`/`env.descriptors.ts` — the zod-validated env surface read via `apiEnv()` |
| `src/shared/` | `base-proxy.controller.ts` (currently unused by any controller), `tenant-scope.ts`, `table-export.ts` |
| `tests/{unit,integration,e2e,helpers,setup}/` | Vitest unit/integration specs, Playwright e2e specs (147 `.spec.ts` files, including 21 `*cross-tenant*.spec.ts`), shared fixtures |
| `test/` | Legacy Jest e2e scaffold (`app.e2e-spec.ts`, `jest-e2e.json`) — no script in `package.json` runs it; e2e is Playwright via `tests/e2e/` |
| `route-manifest.json` | Generated authorization oracle — 749 routes as of this pass |
| `openapi.json` | Generated OpenAPI document |
| `docs/` | Narrative docs — see `docs/README.md` in this directory for what is current |

## Commands

| Command | Effect |
|---|---|
| `pnpm api:dev` | `nest start --debug --watch` against this package only |
| `pnpm api:dev:watch` | Same, plus watches `@arcaai/applications` |
| `pnpm api:build` | `nest build` + `tsc-alias` -> `dist/` |
| `pnpm api:start` | `pnpm --filter @arcaai/api start` (runs the built `dist/main.js`) |
| `pnpm api:test` | Vitest unit + integration suites |
| `pnpm api:test:e2e` | Playwright e2e against a **live** gateway on port 8968 (`.env.test`) — start it first with `pnpm test:up:api` |
| `pnpm api:lint` / `api:lint:fix` | ESLint over `{src,tests}` |
| `pnpm api:typecheck` | `tsc --noEmit` |
| `pnpm api:format` / `api:format:check` | Prettier over `apps/api/{src,tests}` |
| `pnpm api:route-manifest` | Build, then emit `route-manifest.json` |
| `pnpm api:openapi` | Build, then emit `openapi.json` |
| `pnpm api:portal` | Join the two into `apps/admin-console/src/server/api-docs/openapi.{admin,business}.json` |
| `pnpm api:openapi:check` / `api:portal:check` | Drift gates for the two artifacts above |
| `pnpm --filter @arcaai/vox-node gen:admin` / `gen:admin:check` | Regenerate/verify the SDK's `hope.admin.*` surface from the same two artifacts |
| `pnpm api:cleanup-orphan-consultations` | Build, then run the orphan-consultation cleanup script |

## How it works

**Global prefix.** `API_GLOBAL_PREFIX = 'api/v1'` (`src/global-prefix.config.ts`). Excluded from
it: `/metrics`, and five literal v1-compat paths that must keep their pre-gateway shape —
`api/smr/api/v1/summary/sync`, `api/smr/api/v1/presummary` (`TextCompatModule`), and
`api/stt/start_session` / `api/stt/stop_session` / `api/stt/switch` (`SttCompatModule`).

**Guard pipeline, in declaration order** (`app.module.ts`) — order is load-bearing, each guard
depends on state the one before it resolved:

1. `TieredThrottlerGuard` — runs before auth so abusive traffic is rejected before the heavier auth/tenant work.
2. `ClsGuard` — establishes the CLS context.
3. `UnifiedAuthGuard` — deny-by-default JWT / API-key / service-account auth. `@Public()` is the only opt-out.
4. `PatientConsentGuard` — consent/ABAC, unconditional, no kill-switch. Must run after auth (needs the resolved tenant/user) and before the OCC guard (a consent denial must never reach it).
5. `TenantOwnedResourceSseGuard` — pre-stream tenant assertion for `@Sse()` routes (closes a cross-tenant leak the ordinary interceptor catches too late for a stream already open).
6. `OriginTenantBindingGuard` — binds a browser `Origin` to its registered tenant; reads the CLS tenant, so it must stay after `UnifiedAuthGuard`.
7. `RequiresIfMatchGuard` — propagates the `@RequiresIfMatch()` marker for the OCC param decorator.

Interceptors run in this order: `MetricsInterceptor`, `RateLimitHeadersInterceptor`,
`ContextInterceptor`, `ExceptionInterceptor`, `MaintenanceInterceptor`,
`ImpersonationAuditInterceptor`, plus the globally-registered `ETagInterceptor` from `main.ts`.
Filters: `HttpExceptionEnvelopeFilter` (catch-all envelope, registered first so the two specific
filters below win), `DataNotFoundExceptionFilter`, `ConsentExceptionFilter`.

**Boot-time audits** (`main.ts`, functions in `src/bootstrap/`) refuse to start the process on
authorization drift rather than let it reach production: every route must carry `@Public()` or a
permission decorator; every API-key-reachable route must declare `@RequiredScopes(...)`;
`/internal/*` routes must sit off the API-key surface; admin controllers must declare no API-key
scopes and must carry `@ForbidApiKey()`; `:patientId` routes must carry a consent decorator; the
service-account surface (a third credential class alongside JWT and API key) must not leak into
either of the other two; WebSocket gateways must be classified for caller ownership; CASL-enforced
pairs must be able to actually produce their denial. One audit (`auditOptimisticConcurrencyCoverage`)
is warn-only by design — it reports versioned PATCH/PUT routes missing `If-Match` without refusing
boot, because closing that gap is a breaking client migration, not startup drift.

**Optimistic concurrency (OCC).** `_version` on an entity becomes a strong `ETag`
(`ETagInterceptor`); the client resends it as `If-Match`; `@RequiresIfMatch()` (missing header ->
428) + `@ExpectedVersion()` (header overrides body) feed `repository.updateWithVersion(...)`;
drift throws `OptimisticConcurrencyException` -> 412.

**Authorization decorators** (from `@arcaai/applications`, re-exported via `src/decorators`):
`@Public`, `@Authorize(['manage', 'Department'])`, `@AuthorizeAny`, `@CanRead/CanList/CanCreate/
CanUpdate/CanDelete/CanManage('Resource')`, `@CanAny/CanAll`. Class-level `@CanManage('X')` gates
a whole admin controller. Cross-tenant access is always 404, never 403 (404-over-403) — the two
documented exceptions are super-admin-only privilege gates on specific routes (see
`.claude/rules/05-nestjs-api.md` for the full list and the `// AUTH-NOTE:` marker convention).

**Downstream proxying.** The gateway does not proxy every Python service — only STT (streaming
audio via `SttWsGateway`, `@WebSocketGateway({ path: '/ws/stt/stream' })`, plus REST under
`audio/transcription-jobs`) and Text (`TextProxyController`, `@Controller('text-generations')` ->
`/api/v1/text-generations/...`, plus a redirect shim at `@Controller('text')`) have gateway proxy
routes. NLP, Guardrail, and Harness are reached by other Python services directly or are
health-monitored only — they have no gateway proxy route. `src/shared/base-proxy.controller.ts`
is an abstract base class that currently has zero controller subclasses; it is dead code, not a
pattern in active use.

**The five artifacts that must be regenerated together whenever a route changes** — path, verb,
DTOs, guards, or Swagger decorators:

```bash
pnpm api:build && pnpm api:route-manifest && pnpm api:openapi && pnpm api:portal && pnpm --filter @arcaai/vox-node gen:admin
```

`route-manifest.json` is the authorization oracle (per-route `isPublic`, `requiredPermissions`,
`apiKeyScopes`, `svcScopes`, `requiresIfMatch`, ...) that the e2e authorization matrix
(`tests/e2e/task-776-route-authz-matrix.spec.ts`) and the credential-class specs drive from;
`openapi.json` is the request/response type document; `api:portal` joins both into the
admin-console's audience-scoped projections; `vox-node gen:admin` regenerates the SDK's
`hope.admin.*` surface from the same two files. Full pipeline: `docs/operations/api-documentation.md`.

## Gotchas

- `pnpm api:route-manifest` and `pnpm api:openapi` each re-run `pnpm api:build` themselves —
  running both back to back builds twice. If that ~20s matters, build once and call the
  package-level `route-manifest`/`openapi` scripts directly.
- None of the five documentation artifacts are checked by `pnpm verify` (lint + typecheck + test).
  A green `verify` says nothing about documentation drift; run the `*:check` gates separately.
- `pnpm api:test:e2e` needs a **live** gateway on port 8968 under `.env.test` — start it with
  `pnpm test:up:api` first. `pnpm test:e2e -- <filter>` does not filter (the `--` is swallowed
  by the underlying script); use `npx dotenv -e .env.test -- npx playwright test <filter>`.
- `apps/api/test/` (singular) is a leftover Jest e2e scaffold with no wired script — do not
  confuse it with `apps/api/tests/` (plural), which is the real, currently-used test tree.
- `src/shared/base-proxy.controller.ts` has no subclasses today — do not extend it as if it were
  an established pattern without first checking whether it is still meant to be one.

## Related

- `.claude/rules/05-nestjs-api.md` — full guard pipeline detail, the authorization split-gate
  patterns, the API test standard, and the credential-class matrix
- `.claude/rules/01-development-workflow.md` — layer gates and TDD lifecycle
- `.claude/rules/00-project-context.md` — monorepo map, ports, ticket workflow
- `docs/operations/api-documentation.md` — the documentation-artifact pipeline in full
- `apps/api/docs/README.md` — this app's narrative documentation set
- `packages/applications/README.md`, `packages/domains/README.md`, `packages/database/README.md` — the layers this gateway calls into
