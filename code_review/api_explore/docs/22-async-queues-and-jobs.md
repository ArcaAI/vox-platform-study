# 22. Async Queues and Jobs

**Sources:** [`packages/domains/src/enums/JobQueue.enum.ts`](https://github.com/ArcaAI/project-hope/tree/dev-2.2/packages/domains/src/enums/JobQueue.enum.ts), [`packages/applications/src/services/baseServices/redis/queue-concurrency.ts`](https://github.com/ArcaAI/project-hope/tree/dev-2.2/packages/applications/src/services/baseServices/redis/queue-concurrency.ts), processors under [`packages/applications/src/services/`](https://github.com/ArcaAI/project-hope/tree/dev-2.2/packages/applications/src/services)

BullMQ (Redis) provides asynchronous work. Workers run **inside the gateway process** — there is no separate Node worker Deployment (the only separate workers are the Python `hope-harness-worker` and `hope-stt-worker`). A worker slot and an HTTP handler therefore draw from the same `PRISMA_PG_MAX` Prisma pool.

## Queues and Processors

| Queue | Processor | Concurrency | Purpose |
|---|---|---:|---|
| `AuditLog` | `AuditLogProcessor` | 8 | One job per mutation; envelope-encrypt + INSERT. Highest-volume queue. |
| `SysEvent` | `WebhookDeliveryProcessor` | 6 | Matcher: consumes the mutation event fan-out and enqueues one `WebhookDelivery` per subscribed webhook. |
| `WebhookDelivery` | `WebhookDeliveryDispatchProcessor` | 10 | Sender: signs and POSTs to one tenant endpoint, writes `WebhookRunHistory`; throws so BullMQ retry/backoff governs redelivery. Holds no Prisma slot. |
| `GeneratePreSummary` | `PreSummaryProcessor` | 3 | Interactive pre-summary (clinician waiting); LLM call to `apps/text`. |
| `GenerateDnaReport` | `DnaWritingStyleProcessor` | 2 | Background DNA writing-style analysis. |
| `IngestKnowledgeDocument` | `IngestKnowledgeDocumentProcessor` | 2 | Chunk + embed via self-hosted LM Studio, then bulk chunk INSERT. Embedding is GPU-bound. |
| `MineGateEditExemplar` | `GateEditMiningProcessor` | 2 | Derived learning-loop corpus from gate edits; off the clinical path. |
| `ExtractFactLedger` | `FactLedgerProcessor` | 2 | Per-encounter fact ledger + rendered recap after final transcript. |
| `SyncTenantDirectoryUsers` | `DirectorySyncProcessor` | **1** | Admin-triggered IdP directory pre-provisioning. Must stay 1: per-user JIT provisioning inside a transaction with a seat-quota check. |
| `DownloadAiModel` | `AiModelDownloadProcessor` | **1** | Fetch → verify → publish model weights to MinIO, write `AiModel`. Must stay 1: multi-GB job inside a 2Gi memory limit. |
| `AiUsageOutboxDrain` | `UsageOutboxProcessor` | **1** | Periodic scheduler tick; claims due usage-ledger outbox rows. Retry state lives on the row, not in Redis. |
| `TenantCheckpointExport` | `CheckpointExportProcessor` | 1 | Export tenant checkpoint (`create`, `verify-upload`). Streams through its own `pg` connection. |
| `TenantCheckpointRestore` | `CheckpointRestoreProcessor` | 1 | Restore tenant checkpoint while holding the tenant lock. |
| `SendEmail`, `SendSms`, `ReceiveEmail`, `ReceiveSms`, `UserActivity`, `WebCrawler`, `SpeechToText` | — | — | Declared in `JobQueue`; not currently consumed by a gateway `@Processor` (delivery handled by other paths/services). |

## Pool Budget

From [`queue-concurrency.ts`](https://github.com/ArcaAI/project-hope/tree/dev-2.2/packages/applications/src/services/baseServices/redis/queue-concurrency.ts):

- `DEFAULT_PRISMA_PG_MAX = 15` (the value actually applies in the cluster).
- `HTTP_POOL_RESERVATION = 8` connections reserved for in-flight HTTP handlers.
- `WORKER_DB_DUTY_CYCLE = 0.35` — a BullMQ slot holds a connection only while a query is in flight.
- `DB_BOUND_QUEUES` = `AuditLog` (8), `SysEvent` (6), `MineGateEditExemplar` (2), `SyncTenantDirectoryUsers` (1), `AiUsageOutboxDrain` (1) → 18 slots × 0.35 ≈ **6.3** effective connections.
- HTTP reservation 8 + workers ≈ 6.3 = **14.3** of 15 — which is why the numbers are centrally declared, not tunable per queue.
- Queues excluded from the DB budget: `WebhookDelivery` (outbound HTTP), the LLM queues (waiting on `apps/text` HTTP), `DownloadAiModel` (network + MinIO), `IngestKnowledgeDocument` (embedding-bound), and checkpoints (own `pg` connection).

Concurrency is **not** an env var or `GlobalSetting`; it is read once at class-decoration time, before Nest DI exists. Changing a number is a deliberate budget decision pinned by `__tests__/queue-concurrency.test.ts`.

## Enqueue Sources

| Queue | Enqueued from |
|---|---|
| `SysEvent` | `sysEvent.service.ts#queueSysEventJob` on resource create/view/update/delete/archive. |
| `WebhookDelivery` | `WebhookDeliveryProcessor` after matching enabled `Webhook` rows. |
| `AuditLog` | Audit-log service on mutations. |
| `GeneratePreSummary` | `consultation-job.service.ts` (`preSummaryQueue.add('generate', …)`). |
| `GenerateDnaReport` | `dna-writing-style.service.ts` and `dna-regeneration.scheduler.ts`. |
| `IngestKnowledgeDocument` | `knowledge-document.service.ts`; also re-enqueued after checkpoint restore. |
| `MineGateEditExemplar` | `GateEditMiningProcessor`'s enqueue half (`IGateEditMiningQueue`). |
| `ExtractFactLedger` | `FactLedgerProcessor`'s enqueue half; one job per `(consultation, encounter, input digest)`. |
| `SyncTenantDirectoryUsers` | `directory-sync.service.ts`. |
| `DownloadAiModel` | `ai-model-download.service.ts`. |
| `AiUsageOutboxDrain` | `upsertJobScheduler` periodic tick. |
| `TenantCheckpointExport` / `Restore` | `tenant-checkpoint.service.ts`. |

## Delivery Semantics You Should Know

- **Webhook split:** one tenant's slow/failing endpoint retries independently on `WebhookDelivery` without re-delivering to webhooks that already succeeded. `SysEvent` is the matcher, not the sender.
- **Usage outbox:** BullMQ provides only the tick and cross-replica single execution. Retry state (`attempts`, `availableAt`, `lastError`) lives on the outbox row, so a Redis flush or redeploy cannot lose a money-pipeline retry.
- **Checkpoints:** runners record outcomes on the row and do not throw for domain failures; a re-delivery of a finished job is a no-op. Restore holds the tenant lock.
- **Directory sync / model download:** concurrency 1 is a correctness/resource invariant, not an oversight.
- **Worker context:** workers run outside the API's CLS middleware; processors rebind tenant context explicitly (`createWorkerSession`, tenant guards, `assertEqualTenants`).
- **Job tracing:** jobs are enqueued with `attachJobTrace(...)` so trace context crosses the queue boundary.

## Operational Notes

- A Redis configured `noeviction` will grow unboundedly if a queue backs up; that is why `AuditLog`/`SysEvent` concurrency was raised from the BullMQ default of 1.
- Raising worker concurrency spends HTTP headroom. Size `PRISMA_PG_MAX` and the table together, not separately.
- Generated admin portal/OpenAPI artifacts do not describe queues; use this table and the source constants.

## References
- [packages/domains/src/enums/JobQueue.enum.ts](https://github.com/ArcaAI/project-hope/tree/dev-2.2/packages/domains/src/enums/JobQueue.enum.ts)
- [packages/applications/src/services/baseServices/redis/queue-concurrency.ts](https://github.com/ArcaAI/project-hope/tree/dev-2.2/packages/applications/src/services/baseServices/redis/queue-concurrency.ts)
- [packages/applications/src/services/webhook/webhook-delivery.processor.ts](https://github.com/ArcaAI/project-hope/tree/dev-2.2/packages/applications/src/services/webhook/webhook-delivery.processor.ts)
