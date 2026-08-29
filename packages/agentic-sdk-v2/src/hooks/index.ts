/**
 * @arcaai/vox - Hooks
 */

// Session hook
export { useArcaSession, type UseArcaSessionReturn } from './useArcaSession';

// Main hook with all functionality
export { useArca, type UseArcaReturn, type UseArcaSession, type UseArcaAudio, type UseArcaContext, type UseArcaSummary } from './useArca';

// Focused domain hooks (REFACTOR-01)
export { useArcaAudio } from './useArcaAudio';
// Runtime audio-input discovery for device pickers. Provider-free.
export {
  useArcaDevices,
  type ArcaAudioDevice,
  type ArcaDevicePreference,
  type ArcaDevicePermission,
  type UseArcaDevicesReturn,
} from './useArcaDevices';
export { useArcaContext } from './useArcaContext';
export { useArcaSummary } from './useArcaSummary';
export { useArcaLiveSummary, type UseArcaLiveSummaryReturn, type LiveSummaryStreamStatus } from './useArcaLiveSummary';
export { useArcaPipelines } from './useArcaPipelines';
export type { UseArcaPipelineControl } from './useArcaPipelines';

// Configuration hook
export { useArcaConfig, type UseArcaConfigReturn } from './useArcaConfig';

// DNA Writing Style hook (SDK-207 WS-5)
export { useDnaStyle, type UseDnaStyleReturn } from './useDnaStyle';

// DNA aggregate dashboard hook
export { useDnaDashboard, type UseDnaDashboardReturn } from './useDnaDashboard';

// Prompt Template management hook (SDK-207 WS-5)
export { usePrompts, type UsePromptsReturn } from './usePrompts';
export type { PromptUsageRecord, PaginatedPromptUsageRecords, PromptUsageStats } from './usePrompts';

// Department management hook (SDK-207 WS-5)
export { useDepartments, type UseDepartmentsReturn } from './useDepartments';

// User ↔ department assignment hook
export { useUserDepartments, type UseUserDepartmentsReturn } from './useUserDepartments';
export type { UserDepartmentAssignment, AssignUserDepartmentInput } from './useUserDepartments';

// User management hook
export { useUsers, type UseUsersReturn } from './useUsers';
export type { User, CreateUserInput, UpdateUserInput, UserListQuery } from './useUsers';

// Role management hook
export { useRoles, type UseRolesReturn } from './useRoles';
export type { Role, UserRoleAssignment } from './useRoles';
// Typed built-in role identifiers tuple
export { USER_ROLES, type UserRole } from './useRoles';

// API key management hook
export { useApiKeys, type UseApiKeysReturn } from './useApiKeys';
export type { ApiKey, ApiKeyWithRawKey, CreateApiKeyInput, UpdateApiKeyInput, ApiKeyUsage } from './useApiKeys';

// Plan-entitlements hook
export { useEntitlements, type UseEntitlementsReturn } from './useEntitlements';
export type {
  EntitlementPlan,
  TrialInfo,
  CapabilityUsageRow,
  ResolvedFeatures,
  EntitlementCapabilities,
  PlanEntitlement,
  UpdatePlanEntitlementInput,
  TenantEntitlementOverride,
  UpsertTenantOverrideInput,
  DowngradeDisabledGroup,
  DowngradeReport,
  TrialExpiryReport,
} from './useEntitlements';

// Storage management hook
export { useStorage, type UseStorageReturn } from './useStorage';
export type { Bucket, StorageFile, StorageFileWithUrl } from './useStorage';

// Monitoring hook
export { useMonitoring, type UseMonitoringReturn } from './useMonitoring';

// Platform runtime metrics hook (E1/E2/E3 super-admin tiles)
export { usePlatformMetrics, type UsePlatformMetricsReturn } from './usePlatformMetrics';

// Auth hook
export { useAuth, type UseAuthReturn } from './useAuth';

// Consultation job hook
export { useConsultationJob, type UseConsultationJobReturn } from './useConsultationJob';

// Consultation chain hook — full multi-hop parent/child tree
export { useConsultationChain, type UseConsultationChainReturn } from './useConsultationChain';

// Consultation context schema discovery
export { useConsultationSchema, type UseConsultationSchemaReturn } from './useConsultationSchema';
// TASK-813 — which engine governs a consultation (the read side of OpenSessionInput.workflowDefinitionSlug).
export { useConsultationWorkflow, type UseConsultationWorkflowReturn } from './useConsultationWorkflow';
export { useSelectableConsultationWorkflows, type UseSelectableConsultationWorkflowsReturn } from './useSelectableConsultationWorkflows';

// Consultation-loop workflow event SSE stream
export { useConsultationEvents, type UseConsultationEventsReturn, type ConsultationEventsStreamStatus } from './useConsultationEvents';

// Audio recordings hook (dual-capture X8)
export { useAudioRecordings, type UseAudioRecordingsReturn } from './useAudioRecordings';

// Pipeline management hook (incl. default/toggle/versions)
export { usePipelines, type UsePipelinesReturn } from './usePipelines';
export type { Pipeline, CreatePipelineInput, UpdatePipelineInput, PipelineValidationResult, PipelineVersion } from './usePipelines';

// Health check hook
export { useHealthCheck, type UseHealthCheckReturn } from './useHealthCheck';

