# `apps/api` — API Gateway Map

**Path:** `/Users/apple/repos/VOX/project-hope/apps/api`
**Package:** `@arcaai/api` v0.1.0 — NestJS 11 gateway, port **8868**, global prefix **`api/v1`**
**Repo state:** branch `dev-2.2`, HEAD `8cb2e5e8e`
**Written:** 2026-11-04 · read-only inspection of the working tree
**Parent doc:** [00-REPO-ROOT-MAP.md](./00-REPO-ROOT-MAP.md)

---

## At a glance

| Fact | Value | Source |
|---|---|---|
| Framework | NestJS 11 + TypeScript 5.9, Express adapter, `WsAdapter` for raw WS | `package.json`, `src/main.ts` |
| Listens on | `8868` (HTTP + WS), Swagger UI at `/api/v1/docs` | `Dockerfile`, README |
| Global prefix | `api/v1` (only `/metrics` excluded) | `src/global-prefix.config.ts` |
| Feature module dirs | **78** (+1 `__tests__`) | `src/modules/` |
| Routes in authz oracle | **818** | `route-manifest.json` |
| OpenAPI paths | **607** | `openapi.json` |
| Colocated unit specs | **441** `*.test.ts` across **94** `__tests__` dirs | `src/` |
| E2E specs | **165** (31 cross-tenant) | `tests/e2e/` |
| Business logic | Lives in `@arcaai/applications` / `@arcaai/domains` — **no Prisma access in this app** | README |

The gateway is the single entry point for every client (web, mobile, API-key integrator, service account). It terminates HTTP/WS, enforces auth/tenancy/consent, and proxies or health-monitors the six Python services (STT, Text, Guardrail, NLP, Harness, TTS).

---

# 1. App-root files and folders

| Entry | Purpose |
|---|---|
| `src/` | All application source (see §2–§4). |
| `tests/` | The **real** test tree: `unit/`, `integration/`, `e2e/` (Playwright), `helpers/`, `setup/`. |
| `test/` | **Legacy** Jest e2e scaffold (`app.e2e-spec.ts`, `jest-e2e.json`). No package script runs it — do not confuse with `tests/`. |
| `docs/` | Five hand-maintained narrative docs (see §6). |
| `dist/` | Build output (`nest build` + `tsc-alias`), 11 MB, gitignored. |
| `coverage/` | V8 coverage HTML/JSON from `pnpm api:test:cov`, 16 MB, gitignored. |
| `node_modules/` | Installed deps (pnpm workspace). |
| `README.md` | Authoritative app guide: layout, guard pipeline, OCC, doc-artifact pipeline, gotchas. |
| `package.json` | `@arcaai/api` manifest — build/dev/start, lint/typecheck, test/e2e, `openapi`, `route-manifest`, `cleanup-orphan-consultations`. |
| `CHANGELOG.md` | Wire-format and behavioural breaking changes (Keep a Changelog / SemVer). |
| `Dockerfile` | 3-stage build (`dependencies` → `builder` → `production`), Node 24, pnpm 10.34.5, `dumb-init`, `EXPOSE 8868`. Same image serves three entrypoints (gateway, checkpoint worker, model publisher). |
| `nest-cli.json` | Nest CLI config + `@nestjs/swagger` plugin (`classValidatorShim`, `introspectComments`, DTO filename suffixes). |
| `nodemon.json` | Backs `pnpm api:dev:watch`; watches `src` + `packages/applications/dist`. |
| `eslint.config.mjs` | Flat ESLint config for `{src,tests}`. |
| `tsconfig.json` / `tsconfig.build.json` | Base + build-only TS config (path aliases `@`, `@tests`). |
| `tsconfig.build.tsbuildinfo` | Incremental build cache (generated). |
| `vitest.config.ts` | Unit/integration config; includes `src/**/*.test.ts`, `tests/unit`, `tests/integration`; excludes e2e. |
| `openapi.json` | **Generated** OpenAPI document (2.4 MB, 607 paths). Regenerate with `pnpm api:openapi`. |
| `route-manifest.json` | **Generated** authorization oracle: 818 routes with `isPublic`, `requiredPermissions`, `apiKeyScopes`, `svcScopes`, `requiresIfMatch`, `apiKeyForbidden`, `forbidServiceAccount`. Regenerate with `pnpm api:route-manifest`. |
| `.env.sample` | Per-app env template (generated portion of the root consolidated sample). |
| `.env.prod` | Production env template, tracked in git. Review before treating as secret-free. |
| `.dockerignore` | Docker build-context exclusions. |

