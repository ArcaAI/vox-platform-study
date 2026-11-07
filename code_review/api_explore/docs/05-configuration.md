# 05. Configuration

**Sources:** [`apps/api/src/config/env.schema.ts`](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/config/env.schema.ts), [`apps/api/src/config/env.descriptors.ts`](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/config/env.descriptors.ts), [`apps/api/src/common/gateway-http-agent.ts`](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/common/gateway-http-agent.ts)

## Environment Schema
Configuration is Zod-validated via `env.schema.ts` and described in `env.descriptors.ts`. Accessed via `apiEnv()` pattern in the app.

## Key Service URLs (Downstream)
From [`apps/api/src/config/env.descriptors.ts`](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/config/env.descriptors.ts) and [`apps/api/src/common/gateway-http-agent.ts`](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/common/gateway-http-agent.ts):

| Env Var | Default | Service | Notes |
| --- | --- | --- | --- |
| `TEXT_URL` | `http://localhost:8862` | Text service | Used by Text proxy, Text clients in services |
| `STT_URL` / `STT_V2_URL` | `http://localhost:8861` | STT service | STT WS + REST sessions |
| `NLP_URL` | `http://localhost:8864` | NLP service | NLP inference |
| `GUARDRAIL_URL` | `http://localhost:8863` | Guardrail service | Guardrail/analyze, redact, screen |
| `TTS_URL` | `http://localhost:8865` | TTS service | TTS REST + WS |
| `HARNESS_URL` / `HARNESS_BASE_URL` | `http://localhost:8866` | Harness service | Workflow/orchestration |
| `LMSTUDIO_AGENT_URL` | varies | LMStudio agent | Used by residency/agent flows |

## Internal Service Auth
| Secret/Var | Purpose | Notes |
| --- | --- | --- |
| `INTERNAL_ACCESS_TOKEN` | Shared internal service token | Used by proxy/base patterns and internal calls |
| `HARNESS_SERVICE_TOKEN` | Harness service token | Used by [`HarnessOpsClient`](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/modules/harness-admin/harness-ops.client.ts), [`HarnessGatewayService`](https://github.com/ArcaAI/project-hope/tree/dev-2.2/packages/applications/src/services/consultation/harness/harness-gateway.service.ts) |
| `HARNESS_INTERNAL_SERVICE_TOKEN` | Harness internal token | Used by [`KnowledgeIngestClient`](https://github.com/ArcaAI/project-hope/tree/dev-2.2/packages/applications/src/services/knowledge/knowledge-ingest.client.ts), [`KnowledgeVectorCleanupClient`](https://github.com/ArcaAI/project-hope/tree/dev-2.2/packages/applications/src/services/knowledge/knowledge-vector-cleanup.client.ts) |

## HTTP Agent Configuration
[`gateway-http-agent.ts`](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/common/gateway-http-agent.ts) documents connection pooling across modules (e.g., `TTS_URL`/`TEXT_URL` sockets shared across modules) and notes services use plain HTTP in-cluster.

See [14-gateway-to-downstream-overview.md](14-gateway-to-downstream-overview.md) for usage details.
