/**
 * @arcaai/vox - Hooks
 */

// Session hook
export { useArcaSession, type UseArcaSessionReturn } from './useArcaSession';

// Main hook with all functionality
export { useArca, type UseArcaReturn, type UseArcaSession, type UseArcaAudio, type UseArcaContext, type UseArcaSummary } from './useArca';

// Focused domain hooks (REFACTOR-01)
export { useArcaAudio } from './useArcaAudio';
export { useArcaContext } from './useArcaContext';
export { useArcaSummary } from './useArcaSummary';
export { useArcaPipelines } from './useArcaPipelines';
export type { UseArcaPipelineControl } from './useArcaPipelines';

// Configuration hook
export { useArcaConfig, type UseArcaConfigReturn } from './useArcaConfig';

// DNA Writing Style hook (SDK-207 WS-5)
export { useDnaStyle, type UseDnaStyleReturn } from './useDnaStyle';

// Prompt Template management hook (SDK-207 WS-5)
export { usePrompts, type UsePromptsReturn } from './usePrompts';

// Department management hook (SDK-207 WS-5)
export { useDepartments, type UseDepartmentsReturn } from './useDepartments';

// User management hook (TASK-032 WS-G)
export { useUsers, type UseUsersReturn } from './useUsers';
export type { User, CreateUserInput, UpdateUserInput } from './useUsers';

// Role management hook (TASK-032 WS-G)
export { useRoles, type UseRolesReturn } from './useRoles';
export type { Role, UserRoleAssignment } from './useRoles';

// API key management hook (TASK-032 WS-G)
export { useApiKeys, type UseApiKeysReturn } from './useApiKeys';
export type { ApiKey, ApiKeyWithRawKey, CreateApiKeyInput, UpdateApiKeyInput, ApiKeyUsage } from './useApiKeys';

// Storage management hook (TASK-032 WS-G)
export { useStorage, type UseStorageReturn } from './useStorage';
export type { Bucket, StorageFile, StorageFileWithUrl } from './useStorage';

// Monitoring hook (TASK-032 WS-G)
export { useMonitoring, type UseMonitoringReturn } from './useMonitoring';

// Auth hook (TASK-032 WS-A)
export { useAuth, type UseAuthReturn } from './useAuth';

// Consultation job hook (TASK-032 WS-A)
export { useConsultationJob, type UseConsultationJobReturn } from './useConsultationJob';

// Pipeline management hook (TASK-032 WS-B)
export { usePipelines, type UsePipelinesReturn } from './usePipelines';
export type { Pipeline, CreatePipelineInput, UpdatePipelineInput, PipelineValidationResult } from './usePipelines';

// Health check hook (TASK-034 WS-H)
export { useHealthCheck, type UseHealthCheckReturn } from './useHealthCheck';

// Global settings hook (TASK-034 WS-H)
export { useGlobalSettings, type UseGlobalSettingsReturn } from './useGlobalSettings';

// User settings hook (TASK-034 WS-H)
export { useUserSettings, type UseUserSettingsReturn } from './useUserSettings';

// Voice embedding hook (TASK-033)
export { useVoiceEmbedding, type UseVoiceEmbeddingReturn } from './useVoiceEmbedding';
export type { VoiceEmbeddingResponse, VoiceEmbeddingStatus } from './useVoiceEmbedding';

// Tenant management hook (TASK-218)
export { useTenants, type UseTenantsReturn } from './useTenants';
export type { Tenant, CreateTenantInput, UpdateTenantInput } from './useTenants';

// Policy management hook (TASK-218)
export { usePolicies, type UsePoliciesReturn } from './usePolicies';
export type { Policy, CreatePolicyInput, UpdatePolicyInput } from './usePolicies';

// Audit log hook (QA-003)
export { useAuditLog, type UseAuditLogReturn } from './useAuditLog';
export type { AuditLogEntry } from './useAuditLog';

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