---

# 2. `src/` — root files

| File | Purpose |
|---|---|
| `main.ts` | Bootstrap: env load, global prefix, validation pipe, session cookie, security headers, ETag interceptor, Swagger, WS adapter, and all boot-time audits. |
| `app.module.ts` | Root module — global guards/interceptors/filters in load-bearing order, plus every feature module import. |
| `instrumentation.ts` | OpenTelemetry SDK bootstrap, preloaded via `node --import` (traces + logs OTLP gRPC, Prisma instrumentation). |
| `instrumentation.flags.ts` | Pure, testable enablement decisions for OTel (`OTEL_TRACES_ENABLED`, etc.). |
| `cors.config.ts` | Origin admission: an origin is allowed **iff** it is registered (`TenantAllowedOrigin`); no env allow-list, no wildcards. |
| `cors.headers.ts` | Which request/response headers may cross once an origin is admitted. |
| `crash-handlers.ts` | Fatal-crash handling: flush OTel + logs within a timeout, then exit. |
| `global-prefix.config.ts` | Single source of truth for `api/v1` + prefix exclusions, reused by the offline OpenAPI emitter. |
| `request-id.ts` | One request id per request (`x-request-id` if safe, else uuidv7) via CLS; used as correlation id everywhere. |
| `swagger.config.ts` | Swagger `DocumentBuilder`: metadata, security schemes, tag taxonomy; extracted so it is unit-testable. |
| `vault-prisma.module.ts` | Binds `VAULT_PRISMA_FACTORY` to a Vault-backed dynamic-credential Prisma client when Vault + PG dynamic creds are enabled. |
| `checkpoint-worker.main.ts` | Separate entrypoint: tenant checkpoint export/restore worker (no HTTP listener). |
| `model-publisher.main.ts` | Separate entrypoint: model download/unregister worker (no HTTP listener). |

---

# 3. `src/` — directories

| Directory | Purpose |
|---|---|
| `modules/` | 78 feature modules — see §4. |
| `bootstrap/` | Boot-time audits that refuse startup on authorization drift (route permissions, API-key scopes, admin scopes, consent coverage, OCC coverage, CASL reachability, WS gateway ownership, JWT placeholder, GenAI content capture) + internal body limits. |
| `common/` | Shared SSE tenancy safety: `TenantOwnedResourceSseGuard`/interceptor/decorator (404-over-403 for open streams), `stream-session-tenant-binding.service.ts`, shared gateway HTTP agent. |
| `config/` | `env.schema.ts` / `env.descriptors.ts` — zod-validated env surface read through `apiEnv()`. |
| `database/` | `tenant-context.provider.ts` — Prisma tenant-context wiring (no models here). |
| `decorators/` | `@ApiEndpoint`, `@ApiDeprecated`, paginated/single response helpers, OCC (`@RequiresIfMatch`, `@ExpectedVersion`, `@NoOptimisticConcurrency`), tenant-lock exemption. |
| `filters/` | Exception envelopes and mappers: `all-exceptions`, `http-exception-envelope`, `consent`, `data-not-found`, downstream error mapping, failure logging, validation violations. |
| `guards/` | `JwtAuthGuard`, `OidcAuthGuard`, `PatientConsentGuard`, `OriginTenantBindingGuard`, tenant-lock guards, internal-path helper. |
| `interceptors/` | `Context`, `Exception`, `Maintenance`, `ImpersonationAudit`, `Metrics`, `ETag`, active-tenant resolver. |
| `middlewares/` | Empty barrel (`index.ts`) — reserved. |
| `observability/` | Prometheus metrics (HTTP responses, Prisma pool, usage emission, deprecated routes) and metric naming. |
| `openapi/` | `tags.ts` (tag taxonomy), `api-exclude-metadata.ts`, `operation-security.ts`. |
| `scripts/` | Offline emitters (`emit-openapi.ts`, `emit-route-manifest.ts`), `cleanup-orphan-consultations.ts`, offline infra stubs. |
| `services/` | Graceful shutdown module/service, service-release self-registration. |
| `shared/` | `base-proxy.controller.ts` (**dead code — zero subclasses**), `tenant-scope.ts`, `table-export.ts`. |
| `types/` | `request-with-auth.ts` — authenticated request shape. |
| `workers/` | Vault credential-rotation scheduled processor + worker module. |
| `checkpoint-worker/` | Nest module for the tenant-checkpoint worker entrypoint. |
| `model-publisher/` | Nest module for the model-publisher worker entrypoint. |
| `assets/` | Placeholder (`.gitkeep`). |
| `__tests__/` | App-level invariant tests: global prefix, CORS, compat removal, route renames, Dockerfile runtime, secret migration, validation pipe, audit wiring, etc. |

