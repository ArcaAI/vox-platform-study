/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */

export enum ResourceType {
  AuditLog = 'AuditLog',
  ApiKey = 'ApiKey',
  Department = 'Department',
  GlobalSetting = 'GlobalSetting',
  IntegrationPackage = 'IntegrationPackage',
  IntegrationItem = 'IntegrationItem',
  Media = 'Media',
  Notification = 'Notification',
  ResourceSubscription = 'ResourceSubscription',
  Role = 'Role',
  Permission = 'Permission',
  RolePermission = 'RolePermission',
  Tag = 'Tag',
  Tenant = 'Tenant',
  UserRoleAssignment = 'UserRoleAssignment',
  User = 'User',
  UserSettings = 'UserSettings',
  UserProfile = 'UserProfile',
  UserMedia = 'UserMedia',
  Webhook = 'Webhook',
  WebhookRunHistory = 'WebhookRunHistory',
  Consultation = 'Consultation',
  ContextItem = 'ContextItem',
  ContextItemVersion = 'ContextItemVersion',
  AudioRecording = 'AudioRecording',
  SummaryMeta = 'SummaryMeta',
  NamedEntity = 'NamedEntity',
  AsrPipeline = 'AsrPipeline',
  AiModel = 'AiModel',
  TranscriptionJob = 'TranscriptionJob',
  PromptTemplate = 'PromptTemplate',
  DnaWritingStyleReport = 'DnaWritingStyleReport',
  TenantBucket = 'TenantBucket',
  StorageAccessKey = 'StorageAccessKey',
  TenantStorageConfig = 'TenantStorageConfig',
  Highlight = 'Highlight',
  AsrPipelineVersion = 'AsrPipelineVersion',
  UserVoiceProfile = 'UserVoiceProfile',
  UserDepartment = 'UserDepartment',
  TenantFrontendConfig = 'TenantFrontendConfig',
  TenantTtsConfig = 'TenantTtsConfig',
  TenantIdentityProvider = 'TenantIdentityProvider',
  FederatedIdentity = 'FederatedIdentity',
  AiTaskDefault = 'AiTaskDefault',
  McpServer = 'McpServer',
  // Config-plane core (kept in lock-step with the database enum in
  // audit.prisma; see resourceType.enum-parity.test.ts).
  AiProviderConnection = 'AiProviderConnection',
  AiRuntimeProfile = 'AiRuntimeProfile',
  // Gate-edit mining store (parity with audit.prisma; see
  // resourceType.enum-parity.test.ts).
  GateEditExemplar = 'GateEditExemplar',
  DepartmentAgent = 'DepartmentAgent',
  // Eval run (TASK-549): the eval-gated-promotion runner broadcasts
  // ResourceCreated per persisted EvalRun. Parity with audit.prisma.
  EvalRun = 'EvalRun',
  // Per-tenant STT fallback config (TASK-567).
  // Parity with audit.prisma; see resourceType.enum-parity.test.ts.
  TenantSttConfig = 'TenantSttConfig',
  // HARMLESS-UNUSED (TASK-576): the `TenantSttProviderCredential` table and
  // its domain trio were dropped — credential rows now live in the unified
  // `AiProviderConnection` plane (service='stt'). Postgres cannot cheaply
  // drop a value from an enum type already in use elsewhere in this column,
  // so this member is kept, deliberately never emitted again, purely to keep
  // this TS enum in parity with the `ResourceType` enum in audit.prisma (see
  // resourceType.enum-parity.test.ts). Do not remove without also dropping
  // it from audit.prisma via a reviewed enum-value migration.
  TenantSttProviderCredential = 'TenantSttProviderCredential',
  // CORS control plane (TASK-610): tenant-owned browser origin registry.
  // Parity with audit.prisma; see resourceType.enum-parity.test.ts.
  TenantAllowedOrigin = 'TenantAllowedOrigin',
  // Usage metering + billing (TASK-615). Only the three ADMIN-MANAGED models
  // of that plane emit sys-events: rate-card edits, the invoice lifecycle
  // (draft → finalize → void), and credit memos. The append-only ledger, its
  // outbox, the rollups and invoice LINES deliberately have no ResourceType —
  // see the matching commentary in audit.prisma. Parity with audit.prisma; see
  // resourceType.enum-parity.test.ts.
  AiPriceBook = 'AiPriceBook',
  BillingInvoice = 'BillingInvoice',
  BillingAdjustment = 'BillingAdjustment',
  ServiceRelease = 'ServiceRelease',
  ServiceInstance = 'ServiceInstance',
  ChangelogEntry = 'ChangelogEntry',
  UserChangelogAcknowledgement = 'UserChangelogAcknowledgement',
  // Consultation context schema (TASK-658) — the MUTABLE head row is the
  // audited resource. `ConsultationContextSchemaVersion` is deliberately NOT
  // a ResourceType (immutable snapshot written as part of its parent's
  // publish; the PromptVersion precedent). Parity with audit.prisma; see
  // resourceType.enum-parity.test.ts.
  ConsultationContextSchema = 'ConsultationContextSchema',
  // Agent promotion between tenants (TASK-663) — its own audited resource,
  // unlike the immutable version rows: one promotion is one event with a
  // lifecycle of its own, it crosses a tenant boundary, and
  // `AgentPromotionService` broadcasts `ResourceCreated` against it. Parity
  // with audit.prisma.
  AgentPromotion = 'AgentPromotion',
}
