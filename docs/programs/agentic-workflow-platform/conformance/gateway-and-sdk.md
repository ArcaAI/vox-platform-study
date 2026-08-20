# Conformance Review — `apps/api` Gateway and the SDKs

| | |
|---|---|
| **Status** | Review complete — findings only, no code changed |
| **Reviewed** | 2026-08-18 |
| **Scope** | `apps/api`, `packages/agentic-sdk-v2` (`@arcaai/vox`), `packages/vox-node` (`@arcaai/vox-node`) |
| **Conformance target** | [product-brief.md](../product-brief.md) §1, §2, §3 `api` · [owner-decisions-2026-08-17.md](../owner-decisions-2026-08-17.md) D-A, D-B, D-D, D-E |
| **Method** | Static inspection only. No tests, builds, migrations or DB access were run. Every claim carries a `file:line`. |
| **Concurrency caveat** | Three other agents were writing to this tree during the review. Line numbers are accurate as of the read but may drift. Two items were **verified as closed mid-review and are therefore NOT reported as gaps**: DNA style erasure (`DELETE /dna-writing-styles/my-style` and `/:reportId` now exist — `apps/api/src/modules/dna-writing-style/dna-writing-style.controller.ts:267,289`) and the `featureAgenticLoop` entitlement column (migration `20260817161511_task_705_entitlement_agentic_loop`). |
| **Note on `text`** | Per owner decision §3b#3, surviving `text` identifiers are a known in-flight rename (TASK-740) and are **not** reported as findings here. The frozen wire path `api/smr/api/v1` is a deliberate carve-out. |

---

## 0. Executive summary

The gateway is a mature, well-governed **layered DDD service architecture** with an unusually
strong tenancy posture (404-over-403, CLS-resolved `tenantId`, boot-time deny-by-default audits,
single-use stream tickets, RFC 7232 OCC). It is **not CQRS**, and never has been (§3).

Against the brief the gateway's *breadth* is good and its *reachability* is the problem. The three
product surfaces exist, but each is reachable through a different, partially-built channel set, and
the two channels the brief names for machine integration — **Webhooks** and the **workflow exposure
API** — are respectively **semantically empty** and **switched off**. `@arcaai/vox-node`, the SDK a
server integrator would use, covers **one** of the three surfaces.

One finding is a live security defect rather than an unfinished feature: the API-key authorization
path **fails open** on routes that declare no scopes, and the whole STT/TTS surface declares none
(§6.1).

---

## 1. Conformance table

