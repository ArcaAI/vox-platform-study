import { Module } from '@nestjs/common';
import { ClsModule } from 'nestjs-cls';
import { CoreUnitOfWorkService } from '../../unitsOfWork/core/core.unitOfWork';
import { CoreDatabaseService, VAULT_PRISMA_FACTORY, type VaultPrismaFactory } from './core.database.service';

import { AgentTrajectoryStepRepository } from '../../../repositories/generated/core/AgentTrajectoryStepRepository';
import { AiModelRepository } from '../../../repositories/generated/core/AiModelRepository';
import { AiPriceBookRepository } from '../../../repositories/generated/core/AiPriceBookRepository';
import { AiProviderConnectionRepository } from '../../../repositories/generated/core/AiProviderConnectionRepository';
import { WorkflowWebhookSecretRepository } from '../../../repositories/generated/core/WorkflowWebhookSecretRepository';
import { ServiceAccountRepository } from '../../../repositories/generated/core/ServiceAccountRepository';
import { AiRoutingPolicyRepository } from '../../../repositories/generated/core/AiRoutingPolicyRepository';
import { RateLimitRuleRepository } from '../../../repositories/generated/core/RateLimitRuleRepository';
import { AiUsageEventRepository } from '../../../repositories/generated/core/AiUsageEventRepository';
import { TenantPlanHistoryRepository } from '../../../repositories/generated/core/TenantPlanHistoryRepository';
import { AiUsageOutboxRepository } from '../../../repositories/generated/core/AiUsageOutboxRepository';
import { AiUsageRollupDailyRepository } from '../../../repositories/generated/core/AiUsageRollupDailyRepository';
import { ServiceReleaseRepository } from '../../../repositories/generated/core/ServiceReleaseRepository';
import { ServiceInstanceRepository } from '../../../repositories/generated/core/ServiceInstanceRepository';
import { ChangelogEntryRepository } from '../../../repositories/generated/core/ChangelogEntryRepository';
import { UserChangelogAcknowledgementRepository } from '../../../repositories/generated/core/UserChangelogAcknowledgementRepository';
import { ConsentGrantRepository } from '../../../repositories/generated/core/ConsentGrantRepository';
import { AiUsageRollupHourlyRepository } from '../../../repositories/generated/core/AiUsageRollupHourlyRepository';
import { BillingAdjustmentRepository } from '../../../repositories/generated/core/BillingAdjustmentRepository';
import { BillingInvoiceLineRepository } from '../../../repositories/generated/core/BillingInvoiceLineRepository';
import { BillingInvoiceRepository } from '../../../repositories/generated/core/BillingInvoiceRepository';
import { GateEditExemplarRepository } from '../../../repositories/generated/core/GateEditExemplarRepository';
import { AgentPromotionRepository } from '../../../repositories/generated/core/AgentPromotionRepository';
import { ApiKeyRepository } from '../../../repositories/generated/core/ApiKeyRepository';
import { AsrPipelineRepository } from '../../../repositories/generated/core/AsrPipelineRepository';
import { AsrPipelineVersionRepository } from '../../../repositories/generated/core/AsrPipelineVersionRepository';
import { AudioRecordingRepository } from '../../../repositories/generated/core/AudioRecordingRepository';
import { AuditLogRepository } from '../../../repositories/generated/core/AuditLogRepository';
import { ConsultationRepository } from '../../../repositories/generated/core/ConsultationRepository';
import { ConsultationContextSchemaRepository } from '../../../repositories/generated/core/ConsultationContextSchemaRepository';
import { ConsultationContextSchemaVersionRepository } from '../../../repositories/generated/core/ConsultationContextSchemaVersionRepository';
import { DocumentTemplateRepository } from '../../../repositories/generated/core/DocumentTemplateRepository';
import { DocumentTemplateVersionRepository } from '../../../repositories/generated/core/DocumentTemplateVersionRepository';
import { ContextItemRepository } from '../../../repositories/generated/core/ContextItemRepository';
import { ContextItemVersionRepository } from '../../../repositories/generated/core/ContextItemVersionRepository';
import { DepartmentRepository } from '../../../repositories/generated/core/DepartmentRepository';
import { DnaUsageRecordRepository } from '../../../repositories/generated/core/DnaUsageRecordRepository';
import { DnaWritingStyleReportRepository } from '../../../repositories/generated/core/DnaWritingStyleReportRepository';
import { DnaWritingStyleVersionRepository } from '../../../repositories/generated/core/DnaWritingStyleVersionRepository';
import { EvalRunRepository } from '../../../repositories/generated/core/EvalRunRepository';
import { EvalScoreRepository } from '../../../repositories/generated/core/EvalScoreRepository';
import { FederatedIdentityRepository } from '../../../repositories/generated/core/FederatedIdentityRepository';
import { GlobalSettingRepository } from '../../../repositories/generated/core/GlobalSettingRepository';
import { GoldenCaseRepository } from '../../../repositories/generated/core/GoldenCaseRepository';
import { GoldenSetRepository } from '../../../repositories/generated/core/GoldenSetRepository';
import { HarnessAuditEventRepository } from '../../../repositories/generated/core/HarnessAuditEventRepository';
import { HarnessPolicyChangeRepository } from '../../../repositories/generated/core/HarnessPolicyChangeRepository';
import { HarnessPolicyRepository } from '../../../repositories/generated/core/HarnessPolicyRepository';
import { HighlightRepository } from '../../../repositories/generated/core/HighlightRepository';
import { KnowledgeChunkRepository } from '../../../repositories/generated/core/KnowledgeChunkRepository';
import { KnowledgeDocumentRepository } from '../../../repositories/generated/core/KnowledgeDocumentRepository';
import { McpServerRepository } from '../../../repositories/generated/core/McpServerRepository';
import { MediaRepository } from '../../../repositories/generated/core/MediaRepository';
import { NamedEntityRepository } from '../../../repositories/generated/core/NamedEntityRepository';
import { NotificationRepository } from '../../../repositories/generated/core/NotificationRepository';
import { PasswordResetTokenRepository } from '../../../repositories/generated/core/PasswordResetTokenRepository';
import { PermissionRepository } from '../../../repositories/generated/core/PermissionRepository';
import { PlanEntitlementRepository } from '../../../repositories/generated/core/PlanEntitlementRepository';
import { PromptTemplateRepository } from '../../../repositories/generated/core/PromptTemplateRepository';
import { PromptUsageRecordRepository } from '../../../repositories/generated/core/PromptUsageRecordRepository';
import { PromptVersionRepository } from '../../../repositories/generated/core/PromptVersionRepository';
import { ResourceSubscriptionRepository } from '../../../repositories/generated/core/ResourceSubscriptionRepository';
import { RolePermissionRepository } from '../../../repositories/generated/core/RolePermissionRepository';
import { RoleRepository } from '../../../repositories/generated/core/RoleRepository';
import { StorageAccessKeyRepository } from '../../../repositories/generated/core/StorageAccessKeyRepository';
import { SummaryMetaRepository } from '../../../repositories/generated/core/SummaryMetaRepository';
import { TagRepository } from '../../../repositories/generated/core/TagRepository';
import { TenantAllowedOriginRepository } from '../../../repositories/generated/core/TenantAllowedOriginRepository';
import { TenantBucketRepository } from '../../../repositories/generated/core/TenantBucketRepository';
import { TenantEntitlementRepository } from '../../../repositories/generated/core/TenantEntitlementRepository';
import { TenantFrontendConfigRepository } from '../../../repositories/generated/core/TenantFrontendConfigRepository';
import { TenantIdentityProviderRepository } from '../../../repositories/generated/core/TenantIdentityProviderRepository';
import { TenantIdentityProviderDomainRepository } from '../../../repositories/generated/core/TenantIdentityProviderDomainRepository';
import { TenantNlpTaskInstructionsRepository } from '../../../repositories/generated/core/TenantNlpTaskInstructionsRepository';
import { TenantRepository } from '../../../repositories/generated/core/TenantRepository';
import { TenantStorageConfigRepository } from '../../../repositories/generated/core/TenantStorageConfigRepository';
import { TenantGuardrailPolicyRepository } from '../../../repositories/generated/core/TenantGuardrailPolicyRepository';
import { TenantSttConfigRepository } from '../../../repositories/generated/core/TenantSttConfigRepository';
import { TenantUsageMeterRepository } from '../../../repositories/generated/core/TenantUsageMeterRepository';
import { TranscriptionJobRepository } from '../../../repositories/generated/core/TranscriptionJobRepository';
import { DocumentSectionRepository } from '../../../repositories/generated/core/DocumentSectionRepository';
import { TranscriptSegmentRepository } from '../../../repositories/generated/core/TranscriptSegmentRepository';
import { UserDepartmentRepository } from '../../../repositories/generated/core/UserDepartmentRepository';
import { UserMediaRepository } from '../../../repositories/generated/core/UserMediaRepository';
import { UserProfileRepository } from '../../../repositories/generated/core/UserProfileRepository';
import { UserRepository } from '../../../repositories/generated/core/UserRepository';
import { UserRoleAssignmentRepository } from '../../../repositories/generated/core/UserRoleAssignmentRepository';
import { UserSettingsRepository } from '../../../repositories/generated/core/UserSettingsRepository';
import { UserVoiceProfileRepository } from '../../../repositories/generated/core/UserVoiceProfileRepository';
import { WebhookRepository } from '../../../repositories/generated/core/WebhookRepository';
import { WebhookRunHistoryRepository } from '../../../repositories/generated/core/WebhookRunHistoryRepository';
import { WorkflowRunRepository } from '../../../repositories/generated/core/WorkflowRunRepository';
import { WorkflowDefinitionRepository } from '../../../repositories/generated/core/WorkflowDefinitionRepository';
import { WorkflowAssignmentRepository } from '../../../repositories/generated/core/WorkflowAssignmentRepository';
import { WorkflowAssignmentChangeRepository } from '../../../repositories/generated/core/WorkflowAssignmentChangeRepository';
import { AgentRepository } from '../../../repositories/generated/core/AgentRepository';
import { AgentModelFallbackRepository } from '../../../repositories/generated/core/AgentModelFallbackRepository';
import { AgentAssignmentRepository } from '../../../repositories/generated/core/AgentAssignmentRepository';
import { AgentAssignmentChangeRepository } from '../../../repositories/generated/core/AgentAssignmentChangeRepository';
import { WorkflowTestFixtureRepository } from '../../../repositories/generated/core/WorkflowTestFixtureRepository';
import { WorkflowInvariantRuleRepository } from '../../../repositories/generated/core/WorkflowInvariantRuleRepository';