---

# 4. `src/modules/` — feature module catalog (78)

Route prefixes are the `@Controller(...)` values (prefixed at runtime with `api/v1`).

## 4.1 Clinical consultation & documentation

| Module | Route prefix(es) | Purpose |
|---|---|---|
| `consultation` | `consultations`, `consultations/jobs`, `admin/consultations`, `admin/feedback`, `internal/{consultations,harness,consent}` | Core consultation lifecycle: sessions, jobs, attachments, feedback, telemetry, lifecycle events; harness/consent internal endpoints; admin read plane. 11 controllers. |
| `consultation-history` | `consultations`, `admin/consultations` | Historical/archived consultation reads and admin browsing. |
| `consultation-context-schema` | `admin/consultation-context-schemas`, `tenants/me/context-schema` | Per-tenant schema of context variables available to prompts/workflows. |
| `document-template` | `admin/document-templates`, `tenants/me/document-template` | Clinical document/note templates. |
| `dna-writing-style` | `admin/dna-writing-styles`, `dna-writing-styles`, `dna-writing-styles/ingest` | DNA writing-style configuration, generation, and ingest pipeline. |
| `knowledge` | `admin/knowledge/documents` | Governance for the institutional-RAG knowledge corpus (no create/approve routes; ingestion is worker-only). |
| `media` | `media` | Tenant media upload plane (multipart, MIME allow-lists, static ceiling). |
| `voice-profile` | `voice-profiles` | TTS voice enrollment/profiles. |
| `guardrail-notice` | `consultations`, `admin/consultations` | Guardrail notices surfaced on the business plane + admin evaluation read plane. |
| `nlp-task-instructions` | `admin/nlp-task-instructions` | Per-tenant NLP task instructions/prompts. |

## 4.2 Agents, prompts, workflows & harness