| # | Obligation (source) | Verdict | Evidence | Gap |
|---|---|---|---|---|
| **C1** | `api` built on **DDD** (brief §3 `api`) | **CONFORMS** | Entity/factory/mapper/repository trios in `packages/domains/src/{entities,factories,mappers,repositories}/generated/core/`; services extend `BaseService` (`packages/applications/src/common/base.service.ts`); controllers hold no Prisma (lint-enforced, `apps/api/src/modules/**`) | — |
| **C2** | `api` built on **CQRS** (brief §3 `api`) | **ABSENT** | Zero hits for `CommandBus`/`QueryBus`/`CommandHandler`/`QueryHandler`/`@nestjs/cqrs` across `apps/api/src`, `packages/applications/src`, `packages/domains/src`. `@nestjs/cqrs` is in no `package.json`. The `*.query.ts` files (e.g. `packages/applications/src/common/dto/paginated.query.ts`) are pagination/filter **DTOs**, not a query side. Reads and writes share one service, one repository, one Prisma client. | The brief's stated architecture is not implemented. See §3 for the verdict and recommendation — this is a **documentation-vs-code divergence to adjudicate**, not automatically a build order. |
| **C3** | Handles **all external requests**; validates and authenticates clients (brief §3) | **CONFORMS** | Global prefix `api/v1` (`apps/api/src/main.ts:102`); deny-by-default `UnifiedAuthGuard` (`packages/applications/src/authorization/unified-auth.guard.ts`); boot audits refuse startup on unguarded routes (`apps/api/src/bootstrap/{admin-route-permission-audit,api-key-scope-audit,consent-route-coverage-audit,jwt-secret-placeholder-audit}.ts`); strict global `ValidationPipe` with `forbidNonWhitelisted` | Authorization *depth* on the API-key path is defective — see **C4**. |
| **C4** | Client authorization is actually enforced | **ABSENT (defect)** | `unified-auth.guard.ts:298-303` — `enforceApiKeyScopes` returns early when a route declares no `@RequiredScopes`. `handleApiKeyAuth` then `return true`s at `:281` **without ever reaching** `handleJwtPostAuth` (`:321-398`), the only place CASL `ability.can(...)` is evaluated. So on the API-key path, scopes are the entire authorization decision — and absent scopes mean **no decision at all**. 69 of 95 controllers declare `@RequiredScopes`; `transcription-job.controller.ts`, `stt-compat.controller.ts` and `speech-proxy.controller.ts` declare **zero**, carry only bare `@Authorize()` (authentication-only, e.g. `transcription-job.controller.ts:71`), and carry no `@ForbidApiKey`. | Any valid API key bearing any scope reaches every STT and TTS route unauthorized. **This is the precondition TASK-722 named for enabling exposure** and it is not met. |
| **C5** | Mediates **internal service-to-service** traffic (brief §3) | **PARTIAL — by documented design** | Gateway proxies all six Python services (`getConfigValue('TEXT_URL'\|'STT_URL'\|'NLP_URL'\|'GUARDRAIL_URL'\|'HARNESS_URL'\|'TTS_URL')`). But peers call each other **directly**, bypassing it: `apps/text/src/text/services/external_guardrail.py:88`, `apps/nlp/src/nlp/services/external_text_client.py:103`, and `apps/harness/src/harness/services/{text,nlp,guardrail,embeddings,reranker}_client.py`. | Sanctioned by `.claude/rules/06-python-services.md` (a gateway hop would close a `gateway→text→guardrail→gateway` cycle). The **brief says otherwise**; needs an owner ruling, not a code change. |
| **C6** | Internal transport over HTTP / SSE / **WebSocket / Message Queue / Event Bus** (brief §3) | **PARTIAL** | HTTP ✓, SSE ✓ (17 `@Sse()` routes), WebSocket ✓ (3 gateways: `streaming/stt-ws.gateway.ts:195` `/ws/stt/stream`, `stt-compat/stt-compat.gateway.ts:29` `/stt`, `speech/tts-ws.gateway.ts:104` `/ws/tts/stream`). **No MQ / event bus**: zero hits for `amqp`/`rabbitmq`/`kafka`/`nats`/`@nestjs/microservices`/`MessagePattern`/`EventPattern`. `packages/applications/src/services/index.ts:10` records "Kafka service removed". | What exists is **in-process** `EventEmitter2` (45 `@OnEvent` handlers) plus **internal** BullMQ/Redis queues and Redis Streams for STT. Neither is an inter-service bus and neither is exposed to a tenant. |
| **C7** | **One shared internal token** (D-D) | **ABSENT (in flight)** | At least 8 distinct per-service tokens live: `TEXT_SERVICE_TOKEN` (80 refs), `HARNESS_SERVICE_TOKEN` (69), `GUARDRAIL_SERVICE_TOKEN` (55), `NLP_SERVICE_TOKEN` (43), `TTS_SERVICE_TOKEN` (20), `HARNESS_INTERNAL_SERVICE_TOKEN` (14), `STT_SERVICE_TOKEN`, plus pair-scoped `TEXT_EXTERNAL_GUARDRAIL_SERVICE_TOKEN` / `NLP_EXTERNAL_TEXT_SERVICE_TOKEN`. Call sites e.g. `apps/api/src/modules/ai-inference/ai-inference.client.ts:66,71`. | TASK-738 owns this. Reported for completeness, not as a new gap. |
| **C8** | Config in DB/Vault, env is last resort (D-B) | **PARTIAL** | Good: the settings-registry descriptor architecture (`packages/applications/src/services/settings-registry/descriptors/`) is exactly the right shape; entitlements and most knobs are DB-resident. Bad: `WORKFLOW_EXPOSURE_ENABLED` is a **process-wide env boolean** (`packages/applications/src/services/baseServices/_meta/config/config.service.ts`), platform-wide with no tenant tier. (`WORKFLOW_EXPOSURE_ALLOW_CLOUD_PROVIDERS`, the sibling cloud-provider gate this row used to name, was REMOVED under TASK-720 R-4, 2026-08-20 owner ruling — a publicly-exposed workflow may select a cloud provider, the tenant carries the risk, so there is no longer a gate here to make tenant-resolvable.) | Gates a **tenant-facing product surface**; per D-B §"Resolution order is always tenant → SYSTEM" it should be a tenant-resolvable entitlement. |
| **C9** | Two-tier resolution, never a customer tenant as fallback (D-B, rule 00) | **PARTIAL** | `ENTITLEMENTS_TENANT_ID = '50000000-…'` (`packages/applications/src/services/entitlements/entitlements.constants.ts:23`) — the entitlements kill-switch row is owned by the **"Global" customer tenant**, not SYSTEM. | Tolerated by rule 09 §Config caches (platform-reserved tenants only) but contradicts rule 00 §"The two reserved tenants are NOT two config tiers". Low risk, worth a decision. |
| **C10** | Plan/feature entitlements enforced at the gateway (brief §2) | **PARTIAL** | Enforcement is real and broad — 20+ call sites: `assertMeterQuota` (consultations, summaries, LLM tokens, transcription minutes, TTS chars, workflow invocations), `assertQuantityQuota` (users, departments, prompt templates, ASR pipelines, API keys, workflow definitions), `assertConcurrencyQuota` (`transcription-job.controller.ts:581`), `isFeatureEnabled` (`agenticLoop`, `paletteStt`, `platformDefaultCredential`). Kill-switch `entitlements.enabled` defaults **false** locally, **true** in deployed envs by policy (`feature-flags.descriptors.ts:90-95`). | Feature *booleans* cover only 6 flags (`entitlement.prisma:114-143`). There is **no** `featurePaletteSummarization`, `featurePaletteConsultation`, or `featureWorkflowExposure` — so two of three palettes and the entire exposure plane cannot be sold as plan features. Also **absent**: `quotaAgenticLoopSessionsPerDay` required by owner decision §3b#5 (STARTER = loop ON, capped 5/day). |
| **C11** | Super-admin manages the **twelve** §2 areas | **PARTIAL — 9 of 12** | See §4 for the item-by-item table. | **Plans** cannot be created (fixed 4-value `TenantPlan` enum, `enums.prisma:38-45`); **alerting** is read-only; **DR/backup** has no surface at all. |
| **C12** | Three surfaces exposable as **API / Socket / Webhook / SDK** (brief §1) | **PARTIAL** | See the matrix in §2. | 5 of 12 cells absent; the entire Webhook column is semantically hollow (**G1**) and the workflow API column is switched off (**G2**). |
| **C13** | **HOPE stores no patients — only an external `patientId`** (brief §1.6) | **CONFORMS at the core, PARTIAL at the edges** | No `Patient` model exists. `Consultation.patientId` is a bare `String` with **no FK** (`packages/database/src/prisma/db_main/consultation.prisma:13-14`). No `patientName`/`dob`/`mrn` field exists anywhere in `apps/api` or `packages/applications` DTOs — those tokens appear **only** in log redactors (`baseServices/logging/redactor.ts:68-72`, `queue-admin/job-data-redactor.service.ts:21`). Browser SDK `OpenSessionInput` carries `patientId` only (`packages/agentic-sdk-v2/src/types/consultation.ts:89-99`); no patient data is persisted client-side, and the cross-tab key is hashed (`core/SimpleCrossTabSync.ts:138-140,264`). | Three leaks, all on the **v1-compat** surface plus one schema hole — see **G6**. |
| **C14** | Consultation = per-**department** workflows with **end-user personalization** (brief §1) | **PARTIAL** | Department side is strong at the data layer: `DepartmentAgent` binds prompt templates, tool config, LLM overrides and loop role per department (`packages/database/src/prisma/db_main/department-agent.prisma:20-70`). Personalization exists per clinician (`DnaWritingStyleReport.doctorId`, `dna-writing-style.prisma:11`; `UserVoiceProfile`; `UserSettings`). | Department→**workflow** assignment does not exist (TASK-733 **Pending**); neither SDK can select a workflow by department or address a per-end-user identity. See **G5**. |
| **C15** | D-E — SDK · Console · Backend all agree | **PARTIAL** | Browser SDK tracks the backend well for STT/summarization/consultation. | `@arcaai/vox-node` covers 1 of 3 surfaces; neither SDK reaches the workflow exposure plane at all. See **G4**. |

