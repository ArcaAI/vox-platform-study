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
  // RETAINED after retired `DepartmentAgent` itself. Nothing
  // broadcasts this `resourceType` any more, but historical `AuditLog` rows
  // carry it and audit history is immutable on a PHI platform — and PostgreSQL
  // cannot drop an enum value without rewriting the table that uses it. Kept in
  // LOCKSTEP with `audit.prisma`, which `resourceType.enum-parity.test.ts`
  // asserts in both directions. Not a dangling member to tidy up.
  DepartmentAgent = 'DepartmentAgent',
  // Eval run: the eval-gated-promotion runner broadcasts
  // ResourceCreated per persisted EvalRun. Parity with audit.prisma.
  EvalRun = 'EvalRun',
  // Per-tenant STT fallback config.
  // Parity with audit.prisma; see resourceType.enum-parity.test.ts.
  TenantSttConfig = 'TenantSttConfig',
  // HARMLESS-UNUSED: the `TenantSttProviderCredential` table and
  // its domain trio were dropped — credential rows now live in the unified
  // `AiProviderConnection` plane (service='stt'). Postgres cannot cheaply
  // drop a value from an enum type already in use elsewhere in this column,
  // so this member is kept, deliberately never emitted again, purely to keep
  // this TS enum in parity with the `ResourceType` enum in audit.prisma (see
  // resourceType.enum-parity.test.ts). Do not remove without also dropping
  // it from audit.prisma via a reviewed enum-value migration.
  TenantSttProviderCredential = 'TenantSttProviderCredential',
  // CORS control plane: tenant-owned browser origin registry.
  // Parity with audit.prisma; see resourceType.enum-parity.test.ts.
  TenantAllowedOrigin = 'TenantAllowedOrigin',
  // Usage metering + billing. Only the three ADMIN-MANAGED models
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
  // Consultation context schema — the MUTABLE head row is the
  // audited resource. `ConsultationContextSchemaVersion` is deliberately NOT
  // a ResourceType (immutable snapshot written as part of its parent's
  // publish; the PromptVersion precedent). Parity with audit.prisma; see
  // resourceType.enum-parity.test.ts.
  ConsultationContextSchema = 'ConsultationContextSchema',
  // Agent promotion between tenants — its own audited resource,
  // unlike the immutable version rows: one promotion is one event with a
  // lifecycle of its own, it crosses a tenant boundary, and
  // `AgentPromotionService` broadcasts `ResourceCreated` against it. Parity
  // with audit.prisma.
  AgentPromotion = 'AgentPromotion',
  WorkflowDefinition = 'WorkflowDefinition',
  ConsentGrant = 'ConsentGrant',
  // Workflow test fixture. Ordinary CRUD, unlike sibling
  // WorkflowRun: see the TASK-864 entry at the end of this enum.
  WorkflowTestFixture = 'WorkflowTestFixture',
  // Tenant NLP task instructions — tenant-writable topic/intent
  // instruction content, deliberately separate from AiTaskDefault's
  // model-selection governance. Parity with audit.prisma.
  TenantNlpTaskInstructions = 'TenantNlpTaskInstructions',
  // Institutional-RAG knowledge document — the mutable head row
  // is the audited resource; KnowledgeChunk is deliberately NOT its own
  // ResourceType (see audit.prisma). Parity with audit.prisma; see
  // resourceType.enum-parity.test.ts.
  KnowledgeDocument = 'KnowledgeDocument',
  ServiceAccount = 'ServiceAccount',
  // Per-scope workflow assignment — WHICH workflow definition
  // governs a tenant/department for a palette. Its own audited resource:
  // WorkflowAssignmentService broadcasts on every mutation, and the
  // assignment is a governance act distinct from the definition it points
  // at. Parity with audit.prisma; see resourceType.enum-parity.test.ts.
  WorkflowAssignment = 'WorkflowAssignment',
  // Workflow-graph safety rule — a SYSTEM-tenant row is the
  // platform invariant register made executable; a tenant row may only ADD
  // strictness. Parity with audit.prisma; see resourceType.enum-parity.test.ts.
  WorkflowInvariantRule = 'WorkflowInvariantRule',
  // Rate-limit rule — a SYSTEM-tenant row is a platform-wide
  // per-route limit; a customer-tenant row overrides it for that tenant alone.
  // Parity with audit.prisma; see resourceType.enum-parity.test.ts.
  RateLimitRule = 'RateLimitRule',
  // Clinical-document shape catalog — the MUTABLE head row is the
  // audited resource. `DocumentTemplateVersion` is deliberately NOT a
  // ResourceType (an immutable snapshot written as part of its parent's
  // publish; the ConsultationContextSchemaVersion / PromptVersion precedent).
  // Parity with audit.prisma; see resourceType.enum-parity.test.ts.
  DocumentTemplate = 'DocumentTemplate',
  // Provider routing policy — a policy change can redirect PHI to a
  // different vendor, so every mutation is audited under HIPAA
  // Each AUTHORED revision is another row of the same resource (the
  // `policyVersion` natural key), not a ResourceType of its own.
  // Parity with audit.prisma; see resourceType.enum-parity.test.ts.
  AiRoutingPolicy = 'AiRoutingPolicy',
  // TASK-864 (owner decision D-5) — the run read model emits ONE sys-event, on
  // terminal status, so a run-completed webhook can fan out (PHI-free payload).
  // Reverses the telemetry exemption. Parity with audit.prisma; see
  // resourceType.enum-parity.test.ts. APPEND-ONLY (TASK-863 appends `Agent`,
  // `AgentAssignment` in a sibling branch).
  WorkflowRun = 'WorkflowRun',
}