| Module | Route prefix(es) | Purpose |
|---|---|---|
| `agent` | `agents` | Agent CRUD and run-context validation against the agent's bound context schema. |
| `agent-admin` | `admin/agents`, `admin/agent-assignments` | Which agent serves a task for a tenant/department (incl. speech-to-text assignment). |
| `agent-promotion` | `admin/agent-promotions` | WORM tenant-to-tenant agent promotion (no PATCH/DELETE by design). |
| `agent-trajectory` | `admin/agent-trajectory` | Super-admin read plane over agent execution trajectories. |
| `agentic-admin` | `admin/agentic` | Super-admin agentic control surface. |
| `workflows` | `workflows`, `consultations/:consultationId/workflows`, `admin/workflow-runs`, `hooks/workflows` | Workflow execution for consultations + external hooks. 4 controllers. |
| `workflow-definition` | `admin/workflow-definitions` | Workflow definition CRUD/versioning. |
| `workflow-node` | `admin/workflow-nodes` | Workflow node registry. |
| `workflow-assignment` | `admin/workflow-assignments` | Bind workflows to tenants/departments/tasks. |
| `workflow-invariant-rule` | `admin/workflow-invariant-rules` | Invariant rules enforced during runs. |
| `workflow-run` | `admin/workflow-runs` | Run inspection/administration. |
| `workflow-sandbox-run` | `admin/workflow-definitions/:definitionId/sandbox-runs` | Dry-run a definition without side effects. |
| `workflow-test-fixture` | `admin/workflow-test-fixtures` | Stored fixtures for workflow tests. |
| `governed-prompt` | `internal/governed-prompts` | Service-to-service governed prompt fetch. |
| `prompt-management` | `admin/prompt-templates`, `prompt-templates` | Prompt template + version CRUD, test endpoint (typed `variables` array since TASK-890). |
| `prompt-inspector` | `admin/composed-prompts`, `admin/consultations` | Dry-run of the exact prompt a consultation would send + composed-prompt incident records. |
| `harness-admin` | `admin/harness` | Clinical documentation harness policy (global default + tenant overrides). |
| `pstudio` | `admin/pstudio`, `admin/pstudio/status` | Dev/operator Prisma Studio shell behind an authenticating BFF; fail-closed behind `ENABLE_PRISMA_STUDIO`. |

## 4.3 AI, models & inference control plane

| Module | Route prefix(es) | Purpose |
|---|---|---|
| `ai-model` | `admin/ai-models` | Model registry: discovery merge view, explicit register, status. 5 controllers. |
| `ai-provider-connection` | `admin/providers` | Unified provider connections + test-connection probe (replaces legacy `admin/ai-providers`). |
| `ai-routing-policy` | `admin/routing-policies` | Provider routing and failover policy. |
| `ai-service-admin` | `admin/ai-services` | Read-only AI service inventory. |
| `ai-inference` | `safety-checks`, `text-analyses` | User-plane proxy to Guardrail/NLP for the Agent Playground (safety verdicts, NER/classification) with routing-policy resolution and usage metering. |
| `inference-engines` | `admin/inference-engines/lm-studio` | Platform control of the shared LM Studio serving engine. |
| `model-residency` | `admin/model-residency` | Model residency policies, placement, load/unload/pin (TASK-1005). |
| `guardrail-availability` | `admin/guardrail/availability` | Guardrail service/model availability. |
| `guardrail-policy` | `admin/guardrail`, `admin/guardrail/metrics` | Guardrail policy + metrics admin. |
| `guardrail-tenant-policy` | `admin/guardrail`, `admin/guardrail/policy` | Per-tenant guardrail policy overrides. |
| `guardrail-evaluation-internal` | `internal/guardrail/evaluations` | Service-to-service guardrail evaluation record writes. |

## 4.4 Tenancy, identity & access

