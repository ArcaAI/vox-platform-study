# TASK-727 — Webhook Exposure Channel

| | |
|---|---|
| **Status** | Review — Tasks 1–6 and 8 implemented, unit-tested, and build-verified with real command output (§7); close-out pass (2026-08-17) re-proved the migration diff against the new squashed baseline. Task 7's e2e spec is authored and Playwright-listable but NOT executed — `pnpm test:e2e`'s `globalSetup` runs `prisma db push --force-reset`, which Prisma's CLI refuses when invoked by an AI agent in this environment; this is a pre-existing environment constraint, not a gap in this ticket's code. A design correction to §2.7's storage-mechanism reading is recorded in §7 — read it before touching `WebhookService`'s secret handling. |
| **Wave** | 3 · **Size** | M |
| **Epic slug** | `webhook-channel` |
| **Depends on** | TASK-717 (`async-contract` — design-only per D7 as of this writing; §2.9/§6 name exactly what this ticket needs from it and the fallback if it lands late), TASK-722 (`exposure-v1` — not yet landed as of this writing; this ticket reuses the exposure plane's channel-binding concept but does not require its code) |
| **Design refs** | Exposure plane (§"Published workflow versions bind to channels: … webhook triggers"), D7 (async transport — "Contract over broker: one documented async task/event envelope over existing infra… Redis Streams, BullMQ, Temporal"), D6 (CQRS-lite — the delivery-log read model this ticket writes to is exactly the kind of read model D6 scopes in, not a broker) |
| **Findings closed** | — (net-new Wave-3 extension; not adjudicated in the consultation assessment) |

## 1. Requirement Analysis

`design.md`'s exposure plane names webhooks as one of four channels a published workflow binds to
(REST, SSE/socket, webhook, `@arcaai/vox` SDK). §2 below establishes the load-bearing fact this
ticket is built around: **the subscription side of webhooks is real and fully wired today —
`Webhook`/`WebhookRunHistory` Prisma models, a complete `WebhookService` with OCC-versioned CRUD,
and an admin controller at `/api/v1/admin/webhooks` with a delivery-log read endpoint — but the
delivery side does not exist.** Every mutation on every resource in the platform already enqueues a
generic `JobQueue.SysEvent` BullMQ job "for downstream processing (webhooks, subscriptions, etc.)"
(the comment's own words, `sysEvent.service.ts:191`), and a `SysEventType.WebHookRun` event type is
already declared in the domain enum — but nothing has ever consumed that queue, and nothing has
ever emitted `WebHookRun`. A tenant can create a `Webhook` row today, watch it sit in the admin
console, and it will never fire.

This ticket builds the missing half: a real BullMQ processor that matches fired `SysEvent`s against
tenant `Webhook` subscriptions, signs and POSTs the payload, records the attempt in
`WebhookRunHistory`, retries with backoff, and dead-letters after exhaustion — reusing the existing
model, service, and controller unchanged. It also fixes a live gap in the existing subscription
model: `Webhook.hashedSecret` is accepted verbatim from the client
(`createWebhook.request.ts:15-21`) with **no server-side hashing, peppering, or Vault-backed
storage** — the column name promises a hash but nothing computes one. This ticket makes signing real
using the platform's own peppered-HMAC pattern.

Per the assignment's payload guidance and the platform's PHI posture, this ticket makes webhook
payloads **references, not content**: ids + a fetch-back URL the receiver calls (through the
existing authenticated API, with its existing tenant scoping and 404-over-403 posture) rather than
embedding resource content in the outbound POST body. §3 justifies this against the platform's own
egress precedent.

**Out of scope:**
- Workflow lifecycle events themselves (`RunStarted`/`RunCompleted`/`RunFailed`/`RunDegraded`) as a
  concept tied to a real `WorkflowDefinition`/run model — confirmed not built (§2.8; no
  `Workflow*` `ResourceType` exists yet). This ticket adds the **event-type vocabulary and delivery
  plumbing** generically (any `SysEventType`, matched by `resourceTypeName`), so that whichever
  ticket lands the workflow-run model (TASK-715/718/723) only needs to broadcast through the
  existing `broadcastSysEvent`/`queueSysEventJob` path this ticket makes deliverable — it does not
  itself invent workflow-run events.
- `ResourceSubscription`/`NotificationService` — confirmed to be a **different**, already-existing
  in-app/user-targeted notification mechanism (`resourceSubscription.service.ts`,
  `notification.service.ts`), unrelated to tenant HTTP webhook delivery. Not touched.
- The `exposure-v1` (TASK-722) generic gateway surface (`/api/v1/workflows/:slug/...`) or its
  entitlement/scoped-API-key checks — this ticket's admin webhook CRUD surface
  (`/api/v1/admin/webhooks`) already exists independently of that work.
- A tenant-facing admin-console screen for webhook management. The full CRUD + delivery-log API
  already exists (§2.3); no admin-console `webhooks` feature module exists yet
  (`apps/admin-console/src/features/` has no `webhooks` folder), but building one is a UI-only
  follow-up, not blocking delivery, and is not sized into this ticket.

## 2. Current State Evaluation

Re-derived directly against `feat/loop`, excluding `.claude/worktrees/**`, `**/dist/**`,
`**/node_modules/**`, `**/.venv/**`, `**/__pycache__/**`.

### 2.1 Subscription model — real, OCC-versioned, unchanged by this ticket

`packages/database/src/prisma/db_main/webhook.prisma:1-38` — `Webhook`: `tenantId`, `name`, `url`,
`hashedSecret String?`, `resourceTypeName String` (the subscribed resource type, e.g.
`"Consultation"`), `resourceId String?` (specific instance vs. tenant-wide wildcard when null),
`subscriptionMetadata Json?` (free-form; today unused by any reader — see §2.5), unique on
`[tenantId, name]`. `WebhookRunHistory` (`:40-68`): `status: WebhookRunStatus`, `response Json?`,
`responeStatusCode Int?` (verbatim column name, including the typo — do not "fix" it, a rename is a
breaking migration out of this ticket's scope), FK `webhookId → Webhook.id`, no `tenantId` of its
own (tenancy flows through the parent).

### 2.2 Delivery service folder — CRUD only, by design (its own README says so)

`packages/applications/src/services/webhook/README.md:1-6` states verbatim: **"The service owns
CRUD of the webhook registration; the actual HTTP delivery lives in
`@arcaai/applications/src/services/notification/`."** This is **stale/incorrect** as written —
verified: `packages/applications/src/services/notification/notification.service.ts:41-42` is
`NotificationService extends BaseService implements INotificationService`, a plain CRUD service over
a `Notification` model with no queue processor, no HTTP client, and no reference to `Webhook`
anywhere in its file. Grepping all of `packages/applications/src` for `webhook`/`Webhook` outside
the `webhook/` folder itself surfaces exactly four non-generated hits, none of which deliver
anything: `modelFilterTypes.ts` (a type union), `typed-event-emitter.ts:86` (`[SysEventType.WebHookRun]:
SysEventPayload` — a TYPE mapping only, never constructed anywhere), `apiKey/apikey-scopes.registry.ts`
and `apiKey/apikey.service.ts` (webhook mentioned only as an example API-key scope string). **The
README's pointer to `notification/` for delivery is wrong and should be corrected as part of this
ticket's diff** (§4 Task 1) so the next reader doesn't repeat this investigation.

`webhook.service.ts` (`WebhookService extends BaseService`, `:29`) implements exactly: `create`
(`:50-69`, broadcasts `SysEventType.ResourceCreated` on the `Webhook` row itself — this is the
platform's generic CRUD audit event, **not** a delivery trigger), `fetchAll`/`fetchAllByTenantId`/
`fetchById`, `fetchRunHistory` (`:279-285` — reads `webhookRunHistoryRepository.findAll`/`count`,
**read-only**), `update` (OCC via `updateWithVersion`, per the service's own README §"Concurrency
Model"), `deleteById` (soft delete). **No method in this file sends an HTTP request, computes a
signature, or writes a `WebhookRunHistory` row.** Grep for `WebhookRunHistoryFactory` or
`webhookRunHistoryRepository.create` anywhere in the service: zero hits — confirmed nothing ever
creates a delivery-attempt row.

### 2.3 Admin controller — real, full CRUD, mounted, delivery-log read endpoint already exists

`apps/api/src/modules/webhook/webhook.controller.ts` — `WebhookController`
(`@Controller('admin/webhooks')`, `@CanManage('Webhook')`, class-level, `:26-30`): `POST` create
(`:40-43`), `GET` list tenant-scoped or cross-tenant via `?tenantId=` for `GLOBAL_ADMIN`
(`:51-56`), `GET :id` (`:63-66`), `GET :id/deliveries` (`:80-83`, `@Authorize(['read',
'WebhookRunHistory'])`, paginated, "newest-first" per its own `@ApiOperation` description),
`PATCH :id` with `@RequiresIfMatch()` + `@ExpectedVersion()` (`:104-112`, 428/412 per the OCC
contract), `DELETE :id` soft-delete (`:119-122`). This surface needs **no new endpoint** for this
ticket — `GET :id/deliveries` is already the delivery-log read the assignment asks for; this
ticket's job is only to make rows exist for it to read.

### 2.4 `JobQueue.SysEvent` — defined, universally enqueued, never consumed

`packages/domains/src/enums/JobQueue.enum.ts:3-23` declares `SysEvent = 'SysEvent'` alongside
`AuditLog`, `UserActivity`, `SendEmail`, `SendSms`, `SpeechToText`, and the consultation
AI-processing queues. `packages/applications/src/services/sysEvent/sysEvent.service.ts:191-205` —
`queueSysEventJob(jobs, event, jobType)` pushes a `SysEventJob` (`{ id: event.id, data: event }`,
shape at `packages/domains/src/interfaces/jobTypes.ts:27-30`) onto `JobQueue.SysEvent` with
`SYS_EVENT_JOB_OPTIONS` (`:42-50` — `attempts: 2, backoff: { type: 'exponential', delay: 500 },
removeOnComplete: true, removeOnFail: false` — failed jobs are deliberately kept, "for manual
inspection via Bull Board or a dead-letter queue processor" per the sibling `AUDIT_LOG_JOB_OPTIONS`
comment at `:25-30`, same intent). **This call site fires on every single mutation across the
platform** — `handleResourceCreatedEvent`/`Viewed`/`Updated`/`Deleted`/`Archived` (`:207-293`) each
call `queueSysEventJob`. Exhaustively grepped `packages/applications/src` and `apps/api/src` for
`@Processor(JobQueue.SysEvent)` and for `registerQueue`/`BullModule.registerQueue` naming
`SysEvent`: **zero hits beyond the generic `BullModule.registerQueue` loop in
`redis.service.module.ts:11`** (`queueNames.map(...)`, which registers every `JobQueue` value
uniformly — it does not imply a consumer exists). The processor exemplars that DO exist —
`auditLog.processor.ts` (`@Processor(JobQueue.AuditLog)`, `:11`), `gate-edit-mining.processor.ts`,
`dna-writing-style.processor.ts`, `directory-sync.processor.ts`, `usage-outbox.processor.ts`,
`ingest-knowledge-document.processor.ts` — are the pattern this ticket's new
`webhook-delivery.processor.ts` follows; none of them is `JobQueue.SysEvent`.

### 2.5 `SysEventType.WebHookRun` — typed, never emitted

`packages/domains/src/enums/sysEventType.enum.ts:1-10` declares `WebHookRun =
'SysEvent.WebHookRun'` alongside the generic CRUD types and `SendContactMessage`. The ONLY other
reference anywhere in `packages/applications/src` or `apps/api/src` is
`typed-event-emitter.ts:86` — `[SysEventType.WebHookRun]: SysEventPayload` — a compile-time type
map entry with no runtime `broadcastSysEvent(SysEventType.WebHookRun, …)` call site anywhere.
**Fully dormant**, consistent with §2.4.

### 2.6 The `SysEvent` shape a delivery processor consumes — already exactly right

`packages/domains/src/common/events/arcaai.event.ts:34-72` — `SysEvent`: `id`, `type:
SysEventType`, `resourceId?`, `resourceIds?`, `resourceType: ResourceType`,
`responsibleEntityId`, `data?: JsonValue | object`, `tenantId?`, `correlationId?`, `createdAt`.
This is already the complete envelope a webhook processor needs to (a) match against
`Webhook.resourceTypeName`/`resourceId` and (b) build a payload from — no new event-carrier type is
needed; this IS D7's "async task/event envelope over existing infra," already built for the CRUD
audit path and reusable verbatim for webhook delivery.

### 2.7 Signing — no real HMAC exists on the webhook path; the platform's own peppered-HMAC pattern is one file away

`createWebhook.request.ts:15-21`, `updateWebhook.request.ts:26`, `webhook.response.ts:16,40` all
declare/pass through `hashedSecret?: string` as an opaque client-supplied string — nothing in
`webhook.service.ts` or `webhook.dto.mapper.ts` calls a hash function on it. As written today, a
caller could set `hashedSecret` to anything (including plaintext) and the platform would store it
verbatim and — once delivery exists — presumably use it as an HMAC key with no guarantee it is
actually secret-strength or that the platform, not the caller, controls how it was derived.

The reusable exemplar is `packages/applications/src/services/apiKey/apikey.service.ts:151-166`:
`static hashKey(rawKey: string, pepper?: string): string { return pepper ? createHmac('sha256',
pepper).update(rawKey).digest('hex') : createHash('sha256').update(rawKey).digest('hex'); }`, with
an instance wrapper `hashKeyForStorage` (`:169-175`) that resolves the pepper from
`SecretsService.getSecretOptional('API_KEY_PEPPER')` — a `vault-kv`-tier platform secret (per
`platform-secrets.descriptors.ts:1-9`, resolved through `SecretsService.getSecret(NAME)` against
`<VAULT_KV_MOUNT>/data/<VAULT_KV_PREFIX>/<NAME>`). The per-tenant credential storage precedent
(`db-secret` tier — Vault-Transit ciphertext in a DB column) is `TenantBucket.credentialsRef`
(`packages/database/src/prisma/db_main/tenant-bucket.prisma:149`, comment `:82`: "Vault via
SecretsService"). §4 Task 2 applies this: the platform GENERATES the webhook signing secret
server-side at creation (never accepts one from the caller), returns the raw secret **once** in the
create response (mirroring how API keys are shown once), and stores only its peppered hash —
`hashedSecret` becomes what its name always claimed, computed, not passed through.

### 2.8 Workflow lifecycle events — confirmed not built (dependency risk named directly)

Grepped `packages/database/src/prisma/db_main/audit.prisma` and
`packages/domains/src/enums/generated/ResourceType.ts` for `Workflow`: zero hits. No
`WorkflowDefinition`/`WorkflowRun` Prisma model or `ResourceType` member exists yet — confirms
TASK-715 (`workflow-definition-model`) has not landed as of this writing. This ticket's delivery
plumbing is deliberately generic over `SysEventType`/`ResourceType`, so it needs no change once
715/718/723 add real workflow-run events — see §1 "Out of scope."

### 2.9 What TASK-717 (`async-contract`) would add, and the fallback if it is not yet landed

`design.md` D7 describes TASK-717's deliverable only in the abstract ("one documented async
task/event envelope… resume tokens" is an open question per `design.md`'s own §"Open questions" #3).
As of this writing `docs/implementation/TASK-717-*` does not exist. This ticket does not block on
it: `SysEvent` (§2.6) already supplies id/type/resourceType/data/tenantId/correlationId, which is
sufficient for a webhook payload envelope. If TASK-717 lands a formal resume-token/delivery-semantics
contract before this ticket executes, Task 2/3 below should adopt it instead of the
ticket-local envelope; if it lands after, the ticket-local envelope (§4 Task 3) is a strict subset
that can be widened without a breaking change (additive fields only).

## 3. Knowledge & Best Practices

- `.claude/rules/04-application-services.md` — the new delivery mechanism is a `@Processor` (BullMQ
  job consumer), not a public application service method; it still goes through
  `IWebhookService`/`webhookRunHistoryRepository` for all reads/writes, never a raw Prisma call
  (rule: "Access Prisma from a service… banned"). Sys-events: the processor does NOT call
  `broadcastSysEvent` on `WebhookRunHistory` writes (append-only telemetry rows, not a CRUD
  resource with its own lifecycle — mirrors how `AuditLog` rows are written without their own
  sys-event fan-out).
- `.claude/rules/09-infrastructure-devops.md` §Configuration Tiers — the webhook signing secret is a
  **per-tenant secret** (Data class 2, `db-secret` tier: Vault-Transit ciphertext in a DB column),
  the same tier as `TenantBucket.credentialsRef` (§2.7), **not** a `vault-kv` platform secret (that
  tier is for shared, operator-set credentials like `API_KEY_PEPPER` itself, which stays a platform
  pepper applied to every tenant's HMAC the same way the API-key pepper is applied to every key).
  "Never put a credential in a DB column in plaintext" (§9.3 M10) — `hashedSecret` stores the
  peppered hash, never the raw secret, mirroring `ApiKey.hashedKey`.
- `.claude/rules/09-infrastructure-devops.md` §Config caches — not directly applicable (no cache
  introduced), but the retry/backoff choice below follows the same "TTL is a bounded-staleness
  safety net, not the mechanism" philosophy: BullMQ's own `attempts`/`backoff` is the delivery
  mechanism, a dead-letter state is the safety net for exhaustion, not a cron sweep.
- **PHI/egress justification for reference-not-content payloads**: the platform's documented PHI
  posture (rule `00-project-context.md` — "multi-tenant healthcare AI platform"; rule
  `09-infrastructure-devops.md`'s Vault-Transit-everywhere pattern for `TranscriptionJob`/
  `KnowledgeChunk` result columns, confirmed in §2.2/§2.4 of TASK-724's and TASK-728's research)
  treats clinical content as something that leaves the platform boundary only through
  audited, authenticated, tenant-scoped reads — never embedded in a fire-and-forget POST to a
  third-party URL the platform does not control the security posture of. A webhook payload of `{
  eventType, resourceType, resourceId, tenantId, occurredAt, fetchUrl }` lets the receiver pull the
  actual resource back through the existing authenticated API (same 404-over-403 tenancy guarantees,
  same audit trail) rather than the platform pushing PHI outbound to an endpoint it cannot verify.
  This is the "identifiers + fetch-back URL" contract named in the assignment.
- `.claude/rules/01-development-workflow.md` — TDD ordering; every task below states its failing
  test before implementation. Script names used below (`pnpm --filter @arcaai/applications test`,
  `pnpm lint`) match root `package.json`.
- **Known pitfall**: do not "fix" `responeStatusCode`'s typo (§2.1) — renaming a live Prisma column
  is a migration this ticket doesn't need and isn't scoped for; add a comment noting the typo is
  intentionally preserved, consistent with `.claude/rules/_karpathy.md` §3 "surgical changes."
- **Known pitfall**: `SYS_EVENT_JOB_OPTIONS` (`attempts: 2`, §2.4) governs the **CRUD-audit fan-out**
  job, which is a different job from the new webhook-delivery job this ticket adds. Do not reuse
  `SYS_EVENT_JOB_OPTIONS` for HTTP delivery retries — an HTTP POST to a third-party endpoint needs
  its own, more generous backoff (§4 Task 3 specifies it) independent of the internal fan-out job's
  options.

## 4. Implementation Plan

### Task 1 — Correct the stale README pointer
- **Agent:** T1 · haiku-4-5 · default
- **Files:** `packages/applications/src/services/webhook/README.md`
- **Approach:** Replace the "the actual HTTP delivery lives in
  `@arcaai/applications/src/services/notification/`" line (§2.2) with an accurate pointer to the new
  `webhook-delivery.processor.ts` (Task 4) once it lands, and add a one-line "as of TASK-727" note
  so a future reader isn't misled the way this ticket's research was.
- **Verify:** manual read-through; no test (docs-only).

### Task 2 — Failing tests: server-generated, peppered-HMAC webhook secrets
- **Agent:** T2 · sonnet-5 · medium
- **Files:** `packages/applications/src/services/webhook/__tests__/webhook.service.test.ts` (extend),
  `packages/applications/src/services/webhook/webhook.service.ts`,
  `packages/applications/src/services/webhook/dto/createWebhook.request.ts`,
  `packages/applications/src/services/webhook/dto/webhook.response.ts`
- **Approach:** RED first. Remove `hashedSecret` from `CreateWebhookRequest` (a caller must never
  supply the secret — mirrors `ApiKeyService.generateRawKey`, `apikey.service.ts:143-149`, which is
  entirely server-generated). `WebhookService.create` generates a raw secret
  (`randomBytes(32).toString('hex')`, same primitive `apikey.service.ts` already imports from
  `node:crypto`), computes `hashedSecret` via the SAME `hashKeyForStorage` pattern
  (`apikey.service.ts:169-175`, resolving the pepper from `SecretsService.getSecretOptional` — reuse
  the pepper key `API_KEY_PEPPER` or register a new `WEBHOOK_SECRET_PEPPER` vault-kv descriptor
  following `platform-secrets.descriptors.ts`'s exact shape — decide and document which in this
  task's PR description; a NEW dedicated pepper is preferred so webhook and API-key HMACs are not
  cross-key-recoverable), and returns the RAW secret **once**, only in the `create` response (never
  on subsequent `fetchById`/`fetchAll` — `WebhookResponse` for reads omits the raw value entirely;
  only `hashedSecret`'s presence/absence as a boolean `hasSecret` flag is returned on reads, mirroring
  how `ApiKeyResponse` never re-exposes a raw key after issuance — verify that exact pattern in
  `apiKey/dto/*.response.ts` before implementing). Tests assert: (a) create response contains a raw
  secret matching `/^[0-9a-f]{64}$/` and NOT equal to the stored `hashedSecret`; (b) a second create
  produces a different raw secret; (c) `fetchById`/`fetchAll` responses never contain a raw secret
  field; (d) `update` cannot set `hashedSecret` directly (field removed from `UpdateWebhookRequest`
  too, or a dedicated `rotateSecret` method is added — decide and test whichever; rotation support is
  in scope since §2.7 identifies secret rotation as a real operational need, per rule
  `09-infrastructure-devops.md`'s "`SecretsService` has its own equivalent channel… for rotations").
- **Verify:** `pnpm --filter @arcaai/applications test -- webhook.service.test.ts` — RED.

### Task 3 — Implement server-generated secrets + rotation
- **Agent:** T3 · sonnet-5 · medium
- **Files:** same as Task 2, plus a new `rotateSecret(id, expectedVersion)` method on
  `IWebhookService`/`WebhookService` and its controller route
  `POST admin/webhooks/:id/rotate-secret` on `apps/api/src/modules/webhook/webhook.controller.ts`
  (mirrors the OCC contract already on `PATCH :id` — `@RequiresIfMatch()` +
  `@ExpectedVersion()`, since rotation is itself a version-bumping write)
- **Approach:** Implement per Task 2's spec. `SecretsService` injection into `WebhookService`
  follows the same constructor pattern `ApiKeyService` already uses (verify exact injection token
  name in `apikey.service.ts`'s constructor before writing).
- **Verify:** Task 2's suite — GREEN; `pnpm --filter @arcaai/applications test`.

### Task 4 — Failing tests: webhook-delivery BullMQ processor
- **Agent:** T2 · sonnet-5 · medium
- **Files:** `packages/applications/src/services/webhook/__tests__/webhook-delivery.processor.test.ts` (new)
- **Approach:** RED first, following `auditLog.processor.ts`'s test file as the structural exemplar
  (find and imitate its mocking style for `@Processor`/`@Process` job handling). Cover: (a) a
  `SysEventJob` whose `data.resourceType` matches an ENABLED `Webhook.resourceTypeName` for the
  event's `tenantId`, with `resourceId` either null (wildcard) or matching — the processor computes
  an HMAC-SHA256 signature over the JSON payload using the webhook's peppered secret (Task 3),
  sets it as a header (e.g. `X-Hope-Webhook-Signature`, `sha256=<hex>` — name the header precisely
  in this task, following the GitHub/Stripe convention of a prefixed hex digest), POSTs `{
  eventType: event.type, resourceType: event.resourceType, resourceId: event.resourceId, tenantId:
  event.tenantId, occurredAt: event.createdAt, fetchUrl: <constructed from resourceType/resourceId>
  }` (§3 reference-not-content contract — NEVER `event.data`) to `Webhook.url`, and on a 2xx response
  writes a `WebhookRunHistory` row with `status: SUCCESS`, the response status code, and a
  size-capped response body; (b) a non-2xx or network-error response writes `status: FAILED` with
  the error/status captured, and the job THROWS (so BullMQ's own retry/backoff takes over — the
  processor does not hand-roll its own retry loop); (c) no matching `Webhook` row for the event →
  the job completes as a no-op, no `WebhookRunHistory` row written, no HTTP call made; (d) a
  `DISABLED`/soft-deleted `Webhook` row is never matched (query filters `resourceStatus: ENABLED`,
  consistent with the extended Prisma client's own soft-delete filtering per rule
  `02-database-prisma.md`, but be explicit in the query since this is a raw repository read, not a
  service passthrough); (e) after `attempts` exhaustion (Task 5's job options), a final
  `WebhookRunHistory` row records the terminal failure, distinguishable from an in-progress retry
  (e.g. `status: DEAD_LETTERED` — confirm this is a valid `WebhookRunStatus` enum member; if not,
  add it as a schema change per `02-database-prisma.md`'s migration workflow, since `WebhookRunStatus`
  is presumably a Prisma enum in `enums.prisma` — verify its current members before assuming
  `DEAD_LETTERED` doesn't already exist).
- **Verify:** `pnpm --filter @arcaai/applications test -- webhook-delivery.processor.test.ts` — RED
  (processor doesn't exist).

### Task 5 — Implement the webhook-delivery processor + wire the queue
- **Agent:** T3 · sonnet-5 · high
- **Files:** `packages/applications/src/services/webhook/webhook-delivery.processor.ts` (new),
  `packages/applications/src/services/webhook/webhook.service.module.ts` (register the processor +
  any HTTP-client provider it needs — check whether an existing shared `httpService`/`axios`
  wrapper exists in `packages/applications/src/services/baseServices/**` before adding a new one)
- **Approach:** `@Processor(JobQueue.SysEvent)` class, `@Process()` handler matching `SysEventJob`'s
  shape (§2.6). Match query: `webhookRepository.findAll({ where: { tenantId: event.data.tenantId,
  resourceTypeName: event.data.resourceType, resourceStatus: 'ENABLED', OR: [{ resourceId: null },
  { resourceId: event.data.resourceId }] } })` (verify the extended-client filter syntax against
  `Repository.findAll`'s actual signature in `packages/domains/src/common/repository.ts` before
  writing this literally). Per-webhook delivery job options (distinct from `SYS_EVENT_JOB_OPTIONS`,
  §3 pitfall): `attempts: 5, backoff: { type: 'exponential', delay: 2000 }` (2s → 4s → 8s → 16s →
  32s, a reasonable third-party-endpoint retry budget — confirm/adjust with the team if this
  conflicts with an existing platform convention for outbound webhook retry windows), `removeOnFail:
  false` (dead-letter inspection, per §2.4's established pattern). HMAC signing uses Task 3's
  per-webhook secret; timeout the outbound HTTP call (e.g. 10s) so one slow tenant endpoint cannot
  starve the queue's worker concurrency — cite and reuse whatever HTTP client timeout convention
  `directory-sync.processor.ts` or another existing outbound-HTTP processor already establishes,
  rather than inventing a new one.
- **Verify:** Task 4's suite — GREEN; `pnpm --filter @arcaai/applications build`.

### Task 6 — Wire `SysEventType.WebHookRun` semantics (or confirm it's superseded by the generic path)
- **Agent:** T2 · sonnet-5 · low
- **Files:** `packages/domains/src/enums/sysEventType.enum.ts`, its usages
- **Approach:** Task 5's processor matches on the ORIGINATING event's `resourceType`/`resourceId`
  (e.g. a `Consultation` `ResourceUpdated` event), not a separate `WebHookRun` event — `WebHookRun`
  as declared today has no defined semantics distinct from "a webhook ran," which is exactly what a
  new `WebhookRunHistory` row already records without needing its own `SysEvent`. Confirm this
  reading is correct (it matches §2.5's finding that nothing ever emits it) and either (a) leave
  `WebHookRun` declared-but-unused with a comment explaining it's superseded by the
  `WebhookRunHistory` row itself, or (b) if code review disagrees, broadcast it from the processor
  on successful delivery — decide and document the choice in this task, do not leave it silently
  ambiguous.
- **Verify:** none (documentation/decision task) or a one-line unit test if (b) is chosen.

### Task 7 — E2E: end-to-end delivery against a test receiver
- **Agent:** T2 · sonnet-5 · medium
- **Files:** `apps/api/tests/e2e/task-727-webhook-delivery.spec.ts` (new)
- **Approach:** Create a tenant-scoped `Webhook` via the real `POST admin/webhooks` route pointed at
  a locally-started test HTTP receiver (an in-process `http.createServer` bound to an ephemeral
  port, torn down after the spec — follow whatever pattern existing e2e specs use for a mock
  external endpoint; if none exists, this is the first one and should be kept minimal), trigger a
  mutation on a subscribed resource type (e.g. create a `Department` — pick whatever resource type
  is cheapest to create in the e2e fixture set), poll `GET admin/webhooks/:id/deliveries` until a
  `SUCCESS` row appears, and assert: (a) the receiver got exactly one POST; (b) the signature header
  verifies against the raw secret returned at creation time (§4 Task 3); (c) the payload contains no
  PHI/resource content — only ids + `fetchUrl` (§3); (d) calling `fetchUrl` with the test's own
  bearer token returns the real resource (proves the reference-not-content contract is actually
  usable, not just theoretically safe).
- **Verify:** `pnpm test:up:api` (terminal 1) then `pnpm test:e2e -- task-727-webhook-delivery`.

### Task 8 — Full verification pass
- **Agent:** T2 · sonnet-5 · low
- **Files:** none
- **Approach:** Run every layer gate this ticket touches.
- **Verify:** `pnpm --filter @arcaai/applications build`, `pnpm --filter @arcaai/applications test`,
  `pnpm api:build`, `pnpm test:unit`, `pnpm lint`.

## 5. Acceptance Criteria

- [x] `pnpm --filter @arcaai/applications build` passes
- [x] `pnpm --filter @arcaai/applications test` passes, including the new/extended `webhook.service.test.ts`
      and `webhook-delivery.processor.test.ts` suites (79/79)
- [x] `pnpm api:build` passes (12/12 workspace tasks). `pnpm test:unit` — targeted scopes verified
      clean (§7); full-repo run's final result recorded in the session status report.
- [ ] `pnpm test:up:api` then `pnpm test:e2e -- task-727-webhook-delivery` — NOT executed (environment
      constraint, §7: Prisma's AI-agent `db push --force-reset` refusal). Spec authored, Playwright-listable,
      TypeScript-clean.
- [x] Webhook secrets are server-generated and REVERSIBLY ENCRYPTED at rest (corrected from
      "peppered-hashed" — see §7's design-correction note for why a one-way hash cannot work here); a
      raw secret is returned exactly once, at creation (or rotation), and never again on any read
- [x] `JobQueue.SysEvent` has a real consumer (`webhook-delivery.processor.ts`); a matching, enabled
      `Webhook` row receives a signed POST for a subscribed resource-type mutation (unit-verified;
      e2e-authored-but-unrun per above)
- [x] Delivery attempts are recorded in `WebhookRunHistory` (success, failure, and dead-lettered-after-exhaustion
      states all distinguishable), readable via the existing `GET admin/webhooks/:id/deliveries` route
      with no controller changes needed
- [x] Retry/backoff is configured on the delivery job distinctly from `SYS_EVENT_JOB_OPTIONS`; failed
      jobs are retained (`removeOnFail: false`) for dead-letter inspection
- [x] Payload contract verified as reference-only (ids + `fetchUrl`), never embedding
      `SysEvent.data`/resource content, per the PHI-egress justification in §3
- [x] `packages/applications/src/services/webhook/README.md` corrected to point at the real delivery
      processor
- [x] `pnpm lint` — zero new errors in touched files (`@arcaai/applications`, `@arcaai/domains`,
      `apps/api` webhook module, `scripts`); pre-existing warnings in untouched sibling files not
      introduced by this ticket
- [x] Ticket README's Implementation Summary and Change History updated with actual command output
      pasted

## 6. Risks & Open Questions

- **HUMAN-GATED: pepper key choice (Task 3).** Reusing `API_KEY_PEPPER` for webhook HMACs is simpler
  (one fewer Vault-seeded secret) but means a pepper compromise affects both API keys and webhook
  signatures; a dedicated `WEBHOOK_SECRET_PEPPER` is more isolated but adds an operational secret to
  `scripts/vault-seed-secrets.sh`'s derived key list. Needs a decision before Task 3, not during it.
- **`WebhookRunStatus` enum completeness (Task 4/5)**: this ticket assumes `SUCCESS`/`FAILED` exist
  and may need to ADD a `DEAD_LETTERED` (or equivalent) member — that is a live-enum Prisma migration
  if it doesn't already exist. Verify `enums.prisma`'s actual `WebhookRunStatus` members before
  Task 4's tests are written; if the enum needs extension, size that into Task 4/5 explicitly rather
  than discovering it mid-implementation.
- **`resourceTypeName` is a free string, not a `ResourceType` enum reference** (§2.1 —
  `Webhook.resourceTypeName String`, not `ResourceType`). The delivery processor's match query
  compares it against `event.resourceType` (which IS a `ResourceType` enum value serialized to
  string) — a typo'd `resourceTypeName` at webhook-creation time silently never matches anything,
  with no validation today. Consider (not mandatory for this ticket, but flag for product/DX
  follow-up) validating `resourceTypeName` against the real `ResourceType` enum at creation time so
  a tenant gets an immediate error instead of a webhook that silently never fires.
- **Outbound egress allowlisting is out of scope but adjacent**: `design.md`'s services-program table
  notes guardrail's cloud-egress allowlist is currently fail-open (a Wave-0 `egress-failclose`
  concern, TASK-706, for a DIFFERENT egress path — LLM/BYOK provider calls, not webhooks). Whether
  tenant webhook URLs need their own SSRF-safety allowlist (private-IP/localhost blocking, redirect-
  following limits) is a real security question this ticket's e2e test does not exercise (it targets
  an in-process test receiver). Recommend a follow-up security review before this ships to any
  tenant able to register an arbitrary `url`, since a webhook subscription is effectively
  tenant-controlled SSRF surface if unguarded — flag explicitly to the reviewing agent/human rather
  than silently shipping without it.
- **Idempotency-key / resume-token contract (§2.9)**: if TASK-717 lands mid-execution with a
  different envelope shape than assumed here, Tasks 2-5's payload shape may need a follow-up
  widening pass — kept additive-only by design so this should not be a breaking rework, but is worth
  flagging to whoever picks up TASK-717 afterward.

## 7. Implementation Summary

### Owner decision already applied (from the run instructions)

**Pepper key choice (§6, HUMAN-GATED)**: a DEDICATED `WEBHOOK_SECRET_PEPPER` Vault secret, never
`API_KEY_PEPPER`. Registered as `webhook.secretPepper` in `platform-secrets.descriptors.ts`,
resolved by `WebhookService` exactly like `ApiKeyService` resolves `API_KEY_PEPPER` — but a
SEPARATE Vault kv-v2 entry, so rotating one credential can never silently invalidate the other.
Documented at length in the descriptor's own `description` field (read that first if you're
touching this key) and in `WebhookService`'s class-level doc.

### A design correction to §2.7, discovered during implementation

§2.7's plan (and Task 2/3's literal wording) directed a **peppered ONE-WAY HASH** for
`Webhook.hashedSecret`, mirroring `ApiKeyService.hashKeyForStorage` exactly. Implementing Task 4/5
(the actual signing step) surfaced why that is wrong for THIS use case, not just a stylistic
choice:

- An API key is verified by **re-presentation**: the caller sends the raw key on every request,
  the server hashes it and compares to the stored hash. A one-way digest is the correct primitive.
- A webhook signature is **computed by the platform**, not re-presented by a caller: the platform
  must independently produce `HMAC-SHA256(rawSecret, body)` on every delivery, and the RECEIVER
  (who saw the raw secret exactly once, at creation) verifies by computing the same HMAC. For the
  platform's signature to ever verify, the delivery processor must be able to recover the ORIGINAL
  raw secret at send time — which a one-way hash makes structurally impossible.
- This is not a hypothetical: it's directly load-bearing for this ticket's own §5 acceptance
  criterion — *"the signature header verifies against the raw secret returned at creation
  time"* — and Task 7's e2e assertion (b). A peppered-hash implementation would have shipped a
  webhook feature whose signatures no real subscriber could ever verify.

**Resolution** (documented in full in `WebhookService`'s class doc): `Webhook.hashedSecret` stores
**AES-256-GCM ciphertext** of the raw secret — REVERSIBLE, keyed by material derived from the
dedicated `WEBHOOK_SECRET_PEPPER` — not a hash. This is the same "peppered, never-plaintext,
platform-recoverable" shape rule `09-infrastructure-devops.md`'s `db-secret` tier describes for
`TenantBucket.credentialsRef`, implemented as a self-contained primitive
(`WebhookService.encryptSecret`/`decryptSecret`) rather than a full `SecretsService.encrypt`/
`decrypt` Vault-Transit round trip — a reasonable stronger follow-up if per-row Transit key
versioning is wanted later. The column is NOT renamed (a live-column rename is its own migration,
same posture as the deliberately-preserved `responeStatusCode` typo) — `hashedSecret` now stores
what its name always half-promised: a protected, not-plaintext form of the secret, just a
reversible one. This is exactly the "Lets review, suggest best practices — YOU decide" latitude
the run instructions grant for this ticket's secondary decisions.

### What shipped, task by task

- **Task 1** — `packages/applications/src/services/webhook/README.md` corrected to point at
  `webhook-delivery.processor.ts`, with a note explaining the prior pointer was wrong.
- **Tasks 2/3** — Server-generated signing secrets. `CreateWebhookRequest`/`UpdateWebhookRequest`
  no longer accept `hashedSecret` (removed from both DTOs). `WebhookService.create` always
  generates a raw secret (`randomBytes(32).toString('hex')`), encrypts it
  (`encryptSecretForStorage`), and returns `{ webhook, rawSecret }` — the raw secret exactly once.
  `WebhookResponse` never carries `hashedSecret`; only a computed `hasSecret: boolean`
  (`WebhookDtoMapper` custom-mapping). A new `rotateSecret(id, expectedVersion)` method (OCC,
  `updateWithVersion`) is the ONLY other write path that may set `hashedSecret`; `update()`
  defensively throws if a caller smuggles `hashedSecret` past the DTO type. New controller route
  `POST admin/webhooks/:id/rotate-secret` (`@RequiresIfMatch`/`@ExpectedVersion`, same OCC contract
  as `PATCH :id`), returning the same `{ webhook, rawSecret }` shape as create (`CreateWebhookResponse`
  DTO at the apps/api edge, mirroring `CreateApiKeyResponse`).
- **Task 4/5** — `webhook-delivery.processor.ts`, a real consumer of `JobQueue.SysEvent`, split into
  two processor classes across two BullMQ queues (see the file's own header for the full
  rationale):
  - `WebhookDeliveryProcessor` (`@Processor(JobQueue.SysEvent)`) — matches a fired `SysEvent`
    against ENABLED `Webhook` rows on `(tenantId, resourceTypeName, resourceId-or-wildcard)` and
    fans out one `JobQueue.WebhookDelivery` job per match. A NEW `JobQueue.WebhookDelivery` enum
    member was added (`packages/domains/src/enums/JobQueue.enum.ts`) — deliberately a SEPARATE
    queue from `SysEvent` so one webhook's retry never re-delivers to another, already-succeeded
    subscriber of the same event (see the design-tension note below).
  - `WebhookDeliveryDispatchProcessor` (`@Processor(JobQueue.WebhookDelivery)`) — signs
    (`HMAC-SHA256` over the JSON body, header `X-Hope-Webhook-Signature: sha256=<hex>`), POSTs the
    reference-not-content payload (`{ eventType, resourceType, resourceId, tenantId, occurredAt,
    fetchUrl }` — never `SysEvent.data`), and writes one `WebhookRunHistory` row per attempt
    (`SUCCESS` / `FAILED` / `DEAD_LETTERED` on the final configured attempt). THROWS on failure —
    BullMQ's own `attempts: 5` / exponential backoff (2s→4s→8s→16s→32s, `WEBHOOK_DELIVERY_JOB_OPTIONS`,
    deliberately distinct from `SYS_EVENT_JOB_OPTIONS`) governs redelivery; no hand-rolled retry
    loop. Idempotent on TASK-717's own named recipe for this ticket
    (`hook:<webhookId>:<sourceEnvelopeId>`) at two layers: cheap (BullMQ `jobId`) and authoritative
    (a `WebhookRunHistory` SUCCESS-row pre-check keyed by the same string, stored in the JSON
    `response` column).
  - `fetchUrl` construction is explicitly BEST-EFFORT (documented in the processor's own comment):
    the platform has no single generic "fetch any resource by type" route, so a small explicit
    `ResourceType → path` map covers the resource types most plausible for a subscription, with a
    mechanical kebab-plural fallback for everything else. `API_URL` (already an established,
    turbo-global bootstrap env var — the gateway's own externally-reachable address) is the base;
    no new env var was introduced for this.
  - `WebhookRunStatus.DEAD_LETTERED` added via a real migration
    (`20260816161101_task_727_webhook_run_dead_lettered`), authored/applied/diffed against a
    throwaway `hope_shadow` DB per rule 02, empty-diff proven, then `db push`'d onto the real dev
    DB. `pnpm gen:model` regenerated the enum layer.
  - Module wiring: `webhook.service.module.ts` registers both queues
    (`BullModule.registerQueue({name: JobQueue.SysEvent})` — needed even though `CommonServiceModule`
    already registers it app-wide, because `RedisServiceModule.register`'s exports don't re-export
    the BullMQ queue provider itself, same pattern `auditLog.service.module.ts` already uses — and
    `JobQueue.WebhookDelivery`, net-new) plus `HttpModule` and both processor providers.
- **Task 6** — `SysEventType.WebHookRun` left declared-but-unused, with a comment explaining why:
  delivery matches the ORIGINATING event and records its own `WebhookRunHistory` row, so a second,
  separate `WebHookRun` SysEvent would be a self-referential loop with no reader. Option (a) from
  the ticket's own menu.
- **Task 7** — `apps/api/tests/e2e/task-727-webhook-delivery.spec.ts` authored: an in-process
  ephemeral-port HTTP receiver (`http.createServer`, following the `byo-llm-credentials.spec.ts`
  precedent but WITHOUT env-gating, since `Webhook.url` is read fresh per delivery rather than
  resolved once at gateway bootstrap), a real `Department` create as the triggering mutation,
  polling `GET admin/webhooks/:id/deliveries` for the SUCCESS row, and all four assertions the
  assignment names ((a) exactly one POST, (b) signature verifies against the raw secret, (c)
  reference-only payload, (d) `fetchUrl` round-trips to the real resource). Playwright-listable
  (confirmed: `npx playwright test --list` finds it) and TypeScript-clean, but **NOT EXECUTED** —
  see the environment note below. The pre-existing `admin-golden-sets-webhooks.spec.ts` webhook
  lifecycle test was also updated for the new create-response shape (`{webhook, rawSecret}` instead
  of a bare `WebhookResponse`) — it would otherwise have silently started asserting on `undefined`.
- **Task 8** — full verification pass; see the Verification Evidence section below.

### Additional changes not in the original task list, and why

- `packages/domains/src/enums/JobQueue.enum.ts` — new `WebhookDelivery` member (the two-queue
  split above).
- `packages/domains/src/enums/sysEventType.enum.ts` — comment only on `WebHookRun` (Task 6).
- `packages/applications/src/common/worker-session.ts` — new `'webhook-delivery'`
  `WorkerSessionKind` (the closed-set enum every BullMQ processor's CLS rebind must extend).
- `packages/applications/src/services/settings-registry/__tests__/fail-mode.governance.test.ts` —
  added the new descriptor's expected env-var mapping (governance test, not a behavior change).
- `pnpm env:sync` was run after registering `webhook.secretPepper` (required — a new `vault-kv`
  descriptor drifts `.env.sample`/`turbo.json#globalEnv`/`env-surface.generated.md` otherwise, per
  rule 00). Its diff ALSO absorbed two pre-existing, unrelated keys
  (`HARNESS_NLP_SERVICE_TOKEN`, `HARNESS_SMR_SERVICE_TOKEN`) that a sibling ticket had already
  introduced but not yet synced — `env:sync` is a full regeneration from the current descriptor
  set, not an incremental diff, so there is no way to sync only this ticket's own addition.
  `scripts/__tests__/env-sync.test.ts`'s hardcoded surface-size ceiling was bumped 147→148 with a
  one-line justification, following that test's own established convention.
- `apps/api/tests/e2e/admin-golden-sets-webhooks.spec.ts` — updated for the create-response shape
  change (see Task 7 above); this file is committed/tracked, not another ticket's in-flight work.

### Environment note — why Task 7's spec was not executed

Per this run's standing instruction: Playwright's `globalSetup` runs `prisma db push
--force-reset`, which Prisma's CLI refuses when invoked by an AI agent in this environment. This
is a known, pre-existing environment constraint (also hit identically by TASK-722's closeout),
not something introduced by this ticket. `pnpm test:up:api` + `pnpm test:e2e -- task-727-webhook-delivery`
were NOT run. Verified instead: `npx playwright test --list` finds and parses the spec correctly
(1 test), and `apps/api`'s own `tsc --noEmit` reports zero errors against it.

### Risks/open-questions carried forward (§6), status

- **`WebhookRunStatus` enum completeness** — resolved: `DEAD_LETTERED` added via migration (above).
- **`resourceTypeName` is a free string, not a `ResourceType` enum reference** — confirmed still
  true and NOT fixed (flagged in §6 as "not mandatory for this ticket"); the matcher compares
  `Webhook.resourceTypeName` to `event.resourceType` (both plain strings) as designed. A follow-up
  ticket adding creation-time validation against the real `ResourceType` enum remains open.
- **Outbound egress / SSRF-safety allowlisting** — still NOT implemented and still explicitly
  flagged here, per §6's own instruction to surface rather than silently ship without it. A tenant
  able to register an arbitrary `Webhook.url` today has effectively tenant-controlled SSRF surface
  (private-IP/localhost targets, redirect-following) with no guard. Recommend the security review
  §6 already asked for before this ships to any tenant.
- **Idempotency-key / envelope contract vs. TASK-717** — TASK-717 landed BEFORE this ticket
  executed (Wave 1, already in the tree) and its own recipe table names
  `hook:<subscriptionId>:<sourceEnvelopeId>` as the exact webhook-delivery idempotency key — this
  is implemented verbatim (inlined as `webhookDeliveryIdempotencyKey`, not imported from
  `@arcaai/async-contract`, to avoid a new workspace dependency for one string template — see the
  processor file's own comment for that call). No envelope-shape widening was needed; `SysEvent`
  (already built for the CRUD-audit path) supplied everything the matcher needed.

### Verification Evidence

`pnpm --filter @arcaai/applications build`:
```
> @arcaai/applications@0.0.1 build
> rimraf dist tsconfig.tsbuildinfo && tsc
(clean — zero output, exit 0)
```

`pnpm --filter @arcaai/applications test` (webhook suites, `packages/applications/src/services/webhook/`):
```
 Test Files  2 passed (2)
      Tests  79 passed (79)
```
(`webhook.service.test.ts` — 66 tests incl. the new server-generated-secret/rotation TASK-727
blocks; `webhook-delivery.processor.test.ts` — 13 tests covering the fan-out matcher and the
sign/POST/record dispatcher, cases (a)–(e) from the plan plus idempotency-skip and
response-body-capping.)

Settings-registry governance (`fail-mode.governance.test.ts`, `vault-kv-coverage.test.ts`):
```
 Test Files  2 passed (2)
      Tests  24 passed (24)
```

`pnpm api:build`: all 12 workspace build tasks succeeded (`nest build && tsc-alias` for `apps/api`
included) — full turbo output captured during the session; re-run to reproduce.

`apps/api` webhook controller unit tests (`webhook.controller.test.ts`):
```
 Test Files  1 passed (1)
      Tests  13 passed (13)
```

`pnpm env:sync` — no drift after regeneration (`scripts/__tests__/env-sync.test.ts`, 25/25 passing,
including the bumped surface-size ceiling).

Migration proof (rule 02 shadow-DB workflow):
```
$ npx prisma migrate diff --from-config-datasource --to-schema src/prisma/db_main --script
-- This is an empty migration.
```
(run against `hope_shadow` after applying `20260816161101_task_727_webhook_run_dead_lettered`).

`pnpm test:unit` (full monorepo suite) and `pnpm lint` (root): run at the end of the session:
targeted scopes (`@arcaai/applications`, `@arcaai/domains`, `apps/api`, `scripts`) all clean/zero
new errors as shown above; the full-repo run's outcome is recorded in this session's final status
report rather than re-pasted here — see the ticket's Change History entry below for the exact
result.

**NOT run** (per this program's standing instruction, not this ticket's own gap):
`pnpm test:e2e -- task-727-webhook-delivery` — blocked by the Prisma AI-agent `db push
--force-reset` refusal described above.

### Close-out pass (2026-08-17) — re-verified against the squashed migration baseline

**The migration ledger was squashed since this ticket executed** (102 migrations →
`20260817000000_init` + two follow-ons). The old, by-hand-authored
`20260816161101_task_727_webhook_run_dead_lettered` migration file no longer exists as a separate
file; its schema effect is folded into `20260817000000_init`
(`CREATE TYPE "core"."WebhookRunStatus" AS ENUM ('SUCCESS', 'FAILED', 'DEAD_LETTERED')` is present
at line 62). Re-ran the rule-02 shadow-DB recipe against a throwaway `hope_shadow_closeout`
database this pass (never the dev DB) to re-prove zero drift on the NEW baseline:

```
$ pnpm --filter @arcaai/database db:migrate:deploy   (→ hope_shadow_closeout)
Applying migration `20260817000000_init`
Applying migration `20260817000100_task_734_workflow_definition_immutability_guard`
Applying migration `20260817031425_task_732_flip_system_harness_enabled_default`
All migrations have been successfully applied.

$ npx prisma migrate diff --from-config-datasource --to-schema src/prisma/db_main --script
-- This is an empty migration.
```

`hope_shadow_closeout` dropped afterward.

**Re-verified this pass, real output:**

```
$ NODE_ENV=test npx vitest run packages/applications/src/services/webhook apps/api/src/modules/webhook \
    packages/applications/src/services/settings-registry/__tests__/fail-mode.governance.test.ts
  → Test Files 4 passed (4); Tests 114 passed (114)
$ pnpm --filter @arcaai/applications build   → clean
$ pnpm api:build                              → 12/12 successful
$ npx playwright test apps/api/tests/e2e/task-727-webhook-delivery.spec.ts --list
  → 1 test listed (unchanged, still not run)
```

**Not fixed this pass, unchanged**: e2e execution (same documented `db push --force-reset`
environment blocker every ticket in this close-out hits); the `resourceTypeName`
free-string-vs-`ResourceType`-enum validation gap (§6, explicitly out of scope); the outbound
egress/SSRF-safety allowlist recommendation (§6, flagged for a separate security review — still
not built, still not silently dropped). No code defects found in this ticket's own files this
pass. Status remains Review.

## 8. Change History

| Date | Change | By |
|---|---|---|
| 2026-08-16 | Ticket authored | Wave-3 ticket-authoring agent |
| 2026-08-16 | Tasks 1–6, 8 implemented and verified (Task 7 authored, not executed — environment constraint). Server-generated webhook secrets + rotation; `webhook-delivery.processor.ts` (two-queue matcher/sender split); `WebhookRunStatus.DEAD_LETTERED` migration; dedicated `WEBHOOK_SECRET_PEPPER`. Design correction recorded: `hashedSecret` stores reversible AES-256-GCM ciphertext, not a one-way hash (§7) — a one-way hash cannot support HMAC signature verification by the receiver. `pnpm --filter @arcaai/applications build/test`, `pnpm api:build`, full `pnpm test:unit` (17903+673+4183+223+1553 all passed) all green; `pnpm env:sync` re-run for the new descriptor. | Execution agent |
| 2026-08-17 | Close-out pass. Re-proved the rule-02 shadow-DB migration diff against the newly-squashed baseline (old per-ticket migration file no longer exists; its `WebhookRunStatus.DEAD_LETTERED` schema is now part of `20260817000000_init`) using a throwaway `hope_shadow_closeout` database — empty diff confirmed. Re-ran the webhook + settings-registry-governance test suites (4 files / 114 tests) and `applications`/`api:build`, all green. No code changes to this ticket's own files. Status remains Review — e2e execution is the only open item, outside this pass's authority to close. | close-out pass agent |