---

## 2. Surface × channel matrix — what is reachable **today**

Legend: ✅ reachable · ⚠️ reachable but materially incomplete · ⛔ built but gated off · ❌ absent

| Surface | **API (REST)** | **Socket (WS)** | **Webhook** | **SDK (browser)** | **SDK (node)** |
|---|---|---|---|---|---|
| **Speech-to-text** | ✅ `admin/audio/transcription-jobs`, `audio/transcription-jobs`, `api/stt` (`stt-compat.controller.ts:60,77,186,290`) — but see **C4**: no scope gate | ✅ `/ws/stt/stream` (`streaming/stt-ws.gateway.ts:195`), `/stt` (`stt-compat.gateway.ts:29`); single-use 30 s tickets (`auth/stream-ticket.service.ts:25`) | ⚠️ only `ResourceCreated/Updated` on `TranscriptionJob` — no `transcription.completed` | ✅ full: local + backend streaming + batch (`plugins.ts:42`, `core.ts:707-729`) | ❌ **none** — `README.md:18` states "Audio/VAD/STT/ML \| None" |
| **Summarization** | ✅ `api/smr/api/v1/{presummary,summary/sync}` (`text-compat.controller.ts:306,580`), `consultations/:id/summary*`, `text/generate` (`streaming/text-proxy.controller.ts:511`) | ❌ none (SSE only) | ⚠️ only CRUD on `SummaryMeta` | ✅ full (`useArcaSummary`, `useArcaLiveSummary`; 20 endpoints `core/constants.ts:136-171`) | ✅ full — 12 of 13 methods, sync + SSE |
| **Consultation** | ✅ `consultations/*` + 5 SSE streams (live-summary, harness-progress, harness-assurance, trajectory, loop — `consultation.controller.ts:611,628,647,668,719`) | ❌ **no consultation WebSocket** | ⚠️ only CRUD on `Consultation` | ✅ full (session, context, chain, schema, jobs, loop stream) | ⚠️ **`get(id)` only** — its own docstring says "NOT consultation CRUD; out of day-1 scope" (`src/resources/consultations.ts:2-3`) |
| *(Workflow abstraction)* | ⛔ `POST /workflows/:slug/invoke` + status/cancel/stream **built and complete** but 404-gated by `WORKFLOW_EXPOSURE_ENABLED=false` | ❌ none — the "stream" is a 2 s **polling bridge**, not a live producer (`workflow-stream.service.ts:9,16-43`) | ❌ **no workflow run lifecycle event exists at all** | ❌ no invoke, no per-run status, no per-workflow stream | ❌ absent entirely |