| Module | Route prefix(es) | Purpose |
|---|---|---|
| `auth` | `auth`, `auth/sso`, `admin/users` | Login/refresh/logout, SSO, admin impersonation, stream tickets. 4 controllers. |
| `user` | `users`, `users/me/*`, `auth`, `admin/users` | Profile, preferences, settings, departments, password reset. |
| `rbac` | `admin/rbac/roles`, `admin/rbac/policies`, `users/:id/permission-checks` | Roles, CASL policies, permission-check endpoints. |
| `api-key` | `admin/api-keys` | Tenant API keys, scopes, lifecycle. |
| `service-account` | `admin/service-accounts`, `auth` | Service-account management + credential exchange (tightly rate-limited). |
| `entitlements` | `admin/entitlements`, `tenants/me` | Plan entitlements (super-admin CRUD, tenant self-read). |
| `billing` | `admin/billing/{invoices,rate-card}`, `tenants/me` | Tenant self-service billing reads (D8/D12). |
| `consent` | `admin/consent-grants` | Patient consent grants (ABAC source). |
| `tenant` | `admin/tenants`, `tenants/me` | Tenant lifecycle + self-service. |
| `tenant-allowed-origin` | `admin/allowed-origins` | Origin registry that backs CORS admission. |
| `tenant-bucket` | `admin/tenants/storage/buckets` | Per-tenant storage buckets. |
| `tenant-storage-config` | `admin/tenants/storage/config` | Per-tenant storage backend config. |
| `tenant-storage-access-key` (`storage-access-key`) | `admin/tenants/storage/keys` | Tenant storage credentials/keys. |
| `tenant-idp-config` | `admin/tenant-idp-config` | Per-tenant identity-provider config. |
| `tenant-frontend-config` | `admin/tenant-frontend-config` | Per-tenant front-end feature/branding config. |
| `tenant-checkpoint` | `admin/tenants/:tenantId/checkpoints` | Enqueue/inspect tenant export & restore jobs. |
| `storage` | `storage` | Tenant object-storage access (presign/read/write). |
| `department` | `admin/departments` | Department hierarchy. |
| `resource-subscription` | `admin/resource-subscriptions` | Which tenants subscribe to which platform resources. |
| `security-policy` | `admin/security` | Super-admin-only security posture knobs (8 keys). |
| `global-setting` | `admin/settings` | Global/platform settings CRUD. |
| `settings-catalog` | `admin/settings` | Settings registry catalog, effective features, action confirmations, registry writes. 4 controllers. |

## 4.5 Ops, platform & service plumbing

| Module | Route prefix(es) | Purpose |
|---|---|---|
| `health` | `health`, `admin/health/services` | Liveness/readiness + downstream service health. |
| `monitoring` | `admin/monitoring` | Platform monitoring surface. |
| `platform-metrics` | `admin/platform` | Platform runtime metrics (super-admin only). |
| `platform-knobs` | — (no controller) | Pre-bootstrap `PlatformKnobsBinder`: log level, CORS origin resolver, `origin.enforcementEnabled`. |
| `throttle` | — (no controller) | Global rate limiting: named throttlers, Redis/`WindowOnlyThrottlerStorage`. |
| `admin-rate-limit` | `admin/rate-limit` | Per-endpoint rate-limit administration. |
| `admin-usage` | `admin/usage`, `tenants/me` | Usage metering read surfaces. |
| `audit-log` | `admin/audit-logs` | Audit-log query/export. |
| `changelog` | `changelog`, `admin/changelog` | Public + admin changelog. |
| `queue-admin` | `admin/queues`, `admin/schedulers` | BullMQ queue + dynamic scheduler administration (super-admin). |
| `notification` | `admin/notifications` | Notification read/update/delete (no create — platform-emitted). |
| `webhook` | `admin/webhooks` | Webhook CRUD + delivery log. |
| `mcp-admin` | `admin/mcp-servers` | MCP server registry administration. |
| `service-release` | `admin/service-releases`, `internal/service-releases` | Service self-registration + heartbeat and admin view. |
| `internal` | `internal`, `internal/agents`, `internal/composed-prompts`, `internal/effective-config`, `internal/models`, `internal/stt`, `internal/stt/sessions` | Service-to-service plane: service-token guard, resolved agents, composed prompts, effective config, model registry credential, STT sessions. 8 controllers. |
| `__tests__` | — | Module-plane reachability invariant test (TASK-773). |

---

# 5. Tests

| Path | Contents |
|---|---|
| `tests/unit/` | 1 file — most unit tests live beside the source instead. |
| `tests/integration/` | 4 specs: auth coverage, `test-app-module`, summary provenance, full-route walk. |
| `tests/e2e/` | **165** Playwright specs (31 cross-tenant) + `helpers/`. Needs a live gateway on port **8968** under `.env.test` (`pnpm test:up:api`). |
| `tests/helpers/` | 1 shared helper barrel. |
| `tests/setup/` | 1 setup file. |
| `src/**/__tests__/`, `src/**/*.test.ts` | **441** colocated unit specs in 94 directories — the bulk of the suite. |
| `test/` | Legacy Jest scaffold, unused. |

