# Consultation ↔ Harness relationship (ALaaS 3.0 → vox-node → Consultation API → Harness)

**Date (checked):** 2026-11-13 (workspace state)  
**Output location:** `/Users/apple/repos/VOX/vox-platform-study/code_review/api_explore_3/harness/`  
**Scope:** How the harness service relates to consultation APIs in the workflow **ALaaS 3.0 client → `@arcaai/vox-node` (project-hope) → Consultation API (project-hope `apps/api`)**, and which harness-related APIs are called by which components.

> **Important terminology:** In project-hope, "harness APIs" can mean two different surfaces:
> 1. **Harness app HTTP/admin/health endpoints** in `project-hope/apps/harness` (Python/FastAPI, port 8866 by default) — used for health/admin/ingest ops and workflow start/signaling in the harness service.
> 2. **Gateway internal harness callback endpoints** in `project-hope/apps/api` under `/api/v1/internal/harness/*` (`HarnessInternalController`) — **called by the harness worker/activities** (service-to-service, `X-Service-Token`) while executing consultation/documentation workflows.
>
> The consultation workflow primarily relates to the harness via **Temporal workflow execution** and **gateway `/internal/harness/*` callbacks** (not by ALaaS calling harness HTTP endpoints directly).

---

## 1) Repositories and branches inspected

| Repo | Path | Current branch | Latest changed remote branch (by committer date, fetched) | Notes |
|---|---|---|---|---|
| ALaaSv3.0 | `/Users/apple/repos/VOX/ALaaSv3.0` | `refactor-hope-integaration` | `origin/test-deployment` (2026-11-12, `feat: add gast department code mapping for gastroenterology`) | `git fetch --all --prune` run; latest remote refs also include `origin/design/web-ui-shadcn-redesign`, `origin/demo-branch`. |
| project-hope | `/Users/apple/repos/VOX/project-hope` | *(not recorded in this check; inspected working tree)* | *(not checked)* | Primary evidence for consultation/harness integration. |
| Study/docs output area | `/Users/apple/repos/VOX/vox-platform-study/code_review/api_explore_3` | n/a | n/a | Existing consultation explorer/docs: `api-gateway-explorer.html`, `cross-cutting/consultations/*`, `inventory/*`. |

**ALaaS evidence (integration shape):** `ALaaSv3.0/docs/hope-integration/00-overview.md` describes `audio-stream-svc` using `@arcaai/vox-node` to talk to HOPE consultation/STT/streaming APIs (realtime plane). ALaaS does not directly call project-hope harness internal endpoints.

---

## 2) End-to-end flow (high level): ALaaS 3.0 client → vox-node → Consultation API

### 2.1 ALaaS 3.0 client side (observed architecture)
- `ALaaSv3.0` realtime consultation integration is mediated by `audio-stream-svc` (`ws /ws/consultation`) using `@arcaai/vox-node` (`HopeRealtimeVoxNodeAdapter` / consultation ports) to call HOPE APIs.
- Typical operations (per `docs/hope-integration/00-overview.md`): `consultations.open`, STT stream session creation/socket, recording/lifecycle start-stop, live summary/event stream subscription, note/finalization flows as exposed by HOPE/SDK.
- **Harness is not a direct ALaaS dependency/call target**; ALaaS interacts with **consultation-facing HOPE APIs** surfaced through `vox-node`.

### 2.2 vox-node (project-hope SDK)
- `project-hope/packages/vox-node` (and `packages/vox-node-codegen`) provides the typed client SDK used by ALaaS (`@arcaai/vox-node`) to call HOPE gateway endpoints (consultations, audio/STT, streams, etc.).
- `project-hope/docs/architecture/vox-node-gateway-gaps.md` exists, indicating gateway/SDK parity is tracked in project-hope.

### 2.3 Consultation API (project-hope `apps/api`)
- Consultation HTTP controllers live under `project-hope/apps/api/src/modules/consultation/` (e.g. `consultation.controller.ts`, lifecycle/events/internal controllers).
- Consultation APIs own authZ/ownership checks, tenancy/CLS context, persistence/system-of-record behavior, and orchestration entrypoints (including note-generation/harness-triggering paths).

---

## 3) Where Harness fits in project-hope