**Reading of the matrix.** Only STT is genuinely multi-channel. Consultation — *the brief's "main / core business"* — has no socket and no server SDK. And the workflow abstraction, which is the layer the brief says all three surfaces are *authored and exposed through*, is reachable on exactly one channel, which is turned off.

---

## 3. CQRS — verdict

### 3.1 Verdict: **CQRS is not implemented, and nothing in the codebase is moving toward it.**

This is not a partial or in-progress adoption. There is no command bus, no query bus, no command or
query handler, no read model, no projection, no event store, and no `@nestjs/cqrs` dependency
anywhere in the repository. Every mutation and every read travels the identical path:

```
Controller → I<Xxx>Service (BaseService) → <Xxx>Repository → extended Prisma client → one Postgres table
```

The nearest constructs are decoys. `*.query.ts` files are `class-validator` pagination/filter DTOs.
`EventEmitter2` + `@OnEvent` (45 handlers) is an **in-process pub/sub for side effects** — audit
rows, webhooks, user activity — fired *after* a write completes; it does not separate a read model,
it does not replay, and no read ever consults it. That is event-driven fan-out, which is a different
pattern with a different purpose.

### 3.2 What adopting CQRS would actually cost

A faithful adoption is not a refactor of `apps/api`; it reaches every layer:

| Work | Scale |
|---|---|
| Command/query bus + handler-per-operation | ~60 application services in `packages/applications/src/services/`, each with 4–15 public methods |
| A separate read model | New denormalized tables or views, plus projectors, plus a rebuild path, plus backfill |
| Eventual-consistency contract at the API edge | Every `POST`-then-`GET` client flow must tolerate lag — **including the SDKs and the admin console**, i.e. a public contract change |
| Reconciling with the existing OCC design | `_version` → strong `ETag` → `If-Match` → `updateWithVersion` (rule 05) is a **read-your-own-write** pattern. A lagging read model breaks it; the 428/412 contract would need redesign |
| Test surface | Every service unit test asserts `repository` + `broadcastSysEvent` interactions directly |

### 3.3 Recommendation: **do not adopt CQRS. Amend the brief instead.**

The reasoning, stated plainly:

1. **CQRS earns its cost when read and write loads diverge and must scale independently.** HOPE's
   heavy workloads — ASR, LLM generation, NER, guardrails — are already offloaded to Python services,
   Temporal and BullMQ. The Postgres tier is metadata and configuration: low write volume, modest
   read volume, and admin-console reads that are explicitly *dynamic-by-default, fresh-read wins*
   (rule 13 §Caching). There is no load asymmetry for CQRS to relieve.
2. **The platform's hardest requirement is tenant correctness, not throughput.** The current single-path
   architecture is what makes 404-over-403 provable in one place, and lets the Prisma tenant-scope
   extension be a single enforcement point. A second read path is a **second place to leak a tenant**.
   For a PHI platform this is a straight downgrade in the property that matters most.
3. **Eventual consistency is a clinical-safety hazard here.** A clinician signing a note and
   immediately re-reading it must see their own write. The OCC/ETag contract already assumes this.
4. **The real complaint the brief is likely voicing is not "we lack CQRS"** — it is that the write
   path (services) and the read path (grid/reporting queries) are not separately optimized. Two
   already-present primitives address that at ~1 % of the cost: keyset pagination
   (`packages/applications/src/common/cursorPagination.ts`) and read-optimized indexes/views.

**Proposed resolution:** replace "Built on **DDD and CQRS**" in `product-brief.md` §3 `api` with
"Built on **DDD**, with command/query *responsibility* separated at the service-method level and
read-optimized query paths where measurement justifies them." If the owner intends literal CQRS
regardless, that is a program-sized epic and should be scoped as one, not absorbed into a wave.
**Ticket: TASK-741 (docs) — reconcile the brief's architecture statement with the implementation.**

---

## 4. Super-admin management — the twelve §2 areas