// STT language-mode catalog hook
export { useArcaSttLanguageModes, type UseArcaSttLanguageModesReturn } from './useArcaSttLanguageModes';

// Native 2-way STT provider toggle — pipeline (primary) ↔ default (fallback)
export { useSttProviderToggle, type UseSttProviderToggleReturn, type SttFallbackProvider } from './useSttProviderToggle';
// Batch (pre-recorded file) transcription — up to N recordings, monitored to
// completion.
export {
  useBatchTranscription,
  type UseBatchTranscriptionProps,
  type UseBatchTranscriptionReturn,
  type BatchTranscriptionLimitsResponse,
} from './useBatchTranscription';

// Global settings hook
export { useGlobalSettings, type UseGlobalSettingsReturn } from './useGlobalSettings';

// User settings hook
export { useUserSettings, type UseUserSettingsReturn } from './useUserSettings';

// Voice embedding hook
export { useVoiceEmbedding, type UseVoiceEmbeddingReturn } from './useVoiceEmbedding';
export type { VoiceProfile, EnrollFiles, EnrollOptions } from './useVoiceEmbedding';

// Voice enrollment status helper + checker interface
export {
  useVoiceEnrollmentStatus,
  createVoiceEnrollmentChecker,
  type UseVoiceEnrollmentStatusReturn,
  type VoiceEnrollmentChecker,
} from './useVoiceEnrollmentStatus';

// LOCAL in-browser voice-embedding provider — sits alongside the
// backend `useVoiceEmbedding`; extracts a WavLM speaker embedding client-side.
export { useLocalVoiceEmbedding } from './useLocalVoiceEmbedding';
export type {
  UseLocalVoiceEmbeddingReturn,
  UseLocalVoiceEmbeddingOptions,
  LocalVoiceEmbeddingRecord,
  LocalVoiceStatus,
} from './useLocalVoiceEmbedding';

// Tenant management hook
export { useTenants, type UseTenantsReturn } from './useTenants';
export type { Tenant, CreateTenantInput, UpdateTenantInput, TenantUsageStats } from './useTenants';

// Policy management hook
export { usePolicies, type UsePoliciesReturn } from './usePolicies';
export type { Policy, CreatePolicyInput, UpdatePolicyInput, BreakGlassCredentials } from './usePolicies';

// Audit log hook (QA-003; includes cursor list)
export { useAuditLog, type UseAuditLogReturn } from './useAuditLog';
export type { AuditLogEntry, AuditLogFilterParams, AuditLogCursorParams, AuditLogResponsibleUser } from './useAuditLog';

// Admin consultation supervision hook
export { useAdminConsultations, type UseAdminConsultationsReturn } from './useAdminConsultations';
export type { AdminConsultation, AdminConsultationListParams } from './useAdminConsultations';

// Admin transcription-job supervision hook
export { useAdminTranscriptionJobs, type UseAdminTranscriptionJobsReturn } from './useAdminTranscriptionJobs';
export type { AdminTranscriptionJob, AdminTranscriptionJobStats } from './useAdminTranscriptionJobs';

// Tenant storage bucket management hook
export { useTenantBuckets, type UseTenantBucketsReturn } from './useTenantBuckets';
export type {
  TenantBucket,
  TenantBucketTree,
  TenantBucketDefaults,
  TenantBucketObject,
  CreateTenantBucketInput,
  SetTenantBucketDefaultsInput,
  DeleteTenantBucketObjectResult,
} from './useTenantBuckets';

// Clinical Documentation Harness admin hook (read-only)
export { useHarnessAdmin, type UseHarnessAdminReturn } from './useHarnessAdmin';
export type {
  HarnessPolicy,
  HarnessPolicySource,
  HarnessAuditEvent,
  HarnessAuditList,
  HarnessEvalRun,
  HarnessEvalRunList,
  HarnessEvalRunDetail,
  HarnessGateQueue,
  HarnessGateQueueItem,
  HarnessWorkflow,
  HarnessWorkflowList,
} from './useHarnessAdmin';

// Tenant storage access-key management hook
export { useStorageKeys, type UseStorageKeysReturn } from './useStorageKeys';
export type { StorageKey, StorageKeyWithSecret, CreateStorageKeyInput } from './useStorageKeys';

// Tenant storage config management hook
export { useTenantStorageConfig, type UseTenantStorageConfigReturn } from './useTenantStorageConfig';
export type { TenantStorageConfig, ListTenantStorageConfigParams, UpsertTenantStorageConfigInput } from './useTenantStorageConfig';

// Tenant FRONTEND pipeline config hook
export { useTenantFrontendConfig, type UseTenantFrontendConfigReturn } from './useTenantFrontendConfig';

// Super-admin ops-surface hooks (Rate Limits / Queues & Jobs / Prisma Studio)
export { useRateLimits, type UseRateLimitsReturn } from './useRateLimits';
export { useQueueAdmin, type UseQueueAdminReturn } from './useQueueAdmin';
export { usePrismaStudio, type UsePrismaStudioReturn } from './usePrismaStudio';

// Shared connection management (multi-tab)
export {
  useSharedConnection,
  useSharedSSE,
  useSharedWS,
  type UseSharedConnectionReturn,
  type UseSharedSSEOptions,
  type UseSharedSSEReturn,
  type UseSharedWSOptions,
  type UseSharedWSReturn,
} from './useSharedConnection';
