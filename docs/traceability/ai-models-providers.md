# Traceability — AI Models & Providers (the model plane)

The platform's AI model plane: the model registry, model discovery + lifecycle/retention,
non-agent task → model selection (`AiRoutingPolicy`), the AI-inference gateway,
tenant BYO cloud-provider connections, and the agent-trajectory observability that the
AI-operations console screens read. (Agent tasks — text generation, ASR, TTS — select
through the tenant's `Agent`, not through this plane; runtime execution profiles and
per-task defaults were retired, see M3/M4.) Migrates legacy matrix rows **26** (the `AiModel`
registry part — the ASR-pipeline part stays in the transcription domain), **38**, and
**39**, and fills the P1 gaps the legacy matrix omitted (runtime profiles, inference
gateway, task defaults, discovery/lifecycle/retention).

Route paths are relative to the global prefix `/api/v1`. Test shorthand is defined in
[`index.md`](./index.md#test-location-shorthand). `—` means verified-absent.

The registry is a SUPER_ADMIN plane (guards pinned to `manage:all`, not the tenant-scoped
`manage:AiModel`); super admins manage per-tenant clones of the SYSTEM catalog through the
working-tenant context, with exact-tenant scoping enforced in the Prisma `tenant-scope`
extension.

## Capabilities

### M1 — AI model registry (catalog) — legacy row 26 (AiModel part)

| Field | Value |
|---|---|
| App / service | `apps/api` (the gateway resolves models and hands `apps/stt` a `ResolvedAsrSpec`; stt reads no database) |
| Key modules | `apps/api/src/modules/ai-model` (`ai-model-admin.controller.ts`); `packages/applications/src/services/ai-model` (`AiModelService`) |
| Prisma models | `AiModel` (`db_main/stt.prisma`) |
| Key API endpoints | `@Controller('admin/ai-models')` (`@Authorize(['manage','all'])`, via `@ApiEndpoint`): `POST /admin/ai-models`, `GET /admin/ai-models` (all-status, exact tenant), `GET /admin/ai-models/list` (paginated), `GET /admin/ai-models/:id`, `GET /admin/ai-models/slug/:slug`, `PATCH /admin/ai-models/:id` (`@RequiresIfMatch()` OCC — 412 drift / 428 missing), `DELETE /admin/ai-models/:id` |
| Console | `apps/admin-console` feature `ai-models` (`ai-models-screen`); route `/ai-models` (tier 10–19, global) |
| Tests | unit(api): `ai-model/__tests__/ai-model-admin.controller.test.ts`; unit(app): `ai-model/__tests__/aiModel.service.test.ts`; unit(console): `ai-models/components/__tests__/ai-models-screen.test.tsx`, `ai-models/api/__tests__/ai-models-api.test.ts` |

### M2 — Model discovery & registration — NEW

| Field | Value |
|---|---|
| App / service | `apps/api` (discovery probes upstream provider hosts via `HttpService`, URLs from `IConfigService`) |
| Key modules | `apps/api/src/modules/ai-model` (`ai-model-discovery.controller.ts`, `ai-model-discovery.service.ts`) |
| Prisma models | `AiModel` (a discovered model is registered as an `AiModel` row) |
| Key API endpoints | `@Controller('admin/ai-models')`: `GET /admin/ai-models/discovery` (probe available models), `POST /admin/ai-models/discovery/register` (register a discovered model into the registry) |
| Console | `apps/admin-console` feature `ai-models` discovery drawer (`discovery-drawer`) under route `/ai-models` (tier 10–19, global) |
| Tests | unit(api): `ai-model/__tests__/ai-model-discovery.controller.test.ts`; unit(console): `ai-models/components/__tests__/discovery-drawer.test.tsx`; e2e: `ai-model-discovery.spec.ts` |

### M3 — Non-agent task → model selection (`AiRoutingPolicy`) — replaces `AiTaskDefault`

"Which model runs which NON-agent task" (`guardrail.*`, `nlp.*`, `harness.judge`, `vlm.extract` —
`AI_TASK_KEYS`). The elected (`isDefault`) row per `(tenant, taskKey)` binds a catalogue model by FK;
`AiRoutingPolicyService.resolveDefault` resolves tenant → SYSTEM on absence. Text generation, ASR and TTS
are NOT keyed here — they select through the tenant's assigned `Agent` (TASK-861/876/879). `AiTaskDefault`
was absorbed by TASK-862, its table dropped by the TASK-870 wave-3a migration and its service + controller
deleted by TASK-881.

| Field | Value |
|---|---|
| App / service | `apps/api` |
| Key modules | `apps/api/src/modules/ai-routing-policy` (`ai-routing-policy-admin.controller.ts`); `packages/applications/src/services/ai-routing-policy` (`ai-routing-policy.service.ts` — `resolveDefault`, `getEffective`; `constants.ts` — `AI_TASK_KEYS`, `SUPER_ADMIN_ONLY_TASK_PREFIXES`) |
| Prisma models | `AiRoutingPolicy` (`db_main/ai-routing-policy.prisma`) |
| Key API endpoints | `@Controller('admin/routing-policies')`: `GET`/`POST /admin/routing-policies`, `GET`/`PATCH`/`DELETE /admin/routing-policies/:id` (`PATCH` under `If-Match`), `POST …/:id/activate`, `POST …/:id/default` (elect; `If-Match`), `POST …/:id/promote`, `GET …/effective`, `GET …/export`, `POST …/import`. Every write is SUPER_ADMIN-only (imperative `assertSuperAdmin`, rule 05 `AUTH-NOTE`); `nlp.*` / `harness.*` / `guardrail.*` also pin the runtime read to SYSTEM |
| Console | No tenant screen. The SYSTEM election is edited from the `ai-models` screen's "platform default for task" action (`/ai-models`, tier 10–19, global); the effective selections a tenant uses appear in `ai-providers` "used by" (`GET admin/routing-policies?tenantId=`) |
| Tests | unit(app): `ai-routing-policy/__tests__/{ai-routing-policy.service,ai-routing-policy.resolve-default,task-key-vocabulary,routing-gates,ai-task-kind}.test.ts`; unit(api): `ai-routing-policy/__tests__/ai-routing-policy-admin.controller.test.ts`; e2e: `task-779-policy-boundaries.spec.ts` |

### M4 — AI runtime profiles — RETIRED (TASK-862)

`AiRuntimeProfile` (per-provider / per-model execution knobs) no longer exists: there is no
`apps/api/src/modules/ai-runtime-profile`, no `admin/ai-runtime-profiles` route and no Prisma model.
Its ceilings (`maxConcurrent` / `rpmLimit` / `tpmLimit` / `timeoutS`) moved onto `AiProviderConnection`
(M6) and per-model generation parameters live on the Agent. The section number is kept so links resolve.

### M5 — AI inference gateway (internal) — NEW

The `text-analyses` / `safety-checks` surface that fronts NLP + guardrail, resolving the model for
each call from the `nlp.*` / `guardrail.*` `AiRoutingPolicy` elections (SYSTEM tier).

| Field | Value |
|---|---|
| App / service | `apps/api` → `apps/guardrail` (`GUARDRAIL_URL`) + `apps/nlp` (`NLP_URL`), URLs from `IConfigService` |
| Key modules | `apps/api/src/modules/ai-inference` (`ai-inference.controller.ts`, `safety-check.controller.ts`, `ai-inference.client.ts`, `dto/`); `ai-inference-redirect.shim.controller.ts` keeps the old `ai/*` paths answering with a 308 until its scheduled deletion |
| Prisma models | — (proxy; resolves the model through `AiRoutingPolicyService.resolveDefault`) |
| Key API endpoints | `@Controller('text-analyses')`: `POST /text-analyses/entities`, `/diagnosis`, `/topic`, `/intent`; `@Controller('safety-checks')`: `POST /safety-checks` |
| Tests | unit(api): `ai-inference/__tests__/{ai-inference.controller,ai-inference.client,ai-inference.dto,ai-inference-model-path.controller,ai-inference.usage.task957}.test.ts`; e2e: `ai-inference-proxy.spec.ts` |

### M6 — Tenant BYO cloud-provider connections — legacy row 38

| Field | Value |
|---|---|
| App / service | `apps/api` + `apps/text` (overrides injected into generation) |
| Key modules | `apps/api/src/modules/ai-provider-connection` (`ai-provider-connection.controller.ts`); `packages/applications/src/services/ai-provider-connection` (`resolveConnection`, `resolveTenantCloudOverrides`); `apps/api/src/modules/streaming` `TextProxyController.applyTenantProviderOverrides` |
| Prisma models | `AiProviderConnection` (`db_main/ai-provider-connection.prisma`) |
| Key API endpoints | `@Controller('admin/providers')` (TASK-958: a tenant may hold several connections per provider — one DEFAULT plus named siblings addressed by `slug`): `GET /admin/providers/:service`, `GET`/`PUT`/`DELETE /admin/providers/:service/:slug` (`PUT` under `@RequiresIfMatch()` OCC; `apiKey` write-only, no reveal route), `PUT …/:slug/models`, `POST …/:slug/reset`, `POST …/:slug/test`, `GET /admin/providers/:service/platform-defaults`. The resolved tenant credential is injected onto TEXT `POST /api/v1/generate` as `provider_overrides` by the gateway — a caller never supplies it |
| Console | `apps/admin-console` feature `ai-providers` (`/ai-providers`, shared tier 20–29: provider-connection cards, platform-defaults panel, "used by" panel) — legacy row 39 |
| Tests | unit(app): `ai-provider-connection/__tests__/{ai-provider-connection.service,ai-provider-connection.tenant-lane}.test.ts`; unit(api): `streaming/__tests__/text-proxy-tenant-byo.controller.test.ts`; e2e: `ai-provider-connections-cross-tenant.spec.ts` |

### M7 — Agent-trajectory observability & AI operations — NEW

Read side that the global AI-operations console screens consume; agent generation runs +
per-step trajectory, with retention.

| Field | Value |
|---|---|
| App / service | `apps/api` |
| Key modules | `apps/api/src/modules/agent-trajectory` (`agent-trajectory.controller.ts`); `packages/applications/src/services/agent-trajectory`, `packages/applications/src/services/agent-trajectory-retention`. `AgentTrajectory` and `McpServer` are dedicated RBAC subjects (see legacy row 34d) |
| Prisma models | `AgentTrajectoryStep` (`db_main/agent-trajectory.prisma`) |
| Key API endpoints | `@Controller('admin/agent-trajectory')` (read-only subject): `GET /admin/agent-trajectory/metrics/generation`, `GET /admin/agent-trajectory/sessions`, `GET /admin/agent-trajectory/sessions/:sessionId/steps` |
| Console | `apps/admin-console` features `ai-operations-runs` (route `/ai-operations/runs`) + `ai-operations-metrics` (route `/ai-operations/metrics`), tier 10–19 global. These are the "super-admin-only screen over per-tenant data" pattern: `(global)` tier + `WorkingTenantGate` (see rule 13 §Routing) |
| Tests | unit(api): `agent-trajectory/__tests__/agent-trajectory.controller.test.ts`; unit(app): `agent-trajectory/__tests__/{agent-trajectory.service,agent-trajectory.token-budget}.test.ts`, `agent-trajectory-retention/__tests__/agent-trajectory-retention.service.test.ts`; unit(console): `ai-operations-runs/components/__tests__/{ai-operations-runs-screen,step-stats}.test.tsx`, `ai-operations-metrics/components/__tests__/ai-operations-metrics-screen.test.tsx`, `ai-operations-metrics/api/__tests__/aggregate.test.ts`; e2e: `apps/api/tests/e2e/trajectory-admin.spec.ts` (agent-trajectory admin read plane — pagination, projection, 404-over-403) |

## Honest notes / gaps

- **M4 (runtime profiles) is retired** — nothing to cover. (M7's agent-trajectory admin read plane IS covered by `apps/api/tests/e2e/trajectory-admin.spec.ts`.)
- **The ASR-pipeline half of legacy row 26 is NOT here.** `AsrPipeline`/`AsrPipelineVersion` + `modules/pipeline` were retired by TASK-1006 (2026-09-25) — the retirement is recorded in [`transcription.md`](./transcription.md#r4r5r6--asr-pipeline-registry-template-governance-tenant-stt-fallbackbyok--retired-task-1006).
- **M3 SUPER_ADMIN-only enforcement is imperative, not declarative.** Every `AiRoutingPolicy` write is gated in the service via `assertSuperAdmin` (and the `nlp.` / `harness.` / `guardrail.` prefixes additionally pin the READ to SYSTEM), so the `@Authorize` decorator alone understates the gate — read the service, per rule 05.
- Model discovery probes are upstream-host dependent; the discovery e2e (`ai-model-discovery.spec.ts`) covers registration, not live probing of every provider host.
- **Text/RAG embedding is infra-tier, not catalog-tier — by design, not omission.** The `FEATURE_EXTRACTION`/`SENTENCE_SIMILARITY` `ModelTaskType` values have no seeded `AiModel` row. Verified 2026-07-28: `AI_TASK_KEYS` (`packages/applications/src/services/ai-routing-policy/constants.ts`) has no embedding task key, and `apps/harness`'s only embedding consumer (`RetrievalConfig` → `EmbeddingsClient`, `apps/harness/src/harness/core/config.py` + `services/embeddings_client.py`) resolves its endpoint/model entirely from `HARNESS_RETRIEVAL_EMBEDDINGS_*` env vars — never from `AiModel`/`AiProviderConnection`/`AiRoutingPolicy`. There is no DB-catalog lookup for a text embedder anywhere in the codebase. Do not re-flag this as a Day-1-defaults gap without first confirming a new resolver actually reads an embedding row from the catalog.

Last verified: 2026-09-29