| # | §2 area | Verdict | Backing surface |
|---|---|---|---|
| 1 | **Tenants** | ✅ REAL | `admin/tenants` (+ storage config/buckets/keys, frontend config, IdP config, allowed origins, STT/TTS config) |
| 2 | **Plans** | ⚠️ PARTIAL | `admin/entitlements` edits the **plan matrix** and per-tenant overrides — but `TenantPlan` is a fixed 4-value Prisma enum (`enums.prisma:38-45`). A super-admin **cannot create a plan**; the brief's "customized plan set by a super-admin" is expressible only as a per-tenant `TenantEntitlement` override row. |
| 3 | **Features** | ⚠️ PARTIAL | Only 6 boolean features exist (`entitlement.prisma:114-143`). Summarization palette, consultation palette and workflow exposure are **not** sellable features. |
| 4 | **Configuration** | ✅ REAL | `admin/settings` + the settings-registry descriptor catalog + `admin/platform-knobs`; per-key governance with declared tiers and `failMode` |
| 5 | **Customization** | ✅ REAL | `admin/prompt-templates`, `admin/workflow-definitions`, `admin/department-agents`, `admin/consultation-context-schemas`, `admin/tenant-frontend-config`, `admin/ai-task-defaults` |
| 6 | **Audit trail** | ✅ REAL | `admin/audit-logs` + the sys-event → BullMQ → `AuditLog` pipeline + `ImpersonationAuditInterceptor` |
| 7 | **Security** | ✅ REAL | `admin/rbac/{roles,policies}`, `admin/api-keys`, `admin/allowed-origins`, `admin/consent-grants`, `admin/tenant-idp-config`, `admin/rate-limit` — *caveat*: see **G7** (no privilege ceiling on API-key minting) |
| 8 | **Performance** | ✅ REAL | `admin/platform` (Prometheus-backed), `admin/queues`, `admin/schedulers`, `/metrics` |
| 9 | **Compliance** | ⚠️ PARTIAL | Consent grants (`admin/consent-grants` — `@Post`/`@Get` only), audit retention service, PHI redactors. **No revoke route** on consent (`consent.controller.ts:31,39`); no retention/erasure admin surface. |
| 10 | **Reporting & analytics** | ✅ REAL | `admin/usage`, `admin/usage/reconciliation`, `admin/billing/{invoices,rate-card}`, `usage` |
| 11 | **Monitoring & alerting** | ⚠️ PARTIAL | Monitoring ✅ (`monitoring/uptime`, `/heartbeats/:service`, `/sessions`). **Alerting ✗** — `admin/notifications` is **read-only** (`notification.controller.ts:34,49` — two `@Get`s, no create/update); there is no alert-rule resource. |
| 12 | **Disaster recovery & backup** | ❌ **ABSENT** | No controller, service, or model. Searched `apps/api/src/modules` for `backup`/`restore`/`recovery`/`export` controllers → zero. |

**Score: 7 real, 4 partial, 1 absent.**

---

## 5. Webhook channel — what TASK-727 actually delivers

The **delivery machinery is production-grade**; the **event vocabulary is not**.

**Strong:** HMAC-SHA256 signing as `X-Hope-Webhook-Signature: sha256=<hex>`
(`webhook-delivery.processor.ts:307,318`); 5 attempts with exponential backoff 2/4/8/16/32 s
(`:74-79`); dead-letter retention; double idempotency (BullMQ `jobId` + authoritative
`WebhookRunHistory` SUCCESS lookup, `:284-294`); reference-not-content payloads carrying only
`{eventType, resourceType, resourceId, tenantId, occurredAt, fetchUrl}` (`:127-135`) — a genuinely
good PHI posture; per-tenant subscription with optional per-resource-id narrowing (`:187-197`);
secret returned once, rotatable with no overlap window.

**The problem — the entire deliverable vocabulary is five CRUD verbs** (`packages/domains/src/enums/sysEventType.enum.ts:1-19`):
`ResourceCreated`, `ResourceViewed`, `ResourceUpdated`, `ResourceDeleted`, `ResourceArchived`.
Consequences:

- There is **no** `transcription.completed`, `summary.ready`, `consultation.signed`, or
  `workflow.run.completed`. An integrator cannot subscribe to *anything finishing*.
- **`WorkflowRun` is not even a `ResourceType`**, and `workflow-run.service.ts` contains **zero**
  `broadcastSysEvent` calls. A workflow run's terminal state is invisible to the webhook channel —
  the single most important async callback for a server integrator simply does not exist.
- `WorkflowExposureService` broadcasts against `ResourceType.WorkflowDefinition`
  (`workflow-exposure.service.ts:54,141,179`), so "definition created" and "run invoked" arrive as an
  **indistinguishable** `ResourceCreated`; the `action` discriminator lives in `SysEvent.data`, which
  is stripped from the outbound payload.
- `Webhook` has **no event-type column** (`webhook.prisma:11-17`) — a subscriber to `Consultation`
  receives created + viewed + updated + deleted + archived with no way to narrow. `ResourceViewed`
  fires on every read.
