# API Gateway B07c — Releases, Comms & Webhooks

Companion explainer for `api-gateway-b07c-release-comms-webhooks.html`.

## Scope
`B07c` completes `B07-guardrails-ops`: `service-release` (5/2), `changelog` (7/2), `notification` (4/1), `webhook` (7/1) — **23 routes / 6 controllers**. Repo @ `8cb2e5e8e6bbddf5ee7c676782ebb5ad683c23a0`.

## Endpoint groups

| Group | Modules/routes | Controllers | Services | Downstream |
|---|---|---|---|---|
| Releases & changelog | `/admin/service-releases`, `/internal/service-releases` (internal), `/changelog`, `/admin/changelog` | `ServiceReleaseAdminController` (`service-release-admin.controller.ts:26`), `ServiceReleaseInternalController` (`service-release-internal.controller.ts:21`, internal metadata/guards), `ChangelogController` (`changelog.controller.ts:23`), `ChangelogAdminController` (`changelog-admin.controller.ts:23`) | `ServiceReleaseService` (`serviceRelease.service.ts:51`), `ChangelogService` (`changelog.service.ts:62`) | Release/changelog data store |
| Notifications admin | `/admin/notifications` (4) | `NotificationController` (`notification.controller.ts:27`) | `NotificationService` (`notification.service.ts:42`) | Notification state; delivery channels (impl-specific) |
| Webhooks admin | `/admin/webhooks` (7) | `WebhookController` (`webhook.controller.ts:42`) | `WebhookService` (`webhook.service.ts:80`) | Webhook config; external endpoint dispatch |

## Example input/output (representative)
- **Service release admin/internal:** create/update/list release records or internal ingestion payloads -> release records/status. Verify internal auth/signing and tenant lock behavior.
- **Changelog:** public list/read -> entries; admin create/update/publish -> managed changelog records.
- **Notification admin:** create/send/list/manage requests -> notification records/results (delivery channel behavior implementation-specific).
- **Webhook admin:** subscription CRUD/test/delivery management -> webhook config/delivery records; outbound dispatch targets external endpoints. Verify signing, retries, and secret handling.

## Validation / limitations
- Archify finalize **pass** (`validate/deliver/check/browser-check`). Browser evidence pass; visual review not requested.
- Advisory route readability: 3 crossings / 3 detours (gates pass). Position-only repair optional if visual quality is a priority.
- **Internal:** `ServiceReleaseInternalController` uses `@Public`/`@ApiExcludeController` with tenant-lock related guards (verify full guard/auth details).
- Limitations: grouped endpoint nodes (23 routes/6 controllers); notification/webhook delivery runtime and secret/signature handling are implementation-specific — reconcile with OpenAPI/implementation.
