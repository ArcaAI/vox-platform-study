# API Gateway B03b — Consultation Supporting

Companion explainer for `api-gateway-b03b-consultation-supporting.html`.

## Scope
`B03b` completes `B03-consultation-core`: `consultation-history` (7 routes, 2 controllers), `consultation-context-schema` (9, 1), `consent` (3, 1), `document-template` (8, 1), `dna-writing-style` (31, 4) — 58 routes / 9 controllers (inventory). Repo @ `8cb2e5e8e6bbddf5ee7c676782ebb5ad683c23a0`.

## Endpoint groups

| Group | Modules/routes | Controllers | Services | Downstream |
|---|---|---|---|---|
| Consultation history | user/admin consultation history | `ConsultationHistoryController` (`consultation-history.controller.ts:27`), `AdminConsultationHistoryController` (`:34`) | `ConsultationHistoryService` (`consultation/history/consultation-history.service.ts:168`) | Consultation support data store |
| Context schema | admin context schemas + `/tenants/me/context-schema` | `ConsultationContextSchemaAdminController` (`consultation-context-schema.controller.ts:39`), `MyTenantContextSchemaController` (`:213`) | `ConsultationContextSchemaService` (`consultation-context-schema.service.ts:71`) | Schema/config data store |
| Consent grants | `/admin/consent-grants` | `ConsentGrantController` (`consent.controller.ts:30,54`) | `ConsentGrantService` (`consent-grant.service.ts:63`), `ConsultationConsentService` (`consultation-consent.service.ts:33`) | Consent grant data store |
| Document template | admin templates + `/tenants/me/document-template` | `DocumentTemplateAdminController` (`document-template.controller.ts:41`), `MyTenantDocumentTemplateController` (`:194`) | `DocumentTemplateService` (`document-template.service.ts:71`) | Template/config data store |
| DNA writing style | style CRUD, ingest/jobs, admin, memory-admin (31 routes, 4 controllers) | `DnaWritingStyleController` (`dna-writing-style.controller.ts:53`), `DnaWritingStyleIngestController` (`dna-writing-style-ingest.controller.ts:43`), `DnaWritingStyleAdminController` (`:33`), `DnaWritingStyleMemoryAdminController` (`:27`) | `DnaWritingStyleService` (`dna-writing-style.service.ts:150`), `DnaMemoryCaptureService` (`dna-memory-capture.service.ts:19`), `DnaMemoryAdminService` (`dna-memory-admin.service.ts:47`) | DNA style state; ingest/AI runtime dependencies |

## Example input/output (representative)
- **Context schema/template:** admin/tenant create/update DTOs -> schema/template records; tenant-self endpoints return tenant-scoped/effective config.
- **Consent grants:** admin CRUD/management requests -> consent grant records (policy/PHI-sensitive; verify access controls/redaction).
- **Consultation history:** query/pagination params -> history records/aggregations.
- **DNA ingest:** `POST /dna-writing-styles/ingest` -> ingest job/result metadata; `GET jobs/:jobId` -> job status/result. Verify exact DTOs, async processing, and AI/runtime dependencies.

## Validation / limitations
- Archify finalize **pass** (`validate/deliver/check/browser-check`). Browser evidence pass; visual review not requested.
- Limitations: grouped endpoint nodes across 5 modules/9 controllers; reconcile exact route/DTO contracts with inventory/OpenAPI; consent and DNA memory surfaces are policy/PHI-sensitive — verify access/redaction semantics; DNA ingest may involve async jobs/AI extraction runtime.
