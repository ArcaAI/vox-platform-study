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
}