Run: `pnpm api:test` (Vitest unit+integration), `pnpm api:test:e2e` (Playwright, live gateway), `pnpm api:test:cov`.

---

# 6. `apps/api/docs/`

Hand-maintained narrative docs — explicitly **not** authoritative (they predate several decisions; check their "Last Updated" headers).

| File | Covers |
|---|---|
| `README.md` | Index + gotchas (deployment guide is stale, etc.). |
| `01-implementation-status.md` | Feature-completion tracker (last updated 2026-02-22). |
| `02-development-guide.md` | Local dev setup + feature-creation walkthrough. |
| `03-usage-guide.md` | Client-facing endpoint/auth examples. |
| `04-deployment-guide.md` | Deployment paths (systemd/Helm — **stale**; real manifests live in the separate `hope-v2-deployment` repo). |
| `05-api-reference.md` | Guards, decorators, interceptors, controllers reference. |

---

# 7. Runtime shape

```
node --import ./dist/instrumentation.js dist/main.js                  → gateway, :8868
node --import ./dist/instrumentation.js dist/checkpoint-worker.main.js → tenant checkpoint worker
node --import ./dist/instrumentation.js dist/model-publisher.main.js   → model download/publish worker
```

**Request pipeline** (documented in README, verified against `src/app.module.ts`):

1. `TieredThrottlerGuard` (before auth)
2. `ClsGuard`
3. `UnifiedAuthGuard` — deny-by-default JWT / API-key / service-account; `@Public()` is the only opt-out
4. `PatientConsentGuard`
5. `TenantOwnedResourceSseGuard`
6. `OriginTenantBindingGuard`
7. `RequiresIfMatchGuard`

Interceptors: `Metrics` → `RateLimitHeaders` → `Context` → `Exception` → `Maintenance` → `ImpersonationAudit`, plus global `ETag` from `main.ts`.
Filters: `HttpExceptionEnvelope` (catch-all, registered first) → `DataNotFoundException` → `ConsentException`.

---

# 8. Drift / gotchas found while mapping

- **README says 70 feature modules** — the tree has **78** feature dirs (+1 `__tests__`).
- **README says the route manifest has 749 routes** — `route-manifest.json` has **818**.
- **README says 147 e2e spec files** — `tests/e2e/` has **165** `.spec.ts` (31 cross-tenant).
- **`.claude/rules/*.md` is referenced repeatedly but does not exist in this checkout.**
- **`src/shared/base-proxy.controller.ts` is dead code** — zero subclasses; do not treat it as an active pattern.
- **`test/` (singular) is a leftover Jest scaffold** — `tests/` (plural) is the live tree.
- **Five artifacts must be regenerated together on any route change:**
  ```bash
  pnpm api:build && pnpm api:route-manifest && pnpm api:openapi && pnpm api:portal \
    && pnpm --filter @arcaai/vox-node gen:admin
  ```
  `pnpm verify` does **not** check documentation drift.
- **Generated — never hand-edit:** `openapi.json`, `route-manifest.json`, `.env.sample`, `dist/`, `coverage/`.
- **`.env.prod` is tracked in git** — worth an audit for secrets.

---

# 9. Suggested next reads

| If you want… | Go to |
|---|---|
| End-to-end request/data flows | `project-hope/25-end-to-end-data-flows.md` |
| Guard pipeline + OCC contract | `apps/api/README.md` (verified against `src/app.module.ts`) |
| Route-by-route authorization data | `apps/api/route-manifest.json` |
| Already-generated API inventory | `review/api_explore/inventory/routes-by-module.md`, `summary.json` |
| Codebase-level architecture | `review/api_explore/codebase/ARCHITECTURE.md`, `STACK.md`, `CONCERNS.md` |
| The layer below the gateway | `packages/applications/`, `packages/domains/`, `packages/database/` |
| Doc-artifact pipeline | `project-hope/docs/operations/api-documentation.md` |