- `CreateWebhookRequest.resourceTypeName` is `@IsString()` only (`createWebhook.request.ts:20-22`),
  **not validated against the `ResourceType` enum** — a typo silently creates a webhook that never fires.
- `callbackUrl` on the consultation job DTOs (`consultation/jobs/dto/job.dto.ts:24,39,54,63`) is
  stored (`consultation-job.service.ts:101,164`) and **never read by any consumer** — a dead field
  that an integrator will reasonably assume works.
- Fail-open: if secret decryption fails, delivery proceeds **unsigned** (`webhook-delivery.processor.ts:362-373`).

---

## 6. Security findings (raised independently of the brief)

### 6.1 API-key authorization fails open — **the sharpest finding in this review**

Three facts compose into a live gap:

1. `enforceApiKeyScopes` **returns early** when a route declares no `@RequiredScopes`
   (`unified-auth.guard.ts:301-303`).
2. `handleApiKeyAuth` `return true`s at `:281` **without reaching** `handleJwtPostAuth` (`:321-398`),
   the only place CASL abilities are evaluated. On the API-key path, scopes *are* the whole
   authorization decision.
3. The STT/TTS controllers declare **no scopes at all** and carry only bare `@Authorize()`
   (`streaming/transcription-job.controller.ts:71` — 21 routes, 0 scopes;
   `stt-compat/stt-compat.controller.ts` — 0 scopes; `speech/speech-proxy.controller.ts:247,386` —
   0 scopes), and none carries `@ForbidApiKey`.

**Therefore:** an API key issued with a trivial scope (e.g. `user:profile:read`) reaches every STT
and TTS route with **no authorization check performed**. The boot audit that would catch this covers
only 18 hand-listed routes (`api-key-scope-audit.ts:44-69`) plus `/internal/*` — not the platform.

