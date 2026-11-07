# 16. API Gateway Exploration Summary

## What Was Done
- Reviewed the full repository structure and gateway implementation in [`apps/api`](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api).
- Used authoritative artifacts: [`apps/api/route-manifest.json`](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/route-manifest.json), [`apps/api/openapi.json`](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/openapi.json), [`apps/api/README.md`](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/README.md).
- Traced outbound HTTP/WebSocket calls from gateway controllers and service-layer clients in `packages/applications`.
- Identified internal callback APIs exposed by gateway for downstream services (Harness, STT).
- Created documentation in `../review/api_explore/docs/` with categorized source→target tables.

## Key Findings
- **Gateway role**: NestJS app terminating HTTP/WS on port 8868 under `api/v1`, enforcing auth/tenancy/consent/OCC, orchestrating via services in `packages/applications`. No Prisma/domain rules in `apps/api`.
- **Route surface**: 818 routes across 148 controllers/77 modules (from route manifest). Split into business plane and admin plane (`/admin/**` requires JWT/service-account only).
- **Proxies**: Only STT (WS + REST/session mgmt), Text (`text-generations`), and TTS (REST + WS) are directly proxied by gateway routes. NLP/Guardrail/Harness have no generic gateway proxy routes — they are called via service clients or health-monitored.
- **Orchestration**: Most routes hit DB/services; external calls come from `packages/applications` clients (Text/NLP/Guardrail/Harness/TTS/STT, webhooks, IdPs, object storage, queues).
- **Internal callbacks**: 56 routes under `/api/v1/internal/*` exposed for service-to-service calls (Harness callbacks, STT worker callbacks, agent/model/composed-prompt/governed-prompt/consent/etc.).

## Documentation Index (in `../review/api_explore/docs/`)
| Doc | Purpose |
|---|---|
| [12-api-gateway-overview.md](12-api-gateway-overview.md) | What the gateway does, planes, pipeline, proxying vs orchestration |
| [13-api-catalog.md](13-api-catalog.md) | Full API surface grouped by prefix/controller area |
| [14-gateway-to-downstream-overview.md](14-gateway-to-downstream-overview.md) | Gateway→downstream mappings by service/category |
| [15-gateway-to-downstream-per-controller.md](15-gateway-to-downstream-per-controller.md) | Per-controller/group source→target tables |
| [16-downstream-to-gateway-internal-callbacks.md](16-downstream-to-gateway-internal-callbacks.md) | Downstream→gateway `/internal/*` callbacks |
| [17-api-explore-summary.md](17-api-explore-summary.md) | This summary |

## How to Regenerate Artifacts
```bash
# From repo root
pnpm --filter @arcaai/api build
pnpm --filter @arcaai/api api:route-manifest
pnpm --filter @arcaai/api api:openapi
```
See [`apps/api/README.md`](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/README.md) for full details.

## Notes on Paths
- All documentation uses **repo-relative paths** (e.g., `apps/api/src/...`, `packages/applications/src/...`).
- Code references use **GitHub tree URLs** under `https://github.com/ArcaAI/project-hope/tree/dev-2.2/...` as requested.
