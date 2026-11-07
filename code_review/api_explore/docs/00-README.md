# API Gateway Documentation Index

This folder documents the `apps/api` NestJS gateway and its integrations. Files are ordered for a logical read-through.

## Core Concepts (01-07)
| File | Topic |
| --- | --- |
| [01-getting-started.md](01-getting-started.md) | Dev setup, build/test commands, artifact generation |
| [02-authentication.md](02-authentication.md) | Credentials (JWT, API key, service account), public routes, tenant context |
| [03-authorization.md](03-authorization.md) | Planes, decorators, scopes/abilities, 404-over-403, boot audits |
| [04-request-lifecycle.md](04-request-lifecycle.md) | Guards/interceptors/filters order, bootstrap, OCC flow |
| [05-configuration.md](05-configuration.md) | Env/schema, service URLs, internal tokens |
| [06a-COVERAGE-BY-AREA.md](06a-COVERAGE-BY-AREA.md) | Test coverage by area (existing) |
| [07-cross-cutting-concerns.md](07-cross-cutting-concerns.md) | Filters, interceptors, decorators, common utilities |

## Review & Inventory (08-11)
| File | Topic |
| --- | --- |
| [08-CODE-REVIEW.md](08-CODE-REVIEW.md) | Code review notes (existing) |
| [09-TEST-COVERAGE-GAPS.md](09-TEST-COVERAGE-GAPS.md) | Test gaps (existing) |
| [10-ROUTE-INVENTORY.md](10-ROUTE-INVENTORY.md) | Route inventory overview (existing) |
| [11-TRACEABILITY.md](11-TRACEABILITY.md) | Traceability matrix (existing) |

## API Gateway Deep Dive (12-17)
| File | Topic |
| --- | --- |
| [12-api-gateway-overview.md](12-api-gateway-overview.md) | What the gateway does, planes, pipeline, proxying vs orchestration |
| [13-api-catalog.md](13-api-catalog.md) | Full API surface grouped by route prefixes/controllers |
| [14-gateway-to-downstream-overview.md](14-gateway-to-downstream-overview.md) | Gateway→downstream mappings by service/category |
| [15-gateway-to-downstream-per-controller.md](15-gateway-to-downstream-per-controller.md) | Per-controller source→target tables |
| [16-downstream-to-gateway-internal-callbacks.md](16-downstream-to-gateway-internal-callbacks.md) | Downstream→gateway `/api/v1/internal/*` callbacks |
| [17-api-explore-summary.md](17-api-explore-summary.md) | Summary of findings |

## Deep Dives (18-25)
| File | Topic |
| --- | --- |
| [18-authorization-matrix.md](18-authorization-matrix.md) | Route-level authz matrix (planes, scopes, permissions, OCC, API-key/service-account rules) |
| [19-websocket-gateways.md](19-websocket-gateways.md) | WS gateways (/ws/stt/stream, /ws/tts/stream, /ws/workflows): auth, ownership, origin, backpressure |
| [20-boot-time-audits.md](20-boot-time-audits.md) | Boot audits that refuse to start on authorization/config drift |
| [21-internal-service-auth.md](21-internal-service-auth.md) | Internal service-to-service auth contract (X-Service-Token, X-Tenant-Id, tenantless, token resolution) |
| [22-async-queues-and-jobs.md](22-async-queues-and-jobs.md) | BullMQ queues, processors, concurrency, pool budget, workers in gateway process |
| [23-external-integrations.md](23-external-integrations.md) | Downstream services, IdPs, object storage, email/SMS, webhooks, model registry |
| [24-error-handling-and-downstream-failures.md](24-error-handling-and-downstream-failures.md) | Filters/interceptors, downstream error normalization, 404-over-403, OCC, failure logging |
| [25-end-to-end-data-flows.md](25-end-to-end-data-flows.md) | End-to-end flows (auth, STT WS, TTS WS, workflows WS, consultation orchestration, internal callbacks) |

## Quick Links
- **Route data:** [`../inventory/routes.json`](../inventory/routes.json), [`../inventory/routes-by-module.md`](../inventory/routes-by-module.md)
- **Source maps:** [`../inventory/controllers.json`](../inventory/controllers.json), [`../inventory/modules.json`](../inventory/modules.json)
- **Diagrams:** [`../diagrams/api-gateway-internals-deep-dive.html`](../diagrams/api-gateway-internals-deep-dive.html)
- **Codebase docs:** [`../codebase/ARCHITECTURE.md`](../codebase/ARCHITECTURE.md)
