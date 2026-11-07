# API Gateway B00 — Master Overview

Companion explainer for `api-gateway-b00-master.html`.

## Scope
`B00-master`: gateway-level overview only (no exhaustive endpoint boxes). Maps request entry -> NestJS API gateway/bootstrap -> global pipeline/cross-cutting refs -> domain batch map (B01–B08) -> shared dependencies. Repository: `https://github.com/ArcaAI/project-hope.git` @ `8cb2e5e8e6bbddf5ee7c676782ebb5ad683c23a0`.

## Cross-references (avoid duplication)
- `review/api_explore/diagrams/architecture/api-system-context.html`
- `review/api_explore/diagrams/architecture/api-gateway-internals-deep-dive.html`
- Tracker: `review/api_explore/diagrams/architecture/API_GATEWAY_ARCHITECTURE_TRACKER.md`

## Completed domain batch diagrams
- **B01 Auth/Identity:** `api-gateway-b01a-auth-credentials.html`, `api-gateway-b01b1-user.html`, `api-gateway-b01b2-rbac-security-idp.html`
- **B02 Tenancy/Admin:** `api-gateway-b02a-tenant-core-config.html`, `api-gateway-b02b-tenant-data-ops.html`, `api-gateway-b02c-settings-entitlements.html`
- **B03 Consultation:** `api-gateway-b03a1-consultation-lifecycle.html`, `api-gateway-b03a2-consultation-interactions-admin.html`, `api-gateway-b03a3-consultation-internal-harness.html`, `api-gateway-b03b-consultation-supporting.html`
- **B04 Streaming/Speech/Media:** `api-gateway-b04a-streaming-speech-media-pilot.html`, `api-gateway-b04b-streaming-speech-media-remaining.html`
- **B05 Agents/Workflows:** `api-gateway-b05a-agents-mcp.html`, `api-gateway-b05b-harness-admin.html`, `api-gateway-b05c-workflows.html`
- **B06 AI Platform:** `api-gateway-b06a-model-provider-routing.html`, `api-gateway-b06b-inference-prompts-knowledge.html`
- **B07 Guardrails/Ops:** `api-gateway-b07a-guardrails.html`, `api-gateway-b07b-observability-queues.html`, `api-gateway-b07c-release-comms-webhooks.html`
- **B08 Billing/Internal/Misc:** `api-gateway-b08a-billing-admin-misc.html`, `api-gateway-b08b-internal-misc.html`

## Evidence
Gateway sources (representative): `apps/api/src/main.ts`, `apps/api/src/app.module.ts`, `apps/api/src/global-prefix.config.ts`, `apps/api/src/cors.config.ts`, `apps/api/src/guards/*`, `apps/api/src/interceptors/*`, `apps/api/src/filters/*`, `apps/api/src/database/*`, `apps/api/src/config/*`. Detailed endpoint/controller/service/downstream evidence is in each batch diagram/explainer/receipt.

## Validation / limitations
- Archify finalize **pass** (`validate/deliver/check/browser-check`, showcase). Browser evidence pass; visual review not requested.
- Baseline inventory: 818 routes / 148 controllers / 77 modules (`review/api_explore/inventory/summary.json`). Domain batches B01–B08 cover modules with controller routes (0-route modules `__tests__`, `throttle`, `platform-knobs` excluded as noted).
- Batch diagrams primarily use **grouped endpoint nodes** for readability; strict 1:1 endpoint coverage, exact DTO schemas, async worker topology, secret/authref handling, and internal contract details require reconciliation with `inventory/*`, OpenAPI, and implementation.
- Global pipeline order/strategy details are referenced at directory/file level; see `api-gateway-internals-deep-dive.html` and code for implementation-specific behavior.
