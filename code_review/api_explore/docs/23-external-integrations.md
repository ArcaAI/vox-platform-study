# 23. External Integrations

**Sources:** [`packages/applications/src/services/baseServices/_meta/config/config.service.ts`](https://github.com/ArcaAI/project-hope/tree/dev-2.2/packages/applications/src/services/baseServices/_meta/config/config.service.ts), [`packages/applications/src/services/baseServices/serviceHealth/serviceHealthMonitoring.service.ts`](https://github.com/ArcaAI/project-hope/tree/dev-2.2/packages/applications/src/services/baseServices/serviceHealth/serviceHealthMonitoring.service.ts), [`apps/api/src/modules/health/admin-health-services.controller.ts`](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/modules/health/admin-health-services.controller.ts), clients under [`packages/applications/src/services/`](https://github.com/ArcaAI/project-hope/tree/dev-2.2/packages/applications/src/services)

The gateway itself makes few direct external calls; most external I/O is performed by service-layer clients in `packages/applications`, invoked from gateway routes.

## Downstream HOPE Services (first-party)

| Service | App | Default URL | Health endpoint | Used for |
|---|---|---|---|---|
| Text | [`apps/text`](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/text) | `http://localhost:8862` (`TEXT_URL`) | `/api/v1/health` | LLM generation, summaries, token counts, agent invocations, DNA reports. Also directly proxied under `text-generations`. |
| Medical NLP | [`apps/nlp`](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/nlp) | `http://localhost:8864` (`NLP_URL`) | `/api/v1/health` | NER, classification, OCR enrichment, live documentation. |
| Speech-to-Text | [`apps/stt`](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/stt) | `http://localhost:8861` (`STT_URL`/`STT_V2_URL`) | `/api/v1/health` | Streaming + batch transcription, voice profiles, model registry credentials. |
| Text-to-Speech | [`apps/tts`](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/tts) | `http://localhost:8865` (`TTS_URL`) | `/api/v1/health` | REST synthesis + WS streaming bridge. |
| Guardrail | [`apps/guardrail`](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/guardrail) | `http://localhost:8863` (`GUARDRAIL_URL`) | `/api/health` | PHI redaction, prompt/policy screening, groundedness, judges. |
| Clinical Documentation Harness | [`apps/harness`](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/harness) | `http://localhost:8866` (`HARNESS_URL`) | `/api/v1/health` | Consultation orchestration, drafts, live docs, knowledge ingest. |
| vLLM | [`apps/vllm`](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/vllm) | configured per deployment | — | Inference service reading serving specs / shared token. |
| LM Studio | external/self-hosted | `LMSTUDIO_AGENT_URL` (no default) | — | Self-hosted embeddings/inference; unset = reported unreachable for residency. |

Health aggregation is admin-gated at `GET /api/v1/admin/health/services` (`AdminHealthServicesController`), not on the public health prefix. Public `GET /health*` routes are k8s probes only.

## Identity Providers

| Integration | Protocol / endpoint | Where |
|---|---|---|
| OIDC (any issuer) | `openid-client` discovery, authorization-code + PKCE, nonce, state TTL 5m | [`idp-resolver.service.ts`](https://github.com/ArcaAI/project-hope/tree/dev-2.2/packages/applications/src/services/idp-resolver/idp-resolver.service.ts), [`federated-auth.service.ts`](https://github.com/ArcaAI/project-hope/tree/dev-2.2/packages/applications/src/services/federated-auth/federated-auth.service.ts) |
| SAML | `@node-saml/node-saml` AuthnRequest/Response, assertion replay TTL 300s | [`federated-auth.service.ts`](https://github.com/ArcaAI/project-hope/tree/dev-2.2/packages/applications/src/services/federated-auth/federated-auth.service.ts) |
| Google Workspace directory | `https://oauth2.googleapis.com/token`, `https://admin.googleapis.com/admin/directory/v1` (readonly user/group scopes) | [`google-directory.provider.ts`](https://github.com/ArcaAI/project-hope/tree/dev-2.2/packages/applications/src/services/directory-sync/google-directory.provider.ts) |
| Microsoft Entra / Graph | `https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token`, `https://graph.microsoft.com/v1.0` (`.default` scope) | [`ms-graph-directory.provider.ts`](https://github.com/ArcaAI/project-hope/tree/dev-2.2/packages/applications/src/services/directory-sync/ms-graph-directory.provider.ts), [`microsoftGraph.integration.ts`](https://github.com/ArcaAI/project-hope/tree/dev-2.2/packages/applications/src/services/baseServices/integrations/microsoftGraph/microsoftGraph.integration.ts) |

Per-tenant IdP configuration lives in `TenantIdentityProvider*`; JIT provisioning maps groups → roles and is shared between login-time and directory-sync paths.

## Object Storage

| Integration | Details |
|---|---|
| S3-compatible (MinIO) | `S3_ENDPOINT`, `S3_REGION`, `S3_ACCESS_KEY`/`S3_SECRET_KEY` (secrets), `S3_FORCE_PATH_STYLE` (default true), `S3_REJECT_UNAUTHORIZED`, `S3_PRESIGNED_URL_EXPIRY` (3600s). Client: [`s3.service.ts`](https://github.com/ArcaAI/project-hope/tree/dev-2.2/packages/applications/src/services/baseServices/storage/s3/s3.service.ts). |
| Azure Blob | `AZURE_STORAGE_CONNECTION_STRING` or `AZURE_STORAGE_ACCOUNT_KEY`; alternative provider. |
| Tenant buckets | Per-tenant storage config + lifecycle/cleanup; platform storage settings resolver. |
| Model bucket | `hope-models` (weights published/verified by `DownloadAiModel`). |

## Webhooks (outbound)

- Admin CRUD at `/api/v1/admin/webhooks`; signing secret generated server-side and shown **once** (create/rotate).
- Delivery is async: `SysEvent` matcher → one `WebhookDelivery` job per subscribed webhook → signed POST, `WebhookRunHistory` attempt row, BullMQ retry/backoff.
- Signing secret pepper: `WEBHOOK_SECRET_PEPPER`.
- See [22-async-queues-and-jobs.md](22-async-queues-and-jobs.md) for the two-stage design.

## Email / SMS

`JobQueue.SendEmail` / `SendSms` are declared and enqueued by `sysEvent.service.ts`, and queue data for them is redacted by `queue-admin/job-data-redactor.service.ts` (`body`/`subject`, `message`). **No gateway `@Processor` for these queues exists in this tree** — delivery is handled outside the gateway process (or not yet wired). Do not assume a gateway-side sender.

## Messaging / Cache / Other

| Integration | Details |
|---|---|
| Redis | Cache, BullMQ, stream tickets, resume buffers, SSE/WS fan-out. `REDIS_HOST`/`PORT`/`PASS`. |
| MQTT | `MqttService` exists (`MQTT_HOST`, `MQTT_PORT`, `MQTT_USER`, `MQTT_PASS`), but it is not on the request-critical gateway path. |
| Hugging Face | Model discovery/publish via `HuggingFaceModelSourceClient`; token from SYSTEM-tenant `model-registry`/`huggingface` provider connection (`HUGGINGFACE_TOKEN`), not a global env var. |
| LM Studio | Self-hosted OpenAI-compatible embeddings endpoint (default `http://localhost:1234/v1`). PHI must not egress to cloud embeddings. |
| Model providers (cloud/BYOK) | Reached through `apps/text` / `apps/tts` per `AiProviderConnection`, never directly from a gateway controller. |
| OpenTelemetry | Traces/metrics/logs; GenAI content capture pinned to `NO_CONTENT` in production. |

## Egress Guard

Outbound calls pass through the egress guard in [`packages/applications/src/common/egress/egress-guard.ts`](https://github.com/ArcaAI/project-hope/tree/dev-2.2/packages/applications/src/common/egress/egress-guard.ts). Treat it as the policy point for which destinations are allowed; service URLs are topology, not user input.

## What the Gateway Does Not Proxy

There is no generic gateway proxy for NLP, Guardrail, or Harness. Those are reached by service clients or by other Python services directly; the gateway exposes them only through explicit feature routes and internal callbacks. `apps/api/src/shared/base-proxy.controller.ts` is abstract dead code with no production subclasses.

## References
- [packages/applications/src/services/baseServices/_meta/config/config.service.ts](https://github.com/ArcaAI/project-hope/tree/dev-2.2/packages/applications/src/services/baseServices/_meta/config/config.service.ts)
- [apps/api/src/modules/health/admin-health-services.controller.ts](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/modules/health/admin-health-services.controller.ts)
- [packages/applications/src/services/federated-auth/federated-auth.service.ts](https://github.com/ArcaAI/project-hope/tree/dev-2.2/packages/applications/src/services/federated-auth/federated-auth.service.ts)
- [packages/applications/src/services/directory-sync/](https://github.com/ArcaAI/project-hope/tree/dev-2.2/packages/applications/src/services/directory-sync)
- [packages/applications/src/services/baseServices/storage/s3/s3.service.ts](https://github.com/ArcaAI/project-hope/tree/dev-2.2/packages/applications/src/services/baseServices/storage/s3/s3.service.ts)
