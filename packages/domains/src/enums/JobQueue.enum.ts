// TODO: move the JobQueue to the application layer as a configuration

export enum JobQueue {
  AuditLog = 'AuditLog',
  UserActivity = 'UserActivity',
  SendEmail = 'SendEmail',
  SendSms = 'SendSms',
  ReceiveEmail = 'ReceiveEmail',
  ReceiveSms = 'ReceiveSms',
  SysEvent = 'SysEvent',
  WebCrawler = 'WebCrawler',

  SpeechToText = 'SpeechToText',

  // Consultation AI Processing Queues
  GeneratePreSummary = 'GeneratePreSummary',
  GenerateSummary = 'GenerateSummary',
  ExtractNamedEntities = 'ExtractNamedEntities',

  // DNA Writing Style Analysis
  GenerateDnaReport = 'GenerateDnaReport',

  // Institutional RAG knowledge corpus
  IngestKnowledgeDocument = 'IngestKnowledgeDocument',

  // Tenant-scoped external identity provider — admin-triggered directory pull
  SyncTenantDirectoryUsers = 'SyncTenantDirectoryUsers',

  // Gate-edit mining — derived learning-loop corpus
  MineGateEditExemplar = 'MineGateEditExemplar',

  // TASK-1001 wave 6 — one delayed job per consultation that is ready to complete; closes it
  // unsigned when nobody approved within the tenant's completion timeout.
  ConsultationCompletionTimeout = 'ConsultationCompletionTimeout',

  // AI usage-ledger outbox drain (promoted from a local
  // constant in packages/applications/src/services/usageLedger/usage-ledger.constants.ts
  // per the outbox-drain handoff).
  AiUsageOutboxDrain = 'AiUsageOutboxDrain',

  // lane L3 — admin-triggered AiModel weight download: fetch from
  // the model's sourceUri (HuggingFace repo or an existing s3:// prefix),
  // verify, publish into the hope-models bucket, and write back the AiModel
  // registry row. See `AiModelDownloadService` / `AiModelDownloadProcessor`.
  DownloadAiModel = 'DownloadAiModel',

  // per-webhook delivery attempts. Deliberately a SEPARATE queue
  // from `SysEvent` — `WebhookDeliveryProcessor` (`@Processor(SysEvent)`)
  // matches a fired SysEvent against subscribed `Webhook` rows and fans out
  // ONE job per matching webhook onto THIS queue, so one tenant's slow/
  // failing endpoint retries independently (its own `attempts`/backoff)
  // without ever re-delivering to webhooks that already succeeded — see
  // webhook-delivery.processor.ts for the split rationale.
  WebhookDelivery = 'WebhookDelivery',

  // Tenant checkpoints — consumed ONLY by the separate checkpoint-worker
  // process. Export carries two job kinds (create, verify-upload); restore
  // holds the tenant lock for its whole run. Both stream through their own
  // `pg` connection, so neither is DB-bound on the shared Prisma pool.
  TenantCheckpointExport = 'TenantCheckpointExport',
  TenantCheckpointRestore = 'TenantCheckpointRestore',

  // Per-encounter fact ledger (and its rendered recap), built after the
  // encounter's final transcript lands.
  ExtractFactLedger = 'ExtractFactLedger',
}