### 3.1 Harness service (`apps/harness`, Python/FastAPI + Temporal)
- **Path:** `project-hope/apps/harness/`
- **Role (from `apps/harness/README.md`):** Temporal durable workflow service (`HarnessDocWorkflow`, plus interpreter) for clinical documentation loops (`policy -> guides/retrieve -> generate -> sensors -> gate`, etc.).
- **System boundary:** `apps/api` remains gateway/system-of-record (authZ, tenant/CLS, Postgres, WORM audit, consent, sign-off). Harness performs workflow orchestration and non-deterministic tool I/O in Temporal activities; workflow bodies stay deterministic.
- **Config/port:** FastAPI on port **8866** by default (`HARNESS_URL`/`HARNESS_PORT` references exist in API config/health/tests). Harness worker runs separately (`pnpm worker:dev` / Temporal worker entrypoint).
- **Callback channel to API:** Harness calls API internal endpoints using service token (`X-Service-Token`) to `HARNESS_API_INTERNAL_PREFIX` (default `/api/v1/internal/harness`).

### 3.2 Gateway internal harness endpoints (`apps/api`)
- **Controller:** `apps/api/src/modules/consultation/harness-internal.controller.ts`
- **Base path:** `@Controller('internal/harness')` (mounted under global API prefix, effectively `/api/v1/internal/harness/*`)
- **Auth:** `HarnessServiceTokenGuard` (`/api/v1/internal/harness/*` requires `X-Service-Token`; accepts `INTERNAL_ACCESS_TOKEN` or legacy `HARNESS_SERVICE_TOKEN`, fail-closed if not configured)
- **Purpose:** inbound service-to-service adapter for harness worker activities/workflows to read policy/config, resolve resources, persist/read workflow artifacts, report trajectory/progress, dispatch STT batch jobs, etc., while API remains the DB/system-of-record writer.

### 3.3 Consultation APIs triggering harness-backed work (example observed)
- `consultation.controller.ts` (`generateSummaryAsync` / `startHarnessSummaryJob`) now routes summary generation through the **note-generation seam** (`noteGenerationService.generate(...)`) instead of legacy BullMQ summary processing.
- On success when `decision.generator === 'harness'`, controller registers the harness job (`consultationJobService.registerHarnessNoteJob(...)`) so job status/cancel/stream endpoints can resolve it.
- If seam resolves to non-harness/legacy, controller fails visibly (`ServiceUnavailableException`) rather than silently falling back (legacy signable generator path removed in that flow, per code comments).

> This means **consultation API endpoints can trigger harness workflow execution indirectly** (via application services/seam/Temporal dispatch) and later **harness activities call back into `/internal/harness/*`** during execution.

---

## 4) Harness ↔ Consultation API call relationships (which calls which)

### 4.1 Direction A — Harness worker/activities → Gateway internal harness APIs (`/api/v1/internal/harness/*`)

**Caller:** `project-hope/apps/harness` (Temporal activities/services, e.g. `services/api_client.py`)  
**Callee:** `project-hope/apps/api` `HarnessInternalController` (`/api/v1/internal/harness/*`)  
**Auth:** `X-Service-Token` (`HarnessServiceTokenGuard`) + tenant-scoped request context (`tenantId` in query/body/headers as applicable)

