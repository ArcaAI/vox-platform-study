# Webhook Service — `Webhook` CRUD + outbound delivery

Application-layer service for the `Webhook` model — outbound HTTP callbacks that fire on `SysEvent`
types subscribed per row. Public surface: `apps/api/src/modules/webhook/webhook.controller.ts`
(`@Controller('admin/webhooks')`).

## Layout

| Path | What it holds |
|---|---|
| `webhook.service.ts` | `WebhookService extends BaseService` — CRUD over `Webhook` |
| `IWebhookService.ts` | Interface + `Symbol` token |
| `webhook.dto.mapper.ts` | Entity to Response DTO mapping |
| `webhook-delivery.processor.ts` | `@Processor(JobQueue.SysEvent)` BullMQ consumer — matches subscribed events, signs, POSTs, and records the delivery in `WebhookRunHistory` |
| `dto/` | Request/response DTOs, including `UpdateWebhookRequest` |
| `__tests__/` | Vitest unit tests |

## How it works

### CRUD vs delivery

This service owns CRUD of the webhook registration only. Actual HTTP delivery — matching an
incoming `SysEvent` against subscribed `Webhook` rows, HMAC-signing the payload, POSTing it, and
recording the attempt — happens in `webhook-delivery.processor.ts`'s BullMQ consumer, not in
`webhook.service.ts`. Read that file's header for the match/sign/POST/record contract before
changing delivery behavior.

### Concurrency model

Writes go through `updateWithVersion(id, entity, expectedVersion)` on the repository, issuing a
Postgres CAS (`prisma.webhook.updateMany({ where: { id, version: expectedVersion }, ... })`). HTTP
clients send `If-Match: "<n>"` on PATCH; missing `If-Match` is 428, a drifted version is 412 with
`{ currentVersion }`. Service-to-service callers pass `expectedVersion` in `UpdateWebhookRequest`
instead and should re-fetch and retry with backoff — never auto-retry a human-initiated write.

## Gotchas

- `services/notification/` is an UNRELATED plain CRUD service over the `Notification` model — it
  has no queue processor and no reference to `Webhook` anywhere in its file. Do not confuse it with
  the delivery path above.
- Single-row writes only — there is no bulk PATCH for webhooks.
- `WebhookRunHistory` is append-only and is not version-guarded — it is write-once.
- Soft-delete bumps `_version` automatically; a write that races a soft-delete gets a 412 (correct
  — it prevents resurrecting a disabled webhook).

## Related

- [`@arcaai/applications` README](../../../README.md) — `BaseService`, sys-event fan-out
- [`05-nestjs-api.md`](../../../../../.claude/rules/05-nestjs-api.md) — ETag/If-Match OCC pattern
