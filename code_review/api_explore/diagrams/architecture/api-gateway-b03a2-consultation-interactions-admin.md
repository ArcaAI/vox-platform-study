# API Gateway B03a2 — Consultation Interactions & Admin

Companion explainer for `api-gateway-b03a2-consultation-interactions-admin.html`.

## Scope
`B03a2` (part of B03-consultation-core split): `consultation-attachment`, `consultation-feedback`, `admin-consultation`, `admin-feedback-rollup`, `consultation-telemetry`. Repo @ `8cb2e5e8e6bbddf5ee7c676782ebb5ad683c23a0`.

## Endpoint groups

| Group | Key routes | Controllers | Services | Downstream |
|---|---|---|---|---|
| Attachments | `POST :id/attachments`, `POST :attachmentId/complete`, `POST :attachmentId/content`, `GET list/get` | `ConsultationAttachmentController` (`consultation-attachment.controller.ts:46,55+`) | `ConsultationAttachmentService` (`attachment.service.ts:152`) | Attachment metadata store; blob/object storage for content |
| Feedback & rollups | `GET feedback/reason-codes`, `POST/GET :id/feedback`, `GET /admin/feedback/rollups` | `ConsultationFeedbackController` (`consultation-feedback.controller.ts:59`), `AdminFeedbackRollupController` (`admin-feedback-rollup.controller.ts:56`) | `ConsultationFeedbackService` (`feedback.service.ts:78`), `FeedbackRollupService` (`feedback-rollup.service.ts:52`) | Feedback/rollup data store |
| Admin consultation & telemetry | `/admin/consultations` list/aggregate/`:id` (handlers verified; `@ApiEndpoint` patterns), `GET /admin/consultations/:id/telemetry` | `AdminConsultationController` (`admin-consultation.controller.ts:40,116,136`), `ConsultationTelemetryController` (`consultation-telemetry.controller.ts:39,47`) | `ConsultationService` (admin reads), `ConsultationTelemetryService` (`telemetry.service.ts:79`) | Consultation/telemetry data store |

## Example input/output (representative)
- **Attachments:** create/complete/content requests -> attachment records/content upload results (verify multipart/content handling).
- **Feedback:** `POST /consultations/:id/feedback` -> feedback record; admin rollups return aggregated metrics.
- **Admin aggregate:** `GET /admin/consultations/aggregate?from&to[&granularity]` -> zero-filled new/revisit aggregation (scope follows tenant/SUPER_ADMIN context per controller docs).
- **Telemetry:** `GET /admin/consultations/:id/telemetry` -> telemetry payload.

## Validation / limitations
- Archify finalize **pass** (`validate/deliver/check/browser-check`). Browser evidence pass; visual review not requested.
- Advisory route readability: 1 detour (`svc_attach→data_store`, 3 bends). Gates pass.
- Limitations: grouped endpoint nodes; `AdminConsultationController` uses `@ApiEndpoint`/custom patterns (handler methods verified) — reconcile route list with OpenAPI/inventory; attachment storage backend is config-driven; admin cross-tenant scope is implementation-specific.
