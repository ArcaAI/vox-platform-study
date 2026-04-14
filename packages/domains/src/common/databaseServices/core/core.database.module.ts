import { Module } from '@nestjs/common';
import { ClsModule } from 'nestjs-cls';
import { CoreUnitOfWorkService } from '../../unitsOfWork/core/core.unitOfWork';
import { CoreDatabaseService } from './core.database.service';

import { AiModelRepository } from '../../../repositories/generated/core/AiModelRepository';
import { ApiKeyRepository } from '../../../repositories/generated/core/ApiKeyRepository';
import { AsrPipelineRepository } from '../../../repositories/generated/core/AsrPipelineRepository';
import { AudioRecordingRepository } from '../../../repositories/generated/core/AudioRecordingRepository';
import { AuditLogRepository } from '../../../repositories/generated/core/AuditLogRepository';
import { ConsultationRepository } from '../../../repositories/generated/core/ConsultationRepository';
import { ContextItemRepository } from '../../../repositories/generated/core/ContextItemRepository';
import { ContextItemVersionRepository } from '../../../repositories/generated/core/ContextItemVersionRepository';
import { DepartmentRepository } from '../../../repositories/generated/core/DepartmentRepository';
import { DnaUsageRecordRepository } from '../../../repositories/generated/core/DnaUsageRecordRepository';
import { DnaWritingStyleReportRepository } from '../../../repositories/generated/core/DnaWritingStyleReportRepository';
import { DnaWritingStyleVersionRepository } from '../../../repositories/generated/core/DnaWritingStyleVersionRepository';
import { GlobalSettingRepository } from '../../../repositories/generated/core/GlobalSettingRepository';
import { MediaRepository } from '../../../repositories/generated/core/MediaRepository';
import { NamedEntityRepository } from '../../../repositories/generated/core/NamedEntityRepository';
import { NotificationRepository } from '../../../repositories/generated/core/NotificationRepository';
import { PermissionRepository } from '../../../repositories/generated/core/PermissionRepository';
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
import { TenantRepository } from '../../../repositories/generated/core/TenantRepository';
import { TranscriptionJobRepository } from '../../../repositories/generated/core/TranscriptionJobRepository';
import { UserMediaRepository } from '../../../repositories/generated/core/UserMediaRepository';
import { UserProfileRepository } from '../../../repositories/generated/core/UserProfileRepository';
import { UserRepository } from '../../../repositories/generated/core/UserRepository';
import { UserRoleAssignmentRepository } from '../../../repositories/generated/core/UserRoleAssignmentRepository';
import { UserSettingsRepository } from '../../../repositories/generated/core/UserSettingsRepository';
import { UserVoiceProfileRepository } from '../../../repositories/generated/core/UserVoiceProfileRepository';
import { WebhookRepository } from '../../../repositories/generated/core/WebhookRepository';
import { WebhookRunHistoryRepository } from '../../../repositories/generated/core/WebhookRunHistoryRepository';

const databaseProvider = {
  provide: 'CORE_DATABASE_SERVICE',
  useClass: CoreDatabaseService,
};

const repositories = [
  // Consultation domain
  ConsultationRepository,
  ContextItemRepository,
  ContextItemVersionRepository,
  AudioRecordingRepository,
  SummaryMetaRepository,
  NamedEntityRepository,
  // Core domain
  GlobalSettingRepository,
  MediaRepository,
  NotificationRepository,
  PermissionRepository,
  ResourceSubscriptionRepository,
  RolePermissionRepository,
  RoleRepository,
  TagRepository,
  TenantRepository,
  UserMediaRepository,
  UserProfileRepository,
  UserRepository,
  UserRoleAssignmentRepository,
  UserSettingsRepository,
  WebhookRepository,
  WebhookRunHistoryRepository,
  // STT domain
  AsrPipelineRepository,
  AiModelRepository,
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
  // Voice profile domain
  UserVoiceProfileRepository,
];

@Module({
  imports: [ClsModule],
  providers: [databaseProvider, CoreUnitOfWorkService, ...repositories],
  exports: [databaseProvider, CoreUnitOfWorkService, ...repositories],
})
export class CoreDatabaseModule {}
