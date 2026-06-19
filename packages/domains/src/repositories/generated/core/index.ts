export * from './AiModelRepository';
export * from './ApiKeyRepository';
export * from './AsrPipelineRepository';
export * from './AsrPipelineVersionRepository';
export * from './AudioRecordingRepository';
export * from './AuditLogRepository';
// TASK-369 Phase 3D — sibling that patches AuditLogRepository.prototype with
// envelope encrypt/decrypt helpers (encryptEnvelopeIntoEntity /
// decryptEnvelopeFromEntity). Importing here runs the augmentation at module load.
export * from './AuditLogRepository.encryption';
export * from './ConsultationRepository';
export * from './ContextItemRepository';
// TASK-369 Phase 3B — sibling that patches ContextItemRepository.prototype with
// encryptContentIntoEntity / decryptContentFromEntity / findByIdWithDecryptedContent.
// Importing here runs the augmentation at module load (no separate import needed).
export * from './ContextItemRepository.encryption';
export * from './ContextItemVersionRepository';
// TASK-369 Phase 3C — sibling that patches ContextItemVersionRepository.prototype
// with encryptFieldsIntoEntity / decryptFieldsFromEntity / findByIdWithDecryptedFields.
export * from './ContextItemVersionRepository.encryption';
export * from './DepartmentRepository';
export * from './DnaUsageRecordRepository';
export * from './DnaWritingStyleReportRepository';
// TASK-369 Phase 3C — sibling that patches DnaWritingStyleReportRepository.prototype.
export * from './DnaWritingStyleReportRepository.encryption';
export * from './DnaWritingStyleVersionRepository';
// TASK-369 Phase 3C — sibling that patches DnaWritingStyleVersionRepository.prototype.
export * from './DnaWritingStyleVersionRepository.encryption';
export * from './EvalRunRepository';
// TASK-369 Phase 3C — sibling that patches EvalRunRepository.prototype.
export * from './EvalRunRepository.encryption';
export * from './EvalScoreRepository';
// TASK-369 Phase 3C — sibling that patches EvalScoreRepository.prototype.
export * from './EvalScoreRepository.encryption';
export * from './GlobalSettingRepository';
export * from './GoldenCaseRepository';
// TASK-369 Phase 3C — sibling that patches GoldenCaseRepository.prototype.
export * from './GoldenCaseRepository.encryption';
export * from './GoldenSetRepository';
export * from './HarnessAuditEventRepository';
// TASK-369 Phase 3D — sibling that patches HarnessAuditEventRepository.prototype
// with encryptPayloads / decryptPayloadsFromEntity (encrypt-before-hash WORM).
export * from './HarnessAuditEventRepository.encryption';
export * from './HarnessPolicyChangeRepository';
// TASK-369 Phase 3D — sibling that patches HarnessPolicyChangeRepository.prototype.
export * from './HarnessPolicyChangeRepository.encryption';
export * from './HarnessPolicyRepository';
export * from './HighlightRepository';
// TASK-369 Phase 3C — sibling that patches HighlightRepository.prototype.
export * from './HighlightRepository.encryption';
export * from './KnowledgeChunkRepository';
// TASK-369 Phase 3C — sibling that patches KnowledgeChunkRepository.prototype.
export * from './KnowledgeChunkRepository.encryption';
export * from './KnowledgeDocumentRepository';
// TASK-302 Phase 4 — sibling file that patches GlobalSettingRepository
// prototype with encryptValueIntoEntity / decryptValueFromEntity /
// findByIdWithDecryptedValue. Importing here ensures the augmentation
// runs at module load (no separate import needed in consumer code).
export * from './GlobalSettingRepository.encryption';
export * from './MediaRepository';
export * from './NamedEntityRepository';
// TASK-369 Phase 3C — sibling that patches NamedEntityRepository.prototype.
export * from './NamedEntityRepository.encryption';
export * from './NotificationRepository';
// TASK-369 Phase 3C — sibling that patches NotificationRepository.prototype.
export * from './NotificationRepository.encryption';
export * from './PermissionRepository';
export * from './PipelinePolicyChangeRepository';
// TASK-369 Phase 3D — sibling that patches PipelinePolicyChangeRepository.prototype.
export * from './PipelinePolicyChangeRepository.encryption';
export * from './PipelinePolicyRepository';
export * from './PromptTemplateRepository';
// TASK-369 Phase 3C — sibling that patches PromptTemplateRepository.prototype.
export * from './PromptTemplateRepository.encryption';
export * from './PromptUsageRecordRepository';
export * from './PromptVersionRepository';
export * from './ResourceSubscriptionRepository';
export * from './RolePermissionRepository';
export * from './RoleRepository';
export * from './StorageAccessKeyRepository';
export * from './SummaryMetaRepository';
// TASK-369 Phase 3C — sibling that patches SummaryMetaRepository.prototype.
export * from './SummaryMetaRepository.encryption';
export * from './TagRepository';
export * from './TenantBucketRepository';
export * from './TenantFrontendConfigRepository';
export * from './TenantStorageConfigRepository';
export * from './TenantRepository';
export * from './TranscriptionJobRepository';
// TASK-369 Phase 3C — sibling that patches TranscriptionJobRepository.prototype.
export * from './TranscriptionJobRepository.encryption';
export * from './UserDepartmentRepository';
export * from './UserMediaRepository';
export * from './UserProfileRepository';
export * from './UserRepository';
export * from './UserRoleAssignmentRepository';
export * from './UserSettingsRepository';
export * from './UserVoiceProfileRepository';
export * from './WebhookRepository';
export * from './WebhookRunHistoryRepository';

