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
  GenerateComprehensiveSummary = 'GenerateComprehensiveSummary',
  ExtractNamedEntities = 'ExtractNamedEntities',

  // DNA Writing Style Analysis
  GenerateDnaReport = 'GenerateDnaReport',

  // Institutional RAG knowledge corpus
  IngestKnowledgeDocument = 'IngestKnowledgeDocument',

  // Tenant-scoped external identity provider — admin-triggered directory pull
  SyncTenantDirectoryUsers = 'SyncTenantDirectoryUsers',

  // Gate-edit mining — derived learning-loop corpus
  MineGateEditExemplar = 'MineGateEditExemplar',

  // AI usage-ledger outbox drain (promoted from a local
  // constant in packages/applications/src/services/usageLedger/usage-ledger.constants.ts
  // per the outbox-drain handoff).
  AiUsageOutboxDrain = 'AiUsageOutboxDrain',

  // TASK-727: per-webhook delivery attempts. Deliberately a SEPARATE queue
  // from `SysEvent` — `WebhookDeliveryProcessor` (`@Processor(SysEvent)`)
  // matches a fired SysEvent against subscribed `Webhook` rows and fans out
  // ONE job per matching webhook onto THIS queue, so one tenant's slow/
  // failing endpoint retries independently (its own `attempts`/backoff)
  // without ever re-delivering to webhooks that already succeeded — see
  // webhook-delivery.processor.ts for the split rationale.
  WebhookDelivery = 'WebhookDelivery',
}