| Harness caller (component/activity intent) | HTTP call to API | API handler (HarnessInternalController) | Purpose in consultation/harness workflow |
|---|---|---|---|
| `fetch_policy` / policy resolution | `GET /internal/harness/policy` | `GET policy` | Effective harness policy for tenant/consultation/task; optional text fallback chain resolution context |
| Prompt template resolution | `GET /internal/harness/prompt-templates/:id/resolved` | `GET prompt-templates/:id/resolved` | Resolve approved prompt template content/version for worker (harness has no DB handle) |
| Model/routing resolution | `GET /internal/harness/models/resolve` | `GET models/resolve` | Resolve registry model by slug or task-key elected model for worker activity |
| MCP token fetch | `GET /internal/harness/mcp-token` | `GET mcp-token` | Obtain MCP token/credential material via gateway-controlled path |
| Provider credential fetch | `GET /internal/harness/provider-credential` | `GET provider-credential` | Fetch provider credential for worker activity (BYO/provider extras flows) |
| Entity extraction/persistence flow | `POST /internal/harness/consultations/:id/entities` | `POST consultations/:id/entities` | Persist extracted entities for consultation |
| Entity readback (priors/reuse) | `GET /internal/harness/consultations/:id/entities` | `GET consultations/:id/entities` | Read persisted/coded entities (e.g. NER priors reuse) |
| Prompt assembly | `POST /internal/harness/consultations/:id/assemble` | `POST consultations/:id/assemble` | Assemble prompt/context for generation (gateway/system-of-record logic) |
| Draft persistence | `POST /internal/harness/consultations/:id/draft` | `POST consultations/:id/draft` | Persist generated draft/note artifact/version |
| Gate decision record | `POST /internal/harness/consultations/:id/gate-decision` | `POST consultations/:id/gate-decision` | Record clinician/harness gate outcome (WORM/audit path as applicable) |
| Escalation record | `POST /internal/harness/consultations/:id/escalation` | `POST consultations/:id/escalation` | Record SLA/escalation events |
| Assurance finalize/callbacks | `POST /internal/harness/consultations/:id/assurance` | `POST consultations/:id/assurance` | Finalize assurance phase (optimistic delivery path) |
| Assurance event feed | `POST /internal/harness/consultations/:id/assurance-event` | `POST consultations/:id/assurance-event` | Per-claim/live assurance event reporting |
| Live summary/progress/loop events | `POST /internal/harness/consultations/:id/live-summary`, `.../progress`, `.../loop-event` | corresponding POST handlers | Stream/progress/loop telemetry back to consultation-facing state |
| Live assist / live documentation controls | `POST /internal/harness/consultations/:id/live-assist`, `.../live-documentation/start`, `.../live-documentation/stop` | corresponding handlers | Coordinate live documentation/assist lifecycle from harness side |
| Live handoff/state read | `GET /internal/harness/consultations/:id/live-handoff` | `GET consultations/:id/live-handoff` | Read handoff/readiness state for live outputs |
| Endpoint/session lifecycle callbacks | `POST /internal/harness/consultations/:id/endpoint/session`, `.../endpoint/finalize`, `.../endpoint/feedback` | corresponding handlers | Endpoint/session finalize/feedback persistence from harness workflow |
| Trajectory/reporting | `POST /internal/harness/trajectory` | `POST trajectory` | Batched trajectory steps / compute samples ingestion (durable reporting, fire-and-forget semantics noted in controller) |
| Loop config read | `GET /internal/harness/loop-config` | `GET loop-config` | Worker loop/runtime configuration |
| Context extraction/text read | `GET /internal/harness/consultations/:id/context-items/:contextItemId/extracted-text` | `GET consultations/:id/context-items/:contextItemId/extracted-text` | Retrieve extracted text for context item (OCR/text pipeline result reuse) |
| STT batch dispatch (from harness speech-to-text node) | `POST /internal/harness/stt/batch-jobs` | `POST stt/batch-jobs` | Dispatch batch transcription via existing transcription job services (reuses API job path; resolves ASR agent/spec) |
| STT batch poll | `GET /internal/harness/stt/batch-jobs/:id` | `GET stt/batch-jobs/:id` | Poll terminal/non-terminal job status for Temporal activity (not SSE) |

**Related internal read (separate controller):** `GET /api/v1/internal/consultations/:consultationId/note-plans/:planId` (`apps/api/.../consultation/harness-internal.controller.ts` defines `InternalConsultationController` as well) is used by harness to fetch note plans / preserved sections.

> **Evidence pointers:** `apps/harness/src/harness/services/api_client.py` (client for `/internal/harness/*` callbacks), `apps/harness/src/harness/temporal/activities.py` and interpreter nodes/tests referencing these routes, `apps/api/src/modules/consultation/harness-internal.controller.ts` route handlers and docs.

### 4.2 Direction B — Consultation/public APIs and services → Harness execution (indirect trigger)

**Caller:** Consultation API/controllers and application services in `apps/api` / `packages/applications` (and ultimately ALaaS clients via vox-node calling consultation APIs)  
**Callee:** Harness workflow runtime (Temporal `apps/harness` worker/workflows), typically via seam/service dispatch rather than direct browser/client HTTP calls to harness

