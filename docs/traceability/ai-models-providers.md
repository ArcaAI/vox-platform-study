# Traceability — AI Models & Providers (the model plane)

The platform's AI model plane: the model registry, model discovery + lifecycle/retention,
per-task model defaults, runtime execution profiles, the internal AI-inference gateway,
tenant BYO cloud-provider credentials, and the agent-trajectory observability that the
AI-operations console screens read. Migrates legacy matrix rows **26** (the `AiModel`
registry part — the ASR-pipeline part stays in the transcription domain), **38**, and
**39**, and fills the P1 gaps the legacy matrix omitted (runtime profiles, inference
gateway, task defaults, discovery/lifecycle/retention).

Route paths are relative to the global prefix `/api/v1`. Test shorthand is defined in
[`index.md`](./index.md#test-location-shorthand). `—` means verified-absent.

The registry is a GLOBAL-ADMIN plane (guards pinned to `manage:all`, not the tenant-scoped
`manage:AiModel`); global admins manage per-tenant clones of the SYSTEM catalog through the
working-tenant context, with exact-tenant scoping enforced in the Prisma `tenant-scope`
extension.

## Capabilities

### M1 — AI model registry (catalog) — legacy row 26 (AiModel part)

| Field | Value |
|---|---|
| App / service | `apps/api` (+ `apps/stt` reads the pipeline/model config) |
| Key modules | `apps/api/src/modules/ai-model` (`ai-model-admin.controller.ts`); `packages/applications/src/services/stt/model` (`AiModelService`) |
| Prisma models | `AiModel` (`db_main/stt.prisma`) |
| Key API endpoints | `@Controller('admin/ai-models')` (`@Authorize(['manage','all'])`, via `@ApiEndpoint`): `POST /admin/ai-models`, `GET /admin/ai-models` (all-status, exact tenant), `GET /admin/ai-models/list` (paginated), `GET /admin/ai-models/:id`, `GET /admin/ai-models/slug/:slug`, `PATCH /admin/ai-models/:id` (`@RequiresIfMatch()` OCC — 412 drift / 428 missing), `DELETE /admin/ai-models/:id` |
| Console | `apps/admin-console` feature `ai-models` (`ai-models-screen`); route `/ai-models` (tier 10–19, global) |
| Tests | unit(api): `ai-model/__tests__/ai-model-admin.controller.test.ts`; unit(app): `stt/model/__tests__/aiModel.service.test.ts`; unit(console): `ai-models/components/__tests__/ai-models-screen.test.tsx`, `ai-models/api/__tests__/ai-models-api.test.ts` |

### M2 — Model discovery & registration (TASK-528) — NEW

| Field | Value |
|---|---|
| App / service | `apps/api` (discovery probes upstream provider hosts via `HttpService`, URLs from `IConfigService`) |
| Key modules | `apps/api/src/modules/ai-model` (`ai-model-discovery.controller.ts`, `ai-model-discovery.service.ts`) |
| Prisma models | `AiModel` (a discovered model is registered as an `AiModel` row) |
| Key API endpoints | `@Controller('admin/ai-models')`: `GET /admin/ai-models/discovery` (probe available models), `POST /admin/ai-models/discovery/register` (register a discovered model into the registry) |
| Console | `apps/admin-console` feature `ai-models` discovery drawer (`discovery-drawer`) under route `/ai-models` (tier 10–19, global) |
| Tests | unit(api): `ai-model/__tests__/ai-model-discovery.controller.test.ts`; unit(console): `ai-models/components/__tests__/discovery-drawer.test.tsx`; e2e: `ai-model-discovery.spec.ts` |

### M3 — Per-task model defaults (TASK-506) — NEW

Centralized "which model runs which task" configuration (guardrail/NLP/summarization/…).
The SYSTEM row is the platform default; a tenant row overrides it per task.

| Field | Value |
|---|---|
| App / service | `apps/api` |
| Key modules | `apps/api/src/modules/ai-task-default` (`ai-task-default-admin.controller.ts`); `packages/applications/src/services/ai-task-default` |
| Prisma models | `AiTaskDefault` (`db_main/ai-task-default.prisma`) |
| Key API endpoints | `@Controller('admin/ai-task-defaults')`: `GET /admin/ai-task-defaults/options` (assignable models), `GET /admin/ai-task-defaults` (resolved effective per-task map), `GET /admin/ai-task-defaults/row`, `PUT /admin/ai-task-defaults/row` (create/CAS under `If-Match`). GLOBAL-ADMIN-only for certain task prefixes (`GLOBAL_ADMIN_ONLY_TASK_PREFIXES`, enforced imperatively — see rule 05 `AUTH-NOTE`) |
| Console | `apps/admin-console` feature `ai-task-defaults`; route `/ai-task-defaults` (tier 10–19, global). The tenant-facing view (`tenant-ai-configuration-screen`) surfaces the effective map — legacy row 39, route `/ai-configuration` (tier 30–49; `/ai-model-defaults` redirects) |
| Tests | unit(app): `ai-task-default/__tests__/ai-task-default.service.test.ts`; unit(api): `ai-task-default/__tests__/ai-task-default-admin.controller.test.ts`; unit(console): `ai-task-defaults/components/__tests__/{ai-task-defaults-screens,tenant-ai-configuration-screen}.test.tsx`, `ai-task-defaults/api/__tests__/ai-task-defaults-api.test.ts`; e2e: `ai-task-defaults-cross-tenant.spec.ts` |

### M4 — AI runtime profiles — NEW

Execution profile (host / runtime knobs) resolved for a model at inference time.

| Field | Value |
|---|---|
| App / service | `apps/api` |
| Key modules | `apps/api/src/modules/ai-runtime-profile` (`ai-runtime-profile.controller.ts`); `packages/applications/src/services/ai-runtime-profile` |
| Prisma models | `AiRuntimeProfile` (`db_main/ai-runtime-profile.prisma`) |
| Key API endpoints | `@Controller('admin/ai-runtime-profiles')`: `GET /admin/ai-runtime-profiles`, `GET /admin/ai-runtime-profiles/row`, `GET /admin/ai-runtime-profiles/resolve`, `PUT /admin/ai-runtime-profiles/row`, `DELETE /admin/ai-runtime-profiles/row` |
| Console | — (no dedicated screen; resolution feeds the inference path) |
| Tests | unit(app): `ai-runtime-profile/__tests__/ai-runtime-profile.service.test.ts`; unit(api): profile resolution exercised via `ai-inference/__tests__/ai-inference-runtime-profile.controller.test.ts`; e2e: `—` |

### M5 — AI inference gateway (internal) — NEW

The `@Controller('ai')` surface that fronts guardrail + NLP for internal callers, resolving
the model/runtime for each call.

| Field | Value |
|---|---|
| App / service | `apps/api` → `apps/guardrail` (`GUARDRAIL_URL`) + `apps/nlp` (`NLP_URL`), URLs from `IConfigService` |
| Key modules | `apps/api/src/modules/ai-inference` (`ai-inference.controller.ts`, `ai-inference.client.ts`, `dto/`) |
| Prisma models | — (proxy; reads `AiTaskDefault` / `AiRuntimeProfile` to route) |
| Key API endpoints | `@Controller('ai')`: `POST /ai/guardrail/analyze`, `POST /ai/nlp/entities`, `POST /ai/nlp/diagnosis` |
| Tests | unit(api): `ai-inference/__tests__/{ai-inference.controller,ai-inference.client,ai-inference.dto,ai-inference-model-path.controller,ai-inference-runtime-profile.controller}.test.ts`; e2e: `ai-inference-proxy.spec.ts` |

### M6 — Tenant BYO cloud-provider connections (TASK-526) — legacy row 38

| Field | Value |
|---|---|
| App / service | `apps/api` + `apps/smr` (overrides injected into generation) |
| Key modules | `apps/api/src/modules/ai-provider-connection` (`ai-provider-connection.controller.ts`); `packages/applications/src/services/ai-provider-connection` (`resolveConnection`, `resolveTenantCloudOverrides`); `apps/api/src/modules/streaming` `SmrProxyController.applyTenantProviderOverrides` |
| Prisma models | `AiProviderConnection` (`db_main/ai-provider-connection.prisma`) |
| Key API endpoints | `@Controller('admin/ai-providers')`: `GET /admin/ai-providers`, `GET /admin/ai-providers/:provider`, `PUT /admin/ai-providers/:provider` (`@RequiresIfMatch()` OCC; `apiKey` write-only, no reveal route), `DELETE /admin/ai-providers/:provider`. Injected onto SMR `POST /api/v1/generate` as `provider_overrides` |
| Console | `apps/admin-console` feature `ai-task-defaults` `byo-credential-card` (surfaced on `/ai-configuration`, tier 30–49) — legacy row 39 |
| Tests | unit(app): `ai-provider-connection/__tests__/{ai-provider-connection.service,ai-provider-connection.tenant-lane}.test.ts`; unit(api): `streaming/__tests__/smr-proxy-tenant-byo.controller.test.ts`; e2e: `ai-provider-connections-cross-tenant.spec.ts` |

### M7 — Agent-trajectory observability & AI operations (TASK-530/535) — NEW

Read side that the global AI-operations console screens consume; agent generation runs +
per-step trajectory, with retention.

| Field | Value |
|---|---|
| App / service | `apps/api` |
| Key modules | `apps/api/src/modules/agent-trajectory` (`agent-trajectory.controller.ts`); `packages/applications/src/services/agent-trajectory`, `packages/applications/src/services/agent-trajectory-retention`. The `AgentTrajectory` / `McpServer` RBAC subjects were added in TASK-532 M-12 (see legacy row 34d) |
| Prisma models | `AgentTrajectoryStep` (`db_main/agent-trajectory.prisma`) |
| Key API endpoints | `@Controller('admin/agent-trajectory')` (read-only subject): `GET /admin/agent-trajectory/metrics/generation`, `GET /admin/agent-trajectory/sessions`, `GET /admin/agent-trajectory/sessions/:sessionId/steps` |
| Console | `apps/admin-console` features `ai-operations-runs` (route `/ai-operations/runs`) + `ai-operations-metrics` (route `/ai-operations/metrics`), tier 10–19 global. These are the "global-admin-only screen over per-tenant data" pattern: `(global)` tier + `WorkingTenantGate` (see rule 13 §Routing) |
| Tests | unit(api): `agent-trajectory/__tests__/agent-trajectory.controller.test.ts`; unit(app): `agent-trajectory/__tests__/{agent-trajectory.service,agent-trajectory.token-budget}.test.ts`, `agent-trajectory-retention/__tests__/agent-trajectory-retention.service.test.ts`; unit(console): `ai-operations-runs/components/__tests__/{ai-operations-runs-screen,step-stats}.test.tsx`, `ai-operations-metrics/components/__tests__/ai-operations-metrics-screen.test.tsx`, `ai-operations-metrics/api/__tests__/aggregate.test.ts`; e2e: `apps/api/tests/e2e/trajectory-admin.spec.ts` (agent-trajectory admin read plane — pagination, projection, 404-over-403) |

## Honest notes / gaps

- **M4 (runtime profiles) has no `apps/api/tests/e2e` spec.** It is covered at the unit(app)/unit(api)/unit(console) layers only; runtime-profile resolution is exercised indirectly through the AI-inference controller tests, not a dedicated profile e2e. (M7's agent-trajectory admin read plane IS covered by `apps/api/tests/e2e/trajectory-admin.spec.ts`.)
- **The ASR-pipeline half of legacy row 26 is NOT here.** `AsrPipeline`/`AsrPipelineVersion` + `modules/pipeline` belong to the transcription domain and remain in `docs/traceability-matrix.md` until that domain is migrated.
- **M3 GLOBAL-ADMIN-only enforcement is imperative, not declarative.** Certain task-default prefixes (and MCP writes, and the guardrail task) are gated in the service via `isSuperAdmin`/`GLOBAL_ADMIN_ONLY_*`, so the `@Authorize` decorator alone understates the gate — read the service, per rule 05.
- Model discovery probes are upstream-host dependent; the discovery e2e (`ai-model-discovery.spec.ts`) covers registration, not live probing of every provider host.
- **Text/RAG embedding is infra-tier, not catalog-tier — by design, not omission (TASK-581).** The `FEATURE_EXTRACTION`/`SENTENCE_SIMILARITY` `ModelTaskType` values have no seeded `AiModel` row. Verified 2026-07-28: `AI_TASK_KEYS` (`packages/applications/src/services/ai-task-default/constants.ts`) has no embedding task key, and `apps/harness`'s only embedding consumer (`RetrievalConfig` → `EmbeddingsClient`, `apps/harness/src/harness/core/config.py` + `services/embeddings_client.py`) resolves its endpoint/model entirely from `HARNESS_RETRIEVAL_EMBEDDINGS_*` env vars — never from `AiModel`/`AiProviderConnection`/`AiTaskDefault`. There is no DB-catalog lookup for a text embedder anywhere in the codebase. Do not re-flag this as a Day-1-defaults gap without first confirming a new resolver actually reads an embedding row from the catalog.

Last verified: 2026-07-28 (TASK-581 non-gap note)
