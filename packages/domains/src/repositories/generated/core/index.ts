export * from './AgentPromotionRepository';
export * from './AgentTrajectoryStepRepository';
export * from './AiModelRepository';
export * from './AiPriceBookRepository';
export * from './AiProviderConnectionRepository';
export * from './AiRoutingPolicyRepository';
export * from './AiUsageEventRepository';
export * from './AiUsageOutboxRepository';
export * from './AiUsageRollupDailyRepository';
export * from './AiUsageRollupHourlyRepository';
export * from './ApiKeyRepository';
export * from './AsrPipelineRepository';
export * from './AsrPipelineVersionRepository';
export * from './AudioRecordingRepository';
export * from './AuditLogRepository';
// Sibling that patches AuditLogRepository.prototype with
// envelope encrypt/decrypt helpers (encryptEnvelopeIntoEntity /
// decryptEnvelopeFromEntity). Importing here runs the augmentation at module load.
export * from './AuditLogRepository.encryption';
export * from './BillingAdjustmentRepository';
export * from './BillingInvoiceLineRepository';
export * from './BillingInvoiceRepository';
export * from './ConsultationRepository';
export * from './ConsultationContextSchemaRepository';
export * from './ConsultationContextSchemaVersionRepository';
export * from './DocumentTemplateRepository';
export * from './DocumentTemplateVersionRepository';
export * from './ContextItemRepository';
// Sibling that patches ContextItemRepository.prototype with
// encryptContentIntoEntity / decryptContentFromEntity / findByIdWithDecryptedContent /
// findLatestPreSummaryWithDecryptedContent.
// Importing here runs the augmentation at module load (no separate import needed).
export * from './ContextItemRepository.encryption';
export * from './ContextItemVersionRepository';
// Sibling that patches ContextItemVersionRepository.prototype
// with encryptFieldsIntoEntity / decryptFieldsFromEntity / findByIdWithDecryptedFields.
export * from './ContextItemVersionRepository.encryption';
export * from './DepartmentRepository';
export * from './DnaUsageRecordRepository';
export * from './DnaWritingStyleReportRepository';
// Sibling that patches DnaWritingStyleReportRepository.prototype.
export * from './DnaWritingStyleReportRepository.encryption';
export * from './DnaWritingStyleVersionRepository';
// Sibling that patches DnaWritingStyleVersionRepository.prototype.
export * from './DnaWritingStyleVersionRepository.encryption';
export * from './EvalRunRepository';
// Sibling that patches EvalRunRepository.prototype.
export * from './EvalRunRepository.encryption';
export * from './EvalScoreRepository';
// Sibling that patches EvalScoreRepository.prototype.
export * from './EvalScoreRepository.encryption';
export * from './FederatedIdentityRepository';
export * from './GateEditExemplarRepository';
export * from './GlobalSettingRepository';
export * from './GoldenCaseRepository';
// Sibling that patches GoldenCaseRepository.prototype.
export * from './GoldenCaseRepository.encryption';
export * from './GoldenSetRepository';
export * from './HarnessAuditEventRepository';
// Sibling that patches HarnessAuditEventRepository.prototype
// with encryptPayloads / decryptPayloadsFromEntity (encrypt-before-hash WORM).
export * from './HarnessAuditEventRepository.encryption';
export * from './HarnessPolicyChangeRepository';
// Sibling that patches HarnessPolicyChangeRepository.prototype.
export * from './HarnessPolicyChangeRepository.encryption';
export * from './HarnessPolicyRepository';
export * from './HighlightRepository';
// Sibling that patches HighlightRepository.prototype.
export * from './HighlightRepository.encryption';
export * from './KnowledgeChunkRepository';
// Sibling that patches KnowledgeChunkRepository.prototype.
export * from './KnowledgeChunkRepository.encryption';
export * from './KnowledgeDocumentRepository';
// Sibling file that patches GlobalSettingRepository
// prototype with encryptValueIntoEntity / decryptValueFromEntity /
// findByIdWithDecryptedValue. Importing here ensures the augmentation
// runs at module load (no separate import needed in consumer code).
export * from './GlobalSettingRepository.encryption';
export * from './McpServerRepository';
export * from './MediaRepository';
export * from './NamedEntityRepository';
// Sibling that patches NamedEntityRepository.prototype.
export * from './NamedEntityRepository.encryption';
export * from './NotificationRepository';
export * from './PasswordResetTokenRepository';
// Sibling that patches NotificationRepository.prototype.
export * from './NotificationRepository.encryption';
export * from './PermissionRepository';
export * from './PlanEntitlementRepository';
export * from './PromptTemplateRepository';
// Sibling that patches PromptTemplateRepository.prototype.
export * from './PromptTemplateRepository.encryption';
export * from './PromptUsageRecordRepository';
export * from './PromptVersionRepository';
export * from './RateLimitRuleRepository';
export * from './ResourceSubscriptionRepository';
export * from './RolePermissionRepository';
export * from './RoleRepository';
export * from './ServiceAccountRepository';
export * from './StorageAccessKeyRepository';
export * from './SummaryMetaRepository';
// Sibling that patches SummaryMetaRepository.prototype.
export * from './SummaryMetaRepository.encryption';
export * from './TagRepository';
export * from './TenantAllowedOriginRepository';
export * from './TenantBucketRepository';
export * from './TenantEntitlementRepository';
export * from './TenantFrontendConfigRepository';
export * from './TenantIdentityProviderRepository';
export * from './TenantIdentityProviderDomainRepository';
export * from './TenantNlpTaskInstructionsRepository';
export * from './TenantStorageConfigRepository';
export * from './TenantSttConfigRepository';
export * from './TenantTtsConfigRepository';
export * from './TenantRepository';
export * from './TenantPlanHistoryRepository';
export * from './TenantUsageMeterRepository';
export * from './TranscriptionJobRepository';
export * from './DocumentSectionRepository';
export * from './TranscriptSegmentRepository';
// Sibling that patches TranscriptionJobRepository.prototype.
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
export * from './ServiceReleaseRepository';
export * from './ServiceInstanceRepository';
export * from './ChangelogEntryRepository';
export * from './UserChangelogAcknowledgementRepository';
export * from './ConsentGrantRepository';
export * from './WorkflowTestFixtureRepository';
// Sibling that patches WorkflowTestFixtureRepository.prototype.
export * from './WorkflowTestFixtureRepository.encryption';
export * from './WorkflowRunRepository';
export * from './WorkflowDefinitionRepository';
export * from './AgentRepository';
export * from './AgentModelFallbackRepository';
export * from './AgentAssignmentRepository';
export * from './AgentAssignmentChangeRepository';
export * from './WorkflowAssignmentRepository';
export * from './WorkflowAssignmentChangeRepository';
export * from './WorkflowInvariantRuleRepository';
export * from './WorkflowWebhookSecretRepository';