| Triggering API/component | Observed mechanism | Harness involvement | Notes |
|---|---|---|---|
| `POST /api/v1/consultations/:id/summary/async` (`ConsultationController.generateSummaryAsync`) | Calls `startHarnessSummaryJob` → `noteGenerationService.generate(GenerationTrigger.SUMMARY_REGENERATE, ...)`; if generator is `harness`, registers job via `consultationJobService.registerHarnessNoteJob(decision.harnessJobId, ...)` | Triggers harness-backed note generation job/workflow path (seam-selected) | No legacy BullMQ summary path in this controller route; non-harness resolution fails visibly in current implementation |
| Consultation lifecycle/start/recording/streaming APIs (`/consultations/open`, `/consultations/:id/start`, events/streams, STT session flows) | Client (ALaaS via vox-node) calls consultation & streaming APIs; live documentation/harness-related internals may participate depending on feature/config | Harness may be engaged by downstream workflow/orchestration (e.g. documentation loop services, live-doc callbacks) rather than direct HTTP call from client to harness | Direct invocation points for all lifecycle-triggered harness workflows require deeper service tracing (`LiveDocumentationService`, `NoteGenerationService`, Temporal client wiring) beyond this static pass |

**Key point for the asked workflow:** In **ALaaS 3.0 client → vox-node → consultation API**, the client-visible APIs are consultation/STT/stream APIs. Harness relationship is mostly **behind consultation APIs**: consultation-side services may start/signal harness workflows, and the running harness workflow calls back to **gateway `/internal/harness/*`** APIs.

### 4.3 Direction C — Harness app HTTP endpoints called by API/ops (supporting, not the primary consultation callback path)

- `apps/api`/health/config references `HARNESS_URL` for service health/admin visibility (`AdminHealthServicesController`, env schema/tests).
- `apps/harness` FastAPI app also exposes its own routes (e.g. health, internal/admin/knowledge endpoints in `apps/harness/src/harness/api/endpoints/*` per README). These are harness-service endpoints (not the same as API's `/internal/harness/*` callbacks).
- A full route inventory of `apps/harness` FastAPI endpoints and their callers (API vs ops tools vs scripts) was **not exhaustively enumerated** in this pass.

---

## 5) How to interpret "which APIs of harness are called by which APIs" (for consultation)

**Most relevant mapping (consultation workflow execution):**
- **Harness worker/activities call gateway internal harness APIs**: `apps/harness` → `apps/api /api/v1/internal/harness/*` (and `/api/v1/internal/consultations/:consultationId/note-plans/:planId`) during documentation/assistance workflows.
- **Consultation APIs (invoked by ALaaS via vox-node) trigger harness-backed processing indirectly**: e.g. summary async endpoint routes through note-generation seam to harness job/workflow; harness then performs callbacks to the internal harness APIs above.

**What was not observed:**
- ALaaS client or `vox-node` directly calling `apps/harness` HTTP endpoints.
- `apps/api` consultation controllers directly calling `apps/harness` FastAPI routes for core consultation data mutations (the main pattern is Temporal workflow + harness-to-API callbacks).

---

## 6) Evidence files (primary)

- `ALaaSv3.0/docs/hope-integration/00-overview.md` — ALaaS `audio-stream-svc` ↔ HOPE via `@arcaai/vox-node`
- `project-hope/apps/harness/README.md` — harness role, architecture, Temporal loop, worker/app split
- `project-hope/apps/harness/src/harness/services/api_client.py` — harness callback client to API internal harness endpoints
- `project-hope/apps/api/src/modules/consultation/harness-internal.controller.ts` — gateway `/internal/harness/*` callback API surface and DTOs
- `project-hope/apps/api/src/modules/consultation/harness-service-token.guard.ts` — service token auth for internal harness endpoints
- `project-hope/apps/api/src/modules/consultation/consultation.controller.ts` (around summary async / `startHarnessSummaryJob`) — consultation API trigger into harness-backed note generation seam
- `project-hope/apps/api/src/modules/consultation/consent-internal.controller.ts` — internal consent check callable from harness Temporal activities (supporting integration)

---

## 7) Gaps / follow-up checks (if deeper trace needed)

1. **Exact Temporal workflow start/signal path:** trace `NoteGenerationService.generate(...)`, harness/Temporal client wiring, and workflow IDs/signals for consultation summary/live-doc triggers.
2. **Harness app FastAPI route inventory:** enumerate `apps/harness/src/harness/api/endpoints/*.py` and map any callers from `apps/api`, scripts, or ops.
3. **ALaaS branch-specific behavior:** compare `refactor-hope-integaration` vs `origin/test-deployment` for consultation/harness-related client changes (if needed for deployment parity).
4. **`consultation-lifecycle-flow` diagram/content mismatch:** existing diagram artifacts in `review/api_explore/diagrams/sequence/` were previously found mismatched (list flow content under lifecycle name); update diagrams only if requested.
