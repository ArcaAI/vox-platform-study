import { Module } from '@nestjs/common';
import { ClsModule } from 'nestjs-cls';
import { CoreUnitOfWorkService } from '../../unitsOfWork/core/core.unitOfWork';
import { CoreDatabaseService, VAULT_PRISMA_FACTORY, type VaultPrismaFactory } from './core.database.service';

import { AgentTrajectoryStepRepository } from '../../../repositories/generated/core/AgentTrajectoryStepRepository';
import { AiModelRepository } from '../../../repositories/generated/core/AiModelRepository';
import { AiTaskDefaultRepository } from '../../../repositories/generated/core/AiTaskDefaultRepository';
import { ApiKeyRepository } from '../../../repositories/generated/core/ApiKeyRepository';
import { AsrPipelineRepository } from '../../../repositories/generated/core/AsrPipelineRepository';
import { AsrPipelineVersionRepository } from '../../../repositories/generated/core/AsrPipelineVersionRepository';
import { AudioRecordingRepository } from '../../../repositories/generated/core/AudioRecordingRepository';
import { AuditLogRepository } from '../../../repositories/generated/core/AuditLogRepository';
import { ConsultationRepository } from '../../../repositories/generated/core/ConsultationRepository';
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
import { PipelinePolicyChangeRepository } from '../../../repositories/generated/core/PipelinePolicyChangeRepository';
import { PipelinePolicyRepository } from '../../../repositories/generated/core/PipelinePolicyRepository';
import { PromptTemplateRepository } from '../../../repositories/generated/core/PromptTemplateRepository';
import { PromptUsageRecordRepository } from '../../../repositories/generated/core/PromptUsageRecordRepository';
import { PromptVersionRepository } from '../../../repositories/generated/core/PromptVersionRepository';
import { ResourceSubscriptionRepository } from '../../../repositories/generated/core/ResourceSubscriptionRepository';
import { RolePermissionRepository } from '../../../repositories/generated/core/RolePermissionRepository';
import { RoleRepository } from '../../../repositories/generated/core/RoleRepository';
import { StorageAccessKeyRepository } from '../../../repositories/generated/core/StorageAccessKeyRepository';
import { SummaryMetaRepository } from '../../../repositories/generated/core/SummaryMetaRepository';
import { TagRepository } from '../../../repositories/generated/core/TagRepository';
import { TenantBucketRepository } from '../../../repositories/generated/core/TenantBucketRepository';
import { TenantEntitlementRepository } from '../../../repositories/generated/core/TenantEntitlementRepository';
import { TenantFrontendConfigRepository } from '../../../repositories/generated/core/TenantFrontendConfigRepository';
import { TenantIdentityProviderRepository } from '../../../repositories/generated/core/TenantIdentityProviderRepository';
import { TenantIdentityProviderDomainRepository } from '../../../repositories/generated/core/TenantIdentityProviderDomainRepository';
import { TenantRepository } from '../../../repositories/generated/core/TenantRepository';
import { TenantStorageConfigRepository } from '../../../repositories/generated/core/TenantStorageConfigRepository';
import { TenantTtsConfigRepository } from '../../../repositories/generated/core/TenantTtsConfigRepository';
import { TenantTtsProviderCredentialRepository } from '../../../repositories/generated/core/TenantTtsProviderCredentialRepository';
import { TenantUsageMeterRepository } from '../../../repositories/generated/core/TenantUsageMeterRepository';
import { TranscriptionJobRepository } from '../../../repositories/generated/core/TranscriptionJobRepository';
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

// TASK-312 A.5 — async provider so the (possibly Vault-backed) Prisma client
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
  ContextItemRepository,
  ContextItemVersionRepository,
  AudioRecordingRepository,
  SummaryMetaRepository,
  NamedEntityRepository,
  // segment-level transcript structure (per-transcript annotation)
  TranscriptSegmentRepository,
  // TASK-344 Workstream B — manual doctor highlighting
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
  // Plan entitlements (TASK-392) — per-plan matrix, per-tenant override, rolling meters
  PlanEntitlementRepository,
  TenantEntitlementRepository,
  TenantUsageMeterRepository,
  UserMediaRepository,
  UserProfileRepository,
  UserRepository,
  // Password security (TASK-400) — revocable single-use reset tokens
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
  // Per-tenant AI task-model defaults (TASK-506)
  AiTaskDefaultRepository,
  TranscriptionJobRepository,
  // Audit domain
  AuditLogRepository,
  // API & Organization domain
  ApiKeyRepository,
  DepartmentRepository,
  // Prompt & DNA domain
  PromptTemplateRepository,
  PromptVersionRepository,
  DnaWritingStyleReportRepository,
  DnaWritingStyleVersionRepository,
  DnaUsageRecordRepository,
  PromptUsageRecordRepository,
  // Storage domain
  TenantBucketRepository,
  StorageAccessKeyRepository,
  TenantStorageConfigRepository,
  // Voice profile domain
  UserVoiceProfileRepository,
  // Per-tenant TTS configuration (TASK-496)
  TenantTtsConfigRepository,
  TenantTtsProviderCredentialRepository,
  // Clinical documentation harness domain (TASK-330 Phase 0)
  GoldenSetRepository,
  GoldenCaseRepository,
  EvalRunRepository,
  EvalScoreRepository,
  HarnessAuditEventRepository,
  // Agentic SOTA ordered session trajectory — tenant-scoped
  // ops telemetry, soft-delete + sys-event exempt (see repository/entity docs).
  AgentTrajectoryStepRepository,
  // Harness Administration Console — editable runtime policy (TASK-330 Phase 6)
  HarnessPolicyRepository,
  HarnessPolicyChangeRepository,
  // Realtime-pipeline policy cascade (TASK-356 Phase 5, Pillar B)
  PipelinePolicyRepository,
  PipelinePolicyChangeRepository,
  // Institutional RAG knowledge corpus (TASK-330 Phase 3)
  KnowledgeDocumentRepository,
  KnowledgeChunkRepository,
  // Tenant-scoped external identity provider (TASK-498)
  TenantIdentityProviderRepository,
  FederatedIdentityRepository,
  TenantIdentityProviderDomainRepository,
];

@Module({
  imports: [ClsModule],
  providers: [databaseProvider, CoreUnitOfWorkService, ...repositories],
  exports: [databaseProvider, CoreUnitOfWorkService, ...repositories],
})
export class CoreDatabaseModule {}