// Async provider so the (possibly Vault-backed) Prisma client
// is fully resolved BEFORE the service is injected into the UnitOfWork /
// repositories / AppSettingsService graph. With the previous `useClass` form
// the Vault client was only set in onModuleInit, so consumers that touch the
// DB during construction or their own onModuleInit observed an undefined
// client. apps/api's VaultPrismaFactoryModule always binds VAULT_PRISMA_FACTORY,
// but only resolves it to a real factory fn when PG_DYNAMIC_CREDS=true &&
// SECRETS_PROVIDER=vault; otherwise the token resolves to null. In test/non-api
// graphs the token is absent entirely, so `optional: true` yields undefined.
// Either way (null | undefined) the service falls back to the env-mode singletons.
const databaseProvider = {
  provide: 'CORE_DATABASE_SERVICE',
  useFactory: async (vaultFactory?: VaultPrismaFactory) => {
    const service = new CoreDatabaseService(vaultFactory);
    await service.ensureInitialized();
    return service;
  },
  inject: [{ token: VAULT_PRISMA_FACTORY, optional: true }],
};

const repositories = [
  // Consultation domain
  ConsultationRepository,
  // Tenant-declared consultation context schema plane: the mutable
  // head and its immutable published version snapshots.
  ConsultationContextSchemaRepository,
  ConsultationContextSchemaVersionRepository,
  // Clinical-document SHAPE catalog: the mutable head and its
  // immutable published version snapshots (shape + compiled artifacts).
  DocumentTemplateRepository,
  DocumentTemplateVersionRepository,
  ContextItemRepository,
  ContextItemVersionRepository,
  AudioRecordingRepository,
  SummaryMetaRepository,
  NamedEntityRepository,
  // per-section rows of a live-generated clinical document
  DocumentSectionRepository,
  // segment-level transcript structure (per-transcript annotation)
  TranscriptSegmentRepository,
  // Manual doctor highlighting
  HighlightRepository,
  // Core domain
  GlobalSettingRepository,
  McpServerRepository,
  MediaRepository,
  NotificationRepository,
  PermissionRepository,
  ResourceSubscriptionRepository,
  RolePermissionRepository,
  RoleRepository,
  TagRepository,
  TenantRepository,
  TenantFrontendConfigRepository,
  // Plan entitlements — per-plan matrix, per-tenant override, rolling meters
  PlanEntitlementRepository,
  TenantEntitlementRepository,
  TenantUsageMeterRepository,
  UserMediaRepository,
  UserProfileRepository,
  UserRepository,
  // Password security — revocable single-use reset tokens
  PasswordResetTokenRepository,
  UserDepartmentRepository,
  UserRoleAssignmentRepository,
  UserSettingsRepository,
  WebhookRepository,
  WebhookRunHistoryRepository,
  // STT domain
  AsrPipelineRepository,
  AsrPipelineVersionRepository,
  AiModelRepository,
  // Tenant-writable nlp.topic/nlp.intent instruction content —
  // deliberately separate from the routing-policy model-selection governance.
  TenantNlpTaskInstructionsRepository,
  GateEditExemplarRepository,
  // Config-plane core — provider endpoints/credentials + runtime
  // hyperparameter profiles. Both are SYSTEM-shared read models.
  AiProviderConnectionRepository,
  // TASK-864 — the inbound workflow webhook trigger's per-definition secret.
  WorkflowWebhookSecretRepository,
  // The ordered N-way candidate chain per (tenant, taskKey, policyVersion)
  // Also a SYSTEM_SHARED_READ_MODEL — the SYSTEM row is the
  // platform default every tenant without its own policy must read.
  AiRoutingPolicyRepository,
  TranscriptionJobRepository,
  // Audit domain
  AuditLogRepository,
  // API & Organization domain
  ApiKeyRepository,
  // Platform-issued machine identity for administration — the
  // THIRD credential class, sharing no mechanism with ApiKey or the shared
  // peer-service token.
  ServiceAccountRepository,
  DepartmentRepository,
  // Immutable, WORM records of cross-tenant workflow promotions
  AgentPromotionRepository,
  // Prompt & DNA domain
  PromptTemplateRepository,
  PromptVersionRepository,
  DnaWritingStyleReportRepository,
  DnaWritingStyleVersionRepository,
  DnaUsageRecordRepository,
  PromptUsageRecordRepository,
  // Storage domain
  // CORS control plane — browser-origin allow-list.
  TenantAllowedOriginRepository,
  TenantBucketRepository,
  StorageAccessKeyRepository,
  TenantStorageConfigRepository,
  // Per-tenant guardrail AVAILABILITY (TASK-886) — WHICH screening
  // policies apply to a tenant. Platform-managed and super-admin-only; the
  // SYSTEM row is the default set every tenant inherits on absence.
  TenantGuardrailPolicyRepository,
  // Voice profile domain
  UserVoiceProfileRepository,
  // Per-tenant STT configuration (credential rows live in the unified
  // AiProviderConnection plane, service='stt' — dropped
  // TenantSttProviderCredential)
  TenantSttConfigRepository,
  // Per-tenant TTS configuration (credential rows live in the unified
  // AiProviderConnection plane, service='tts' — dropped
  // TenantTtsProviderCredential)
  // Clinical documentation harness domain
  GoldenSetRepository,
  GoldenCaseRepository,
  EvalRunRepository,
  EvalScoreRepository,
  HarnessAuditEventRepository,
  // Agentic SOTA ordered session trajectory — tenant-scoped
  // ops telemetry, soft-delete + sys-event exempt (see repository/entity docs).
  AgentTrajectoryStepRepository,
  // Harness Administration Console — editable runtime policy
  HarnessPolicyRepository,
  HarnessPolicyChangeRepository,
  // Institutional RAG knowledge corpus
  KnowledgeDocumentRepository,
  KnowledgeChunkRepository,
  // Tenant-scoped external identity provider
  TenantIdentityProviderRepository,
  FederatedIdentityRepository,
  TenantIdentityProviderDomainRepository,
  // AI usage metering plane. The ledger, its transactional outbox
  // and the two rollups are tenant-scoped APPEND-ONLY facts — soft-delete and
  // sys-event exempt (see the repository/entity docs). AiPriceBook is the one
  // admin-managed model of the plane: standard lifecycle, sys-events, and a
  // SYSTEM-shared read model so every tenant's rater can resolve the platform
  // rate card.
  AiUsageEventRepository,
  AiUsageOutboxRepository,
  AiUsageRollupHourlyRepository,
  AiUsageRollupDailyRepository,
  AiPriceBookRepository,
  // Tenant billing plane. BillingInvoice is the ONE
  // OCC-written model of the plane (draft edits + the immutable FINALIZE
  // transition); BillingAdjustment is append-only — a credit memo against a
  // finalized period cannot be retracted by deletion.
  BillingInvoiceRepository,
  BillingInvoiceLineRepository,
  BillingAdjustmentRepository,
  // Append-only plan-change facts feeding the invoice engine's plan-fee basis
  // (no soft delete, no sys-events — see the repository doc).
  TenantPlanHistoryRepository,
  // Service Version & Release Registry. ServiceRelease is
  // immutable build facts; ServiceInstance is a heartbeated runtime
  // observation (no soft delete). ChangelogEntry is the one human-edited, OCC
  // model; UserChangelogAcknowledgement is its per-user ack trail.
  ServiceReleaseRepository,
  ServiceInstanceRepository,
  ChangelogEntryRepository,
  UserChangelogAcknowledgementRepository,
  // Consent & ABAC. No enforcement wired anywhere this phase

  ConsentGrantRepository,
  // Runs/observability read model — one row per workflow-substrate run.
  WorkflowRunRepository,
  // Per-tenant saved synthetic Workbench test input.
  WorkflowTestFixtureRepository,
  // The workflow-definition/version rows themselves ( domain trio,
  // completed under — see that for why).
  WorkflowDefinitionRepository,
  // Per-scope workflow assignment + its append-only WORM change log.
  WorkflowAssignmentRepository,
  WorkflowAssignmentChangeRepository,
  // TASK-863 — the first-class Agent substrate.
  AgentRepository,
  AgentModelFallbackRepository,
  AgentAssignmentRepository,
  AgentAssignmentChangeRepository,
  // Workflow-graph safety rule rows — a SYSTEM_SHARED_READ_MODEL,
  // see tenant-scope.ts for why.
  WorkflowInvariantRuleRepository,
  // Rate-limit rule rows — ranks 1, 2 and 4 of the rate-limit
  // precedence chain. Tenant-scoped but NOT a SYSTEM_SHARED_READ_MODEL; see
  // tenant-scope.ts and RateLimitRuleRepository for why.
  RateLimitRuleRepository,
];

@Module({
  imports: [ClsModule],
  providers: [databaseProvider, CoreUnitOfWorkService, ...repositories],
  exports: [databaseProvider, CoreUnitOfWorkService, ...repositories],
})
export class CoreDatabaseModule {}