This is precisely the precondition TASK-722 named for enabling exposure
(`feature-flags.descriptors.ts:77` — *"TASK-708's API-key scope enforcement must be verified
end-to-end before this ships enabled"*). It is **not met**, which retrospectively justifies the
kill-switch — and means flipping it on before fixing this would be unsafe.

### 6.2 The exposure kill-switch does not cover the whole surface

`assertExposureEnabled()` is called in `list()` (`workflow-exposure.service.ts:59`) and `invoke()`
(`:69`) **only**. `getRunStatus()` (`:163`), `cancelRun()` (`:173`) and therefore the SSE stream
(`workflow-stream.service.ts:58` delegates to `getRunStatus`) remain reachable with the flag off —
contradicting both the controller doc (`workflows.controller.ts:19-23`) and the descriptor's
"kill-switch for the **whole** … surface".

### 6.3 A second, ungated runtime invoker

`POST /api/v1/admin/workflow-definitions/:definitionId/sandbox-runs`
(`workflow-sandbox-run.controller.ts:34,41`) starts a real run of **any** version, DRAFT or
published. Its doc claims "Session-JWT admin console ONLY" (`:19-21`) but **nothing enforces that**:
`admin:workflow-definition:manage` is an issuable API-key scope
(`apikey-scopes.registry.ts:123`), the API-key path never evaluates CASL (§6.1), and
`WORKFLOW_EXPOSURE_ENABLED` is not read by `workflow-sandbox-run.service.ts`.

**Status (TASK-759, 2026-08-18).** Re-verified; the finding stands, with two corrections to its
framing and no code change in this ticket — `WorkflowSandboxRunController`'s decorators are
deliberately untouched here.

1. **The drift is closed by TASK-757, not by a taxonomy move.** The prefix is already
   `admin/…` (`workflow-sandbox-run.controller.ts:34`), so P1/P2 have nothing to do. TASK-757's
   class-level `@ForbidApiKey()` sweep across the admin plane (policy A2) turns the
   `@RequiredScopes('admin:workflow-definition:manage')` at `:33` into an inert declaration and
   makes the "Session-JWT admin console ONLY" doc comment true. Tracked there, not here.
2. **"the API-key path never evaluates CASL" was true pre-TASK-742 and is now false.**
   `enforceApiKeyAbilities` (`packages/applications/src/authorization/unified-auth.guard.ts`)
   evaluates the route's `@CanCreate('WorkflowRun')` / `@CanRead` / `@CanUpdate` metadata against
   the key's bound user. The blast radius is therefore narrower than stated above: an API key must
   still hold the CASL ability through its bound user. The finding itself — a doc comment
   asserting a restriction no decorator enforces — is unaffected.

### 6.4 No privilege ceiling on API-key minting

`apikey.service.ts` create/update enforce cross-tenant checks (`:250-254`), linkage (`:259-284`),
`maxApiKeys` quota (`:290-294`) and max lifetime (`:298-311`) — but **no check that the requesting
principal holds the scopes being granted**. Anyone reaching `POST /admin/api-keys` can mint a key
carrying `workflow:*` or `admin:*`. Prefix matching widens this further
(`apikey.service.ts:838-868`: `'*'` grants everything; a bare parent grants all children).

---

## 7. Patient-identity conformance (brief §1.6) — detail

**The core is right.** No `Patient` model; `Consultation.patientId` is an unconstrained `String` with
no FK; no demographic field exists in any `apps/api` or `packages/applications` DTO. Nothing
patient-scoped is persisted client-side by the browser SDK, and its cross-tab channel key is hashed.

**Four leaks:**

| # | Leak | Evidence |
|---|---|---|
| a | **Unbounded free-form JSON on the consultation.** `metadata?: Record<string, unknown>` is accepted on both open and update with no schema and no redaction (`consultation/dto/open-consultation.request.ts:39`, `update-consultation.request.ts:35`) and persisted to `Consultation.metadata Json?`. An EMR integrator can push demographics straight into the database, and `useArcaSessionManager` in the compat SDK **already does** — writing `{ id: patientId, name: patientName }` into it (`packages/agentic-sdk-v2/src/compat/useArcaSessionManager.ts:104,121`). |
| b | **Browser SDK `./compat` sends demographics.** `PatientInfo` carries `mrn` (`compat/types.ts:130`), `date_of_birth` (`:134`), name, age, gender, plus `[key: string]: unknown`; put on the wire at `compat/useText.ts:152`, and pre-summary sends `age`/`dob`/`gender` as top-level fields (`compat/useText.ts:359-361`). |
| c | **`vox-node` v1-compat sends demographics.** `PreSummaryRequest.dob` (`src/types/summarization.ts:139`), `.age` (`:136`), `.gender` (`:141`), plus an untyped `patient_info?: Record<string, unknown>` (`:101-102`). |
| d | **`patientId` is emitted to third-party telemetry.** Redacted from logs (`core/logger/redactor.ts:39,52,56,59,60`) but exported as a Loki label (`core/logger/transports/loki.transport.ts:195`), an OTel attribute (`otel.transport.ts:289-290`) and a Highlight attribute (`highlight.transport.ts:238`). An external patient identifier crossing into a third-party observability vendor is a BAA question, not just a code question. |

(b) and (c) sit on the frozen v1-compat surface that owner decision **704** deliberately preserves,
so they are a **posture question for the owner**, not a bug to silently fix. (a) and (d) are not
protected by 704 and are actionable now.

---

## 8. Prioritized gap register

| ID | Sev | Gap | Evidence | Proposed ticket |
|---|---|---|---|---|
| **G1** | **P0** | **API-key authorization fails open.** No-scope routes skip both the scope check and CASL; the whole STT/TTS surface declares no scopes. | §6.1 | **TASK-742 — Close the API-key fail-open.** Invert `enforceApiKeyScopes` to **deny** when a route declares no scopes; widen `api-key-scope-audit.ts` from its 18-route list to *every* non-`@Public`, non-`@ForbidApiKey` route; add `@RequiredScopes` to all STT/TTS controllers using the existing `stt:*`/`media:*` scopes. Add a privilege ceiling to key minting (§6.4). **Blocks G2.** |
| **G2** | **P0** | **The workflow exposure plane — the brief's central "expose as APIs" requirement — is complete but 404-gated off**, contradicting D-A ("ship it half-enabled and decide later is no longer acceptable"). The kill-switch also does not cover status/cancel/stream, and the sandbox path is a second invoker it never covered. | §6.2, §6.3; `workflow-exposure.service.ts:199-205`; `config.service.ts:125` | **TASK-743 — Enable the exposure plane for day-1.** Sequenced after G1: apply `assertExposureEnabled` to all five operations, bring `sandbox-runs` under an explicit gate or a real `@ForbidApiKey`, then enable. |
| **G3** | **P0** | **Webhooks cannot signal completion of anything.** Five CRUD verbs; no `WorkflowRun` ResourceType; zero sys-events from `workflow-run.service.ts`; no event-type column on `Webhook`; `callbackUrl` is dead. | §5 | **TASK-744 — Domain event vocabulary for the webhook channel.** Add terminal domain events for the three surfaces (`transcription.completed`, `summary.ready`, `consultation.signed`, `workflow.run.{completed,failed,canceled}`); add `WorkflowRun` to `ResourceType` (both `audit.prisma` + the domain enum, per rule 03 step 4); add per-event-type subscription; validate `resourceTypeName` against the enum; either wire or delete `callbackUrl`. |
| **G4** | **P1** | **`@arcaai/vox-node` covers 1 of 3 surfaces** — no STT at all, consultation is `get(id)` only, no workflow invocation. Violates D-E for every server integrator. | §2; `packages/vox-node/README.md:18`; `src/resources/consultations.ts:2-3` | **TASK-745 — vox-node surface parity.** Add STT (batch job submit/poll/stream), consultation CRUD + context items, and workflow invoke/status/stream once G2 lands. |
| **G5** | **P1** | **Department→workflow assignment and per-end-user personalization absent.** `DepartmentAgent` binds prompt templates, tool config and LLM overrides per department — but **not a workflow**; and both SDKs personalize only the *logged-in* clinician via `/user/me/*` and `my-style`, so an EMR embedding the SDK on behalf of many end users has no path short of impersonation. | §C14; `docs/implementation/TASK-733-.../README.md` (**Pending**); `core/constants.ts:191-192,205` | **TASK-733** (exists, Pending) — confirm scope covers the SDK half, not just the backend assignment. |
| **G6** | **P1** | **Patient-identity leaks**: unbounded `metadata` JSON bag (already carrying `patientName` from the compat SDK), and `patientId` exported to Loki/OTel/Highlight. | §7 (a), (d) | **TASK-746 — Patient-identity containment.** Schema-validate or redact `Consultation.metadata`; drop `patientId` from third-party telemetry exports or hash it. Raise (b)/(c) as an owner posture question under decision 704. |
| **G7** | **P1** | **Palette and exposure features are not sellable.** No `featurePaletteSummarization` / `featurePaletteConsultation` / `featureWorkflowExposure` columns; `quotaAgenticLoopSessionsPerDay` (owner decision §3b#5, STARTER 5/day) does not exist. Exposure is gated by a **process-wide env boolean**, contradicting D-B. | §C8, §C10; `entitlement.prisma:114-143`; `config.service.ts:125-126` | **TASK-747 — Entitlement completion for the workflow platform.** Add the three feature columns + the STARTER daily quota; move exposure gating from env to a tenant→SYSTEM entitlement. |
| **G8** | **P2** | **Consultation — the "main / core business" — has no WebSocket and no orchestration nodes.** Only 3 consultation palette nodes exist (`consentGate`, `phiHop`, `hitlGate` — `packages/workflow-contract/src/node-registry.ts:298,310,325`); no agent-orchestrator, sub-agent, or tool-calling node type, which is the brief's literal definition of the surface. | §2; TASK-731 status **Partial** | **TASK-731** (exists, Partial) — confirm the orchestrator/sub-agent/tool-calling node types are in scope. |
| **G9** | **P2** | **Three of the twelve super-admin areas are thin or missing**: no plan creation, alerting is read-only, DR/backup has no surface. | §4 | **TASK-748 — Close the §2 super-admin gaps.** Decide whether plans become a table; add alert-rule CRUD; add a DR/backup surface or record an explicit owner deferral. |
| **G10** | **P2** | **No message-queue / event-bus interface**, which brief §3 requires of *every* service including `api`. What exists is in-process `EventEmitter2` + internal BullMQ. | §C6 | **TASK-749 — MQ interface decision.** Either build a real bus/AsyncAPI surface or amend the brief. Likely amendment: internal BullMQ + a proper webhook vocabulary (G3) may already serve the actual requirement. |
| **G11** | **P3** | **Brief says CQRS; code is layered DDD.** | §3 | **TASK-741 — Reconcile the brief's architecture statement.** Recommendation: amend the brief, do not adopt CQRS. |
| **G12** | **P3** | Minor divergences: entitlements kill-switch owned by the "Global" **customer** tenant (`entitlements.constants.ts:23`); consent has no revoke route; stale descriptor comment claiming the node registry holds only `noop`/`passthrough` (`feature-flags.descriptors.ts:85` — it now holds 18 entries); stale `resolve-entitlements.ts:136-137,172` comments claiming `featurePaletteStt` has "no DB column yet" (it does — `entitlement.prisma:135`). | §C9, §4 item 9 | Fold into the owning tickets. |

---

## 9. What is genuinely strong (so it is not lost in the gap list)

- **Tenancy posture.** 404-over-403 is applied consistently, `tenantId` never appears as a route
  parameter on the exposure plane (`workflows.controller.ts:30-32`), CLS-resolved throughout, and
  Prisma-extension-enforced.
- **Streaming auth.** Single-use 30 s stream tickets with per-namespace scoping
  (`auth/stream-ticket.service.ts:25,82-89`), so a JWT never appears in an SSE/WS URL; the STT gateway
  fails closed with per-cause close codes.
- **Boot-time architectural audits** that refuse to start the process — deny-by-default routes,
  `/internal/*` service-token coverage, JWT placeholder detection, consent route coverage.
- **Webhook delivery mechanics** (signing, backoff, dual idempotency, reference-not-content payloads).
- **The settings-registry descriptor architecture** — descriptor-driven, tiered, `failMode`-declared
  configuration is exactly the shape D-B asks for; the gaps are keys that have not moved into it yet.
- **Entitlement enforcement breadth** — 20+ real call sites across quantity, meter and concurrency
  quotas, not a stub.
