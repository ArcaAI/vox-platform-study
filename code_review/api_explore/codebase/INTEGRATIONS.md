# Integrations

## Downstream services (Python)
| Service | Gateway touch | Ports/URLs (env) | Evidence |
|---|---|---|---|
| **STT** | WS gateway `SttWsGateway` at `/ws/stt/stream`, REST under transcription jobs; internal STT routes. | `stt.url` default `http://localhost:8861` (port 8861). | [apps/api/src/modules/streaming/stt-ws.gateway.ts](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/modules/streaming/stt-ws.gateway.ts), [apps/api/src/modules/internal/stt-internal.controller.ts](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/modules/internal/stt-internal.controller.ts), [apps/api/src/config/env.descriptors.ts:71,170](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/config/env.descriptors.ts#L71,L170) |
| **Text** | `TextProxyController` under `/api/v1/text-generations` (and redirect shim). Metering/precheck, guardrail relay. | `text.url` / related; configured via env descriptors. | [apps/api/src/modules/streaming/text-proxy.controller.ts](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/modules/streaming/text-proxy.controller.ts), [apps/api/README.md:243-246] |
| **TTS** | WS gateway `TtsWsGateway`, speech proxy. | `tts.url` port 8865. | [apps/api/src/modules/speech/tts-ws.gateway.ts](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/modules/speech/tts-ws.gateway.ts), [apps/api/src/modules/speech/speech-proxy.controller.ts](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/modules/speech/speech-proxy.controller.ts), [apps/api/src/config/env.descriptors.ts:84-85](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/config/env.descriptors.ts#L84-L85) |
| **NLP** | Health-monitored / reached elsewhere; no major gateway proxy route found. | `nlp.url` port 8864. | [apps/api/src/config/env.descriptors.ts:82-83](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/config/env.descriptors.ts#L82-L83), [apps/api/README.md:245] |
| **Guardrail** | Reached via Text proxy relay / elsewhere; health monitored. | Referenced in env descriptors/logs. | [apps/api/src/modules/streaming/text-proxy.guardrail-relay.task1050.test.ts](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/modules/streaming/text-proxy.guardrail-relay.task1050.test.ts), [apps/api/README.md:245] |
| **Harness** | Reached elsewhere / admin surfaces; no gateway proxy route found. | Referenced. | [apps/api/README.md:245] |

**Note:** `src/shared/base-proxy.controller.ts` exists but has no subclasses (unused). [apps/api/README.md:246]

## Infrastructure
| Component | Usage | Evidence |
|---|---|---|
| **Postgres/Prisma** | Via `@arcaai/database`; tenant-scope Prisma extension; pool telemetry. | [apps/api/src/app.module.ts:349-350,403-440](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/app.module.ts#L349-L350), [apps/api/src/database/tenant-context.provider.ts](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/database/tenant-context.provider.ts), [packages/database/src/index.ts](https://github.com/ArcaAI/project-hope/tree/dev-2.2/packages/database/src/index.ts) |
| **Redis** | BullMQ queues, throttling storage, stream tickets, caching. | [apps/api/package.json:88,110], [apps/api/src/app.module.ts:293,340-350,414-430](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/app.module.ts#L293), [apps/api/src/modules/auth/stream-ticket.service.ts](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/modules/auth/stream-ticket.service.ts) |
| **S3/MinIO** | Object storage via `BlobStorageModule`. | [apps/api/src/app.module.ts:431-432](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/app.module.ts#L431-L432), [apps/api/src/config/env.descriptors.ts:566-567](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/config/env.descriptors.ts#L566-L567) |
| **Vault** | Secrets/rotation (conditional). | [apps/api/src/config/env.descriptors.ts:31-204](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/config/env.descriptors.ts#L31-L204), [apps/api/src/app.module.ts:445-455](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/app.module.ts#L445-L455) |
| **BullMQ workers** | Queue processing; checkpoint workers separate processes. | [apps/api/src/app.module.ts:293,414-430](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/app.module.ts#L293), [apps/api/README.md:45-47] |
| **OTel** | Tracing/metrics exporters. | [apps/api/package.json:100-109](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/package.json#L100-L109) |

## External/third-party
| Integration | Usage | Evidence |
|---|---|---|
| **Prometheus** | `/metrics` endpoint (third-party controller marked public). | [apps/api/src/bootstrap/third-party-public-routes.ts](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/bootstrap/third-party-public-routes.ts), [apps/api/README.md:154] |
| **OIDC** | Platform OIDC tier retired (factory returns null now). | [apps/api/README.md:170], [apps/api/tests/helpers/test-app-module.ts:134-144](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/tests/helpers/test-app-module.ts#L134-L144) |

## Internal service routes
`/internal/*` routes exist (agent, model registry/serving, STT, effective-config, composed-prompt). Guarded by `InternalServiceTokenGuard`/service accounts; audits ensure off API-key surface. [apps/api/src/modules/internal/](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/modules/internal/), [apps/api/src/main.ts:378-380](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/main.ts#L378-L380), [apps/api/src/bootstrap/api-key-scope-audit.ts](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/bootstrap/api-key-scope-audit.ts)

## Evidence
- Env descriptors: [apps/api/src/config/env.descriptors.ts](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/config/env.descriptors.ts)
- Internal module: [apps/api/src/modules/internal/internal.module.ts](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/modules/internal/internal.module.ts)
- STT gateway: [apps/api/src/modules/streaming/stt-ws.gateway.ts](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/modules/streaming/stt-ws.gateway.ts)
- Text proxy: [apps/api/src/modules/streaming/text-proxy.controller.ts](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/modules/streaming/text-proxy.controller.ts)
- TTS gateway: [apps/api/src/modules/speech/tts-ws.gateway.ts](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/modules/speech/tts-ws.gateway.ts)
- Third-party routes: [apps/api/src/bootstrap/third-party-public-routes.ts](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/bootstrap/third-party-public-routes.ts)
- Database index: [packages/database/src/index.ts](https://github.com/ArcaAI/project-hope/tree/dev-2.2/packages/database/src/index.ts)