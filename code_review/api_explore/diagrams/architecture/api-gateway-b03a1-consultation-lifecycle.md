# API Gateway B03a1 — Consultation Lifecycle

Companion explainer for `api-gateway-b03a1-consultation-lifecycle.html`.

## Scope
`B03a1` (part of B03-consultation-core): `consultation.controller.ts`, `consultation-lifecycle-events.controller.ts`, `consultation-job.controller.ts`. Represents core consultation lifecycle/workflow, SSE streams, and async job surfaces (consultation module 108 routes/11 controllers total; split into B03a1/B03a2/B03a3 + B03b). Repo @ `8cb2e5e8e6bbddf5ee7c676782ebb5ad683c23a0`.

## Endpoint groups

| Group | Key routes | Controllers | Services | Downstream |
|---|---|---|---|---|
| Consultation lifecycle | `GET workflows`, `GET :id/workflow`, `POST :id/start|pause|stop|approve`, `GET :id/encounters`, `GET :id/recording` (+ many context/summary/highlight/entity/timeline routes in same controller) | `ConsultationController` (`consultation.controller.ts:308`) | `ConsultationService` (`consultation.service.ts:218`), `ConsultationLifecycleService` (`lifecycle.service.ts:75`), note/harness/live-doc services injected | Postgres/Prisma, Redis pubsub/subscriber (SSE relays), workflow/AI/harness runtime |
| Stream/SSE | `GET :id/live-summary/stream` (`@Sse`), `GET :id/live-assist/stream` (`@Sse`), `GET :id/events` (`@Sse`) | `ConsultationController` (live streams), `ConsultationLifecycleEventsController` (`consultation-lifecycle-events.controller.ts:18,24`) | Consultation/lifecycle/live-doc/harness services, Redis subscriber | Redis/pubsub + consultation state |
| Jobs | `GET /consultations/jobs/:jobId`, `PATCH :jobId/cancel`, `GET :jobId/stream` (`@Sse`) | `ConsultationJobController` (`consultation-job.controller.ts:29,37,58,83`) | `ConsultationJobService` (`jobs/consultation-job.service.ts:79`) | Job metadata/state store; async workers/runtime |

## Example input/output (representative)
- **Lifecycle:** `POST /consultations/:id/start|pause|stop|approve` -> lifecycle/encounter state response (lifecycle vocabulary may depend on `X-Hope-Lifecycle`/interceptor behavior).
- **SSE streams:** `GET :id/live-summary/stream`, `:id/live-assist/stream`, `:id/events` -> SSE event frames (clinical/PHI-safe content and event schemas are implementation-specific).
- **Jobs:** `GET/PATCH /consultations/jobs/:jobId` -> job status/cancel result; `GET :jobId/stream` (SSE) -> progress/result events.

## Validation / limitations
- Archify finalize **pass** (`validate/deliver/check/browser-check`). Browser evidence pass; visual review not requested.
- Advisory route readability: 1 crossing (`svc_job→data_consult` vs `svc_consult→ext_runtime`) and 1 detour (`svc_consult→ext_runtime`, 3 bends). Gates pass.
- Limitations: grouped endpoint nodes (not 1:1 for all `ConsultationController` routes); route decorator grep undercounts base/custom patterns — reconcile with `inventory/modules.json`/OpenAPI for strict coverage; SSE payload schemas, internal auth, and async worker topology are implementation-specific.
