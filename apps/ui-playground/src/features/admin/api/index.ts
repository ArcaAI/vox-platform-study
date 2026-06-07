export { AdminApiError, adminClient } from './admin-client';

export {
  tenantKeys,
  useCreateTenant,
  useDeleteTenant,
  useTenant,
  useTenantConfigs,
  useAdminTenants,
  useTenantsInfinite,
  useTenantUsage,
  useToggleTenantStatus,
  useUpdateTenant,
  useUpdateTenantConfigs,
  type CreateTenantInput,
  type Tenant,
  type TenantConfig,
  type TenantUsage,
  type UpdateTenantConfigItem,
  type UpdateTenantConfigsInput,
  type UpdateTenantInput,
} from './tenants';

export {
  useAdminUser,
  useAdminUsers,
  useAdminUsersByTenant,
  useBulkDeleteUsers,
  useCreateUser,
  useDeleteUser,
  useRevokeApiKey,
  userKeys,
  useUpdateUser,
  useUpdateUserStatus,
  useUserApiKeys,
  type AdminUser,
  type CreateUserInput,
  type UpdateUserInput,
  type UpdateUserStatusInput,
  type UserApiKey,
  type UserProfile,
  type UserRoleAssignmentInfo,
} from './users';

export {
  tenantStorageKeys,
  useCreateTenantBucket,
  useCreateTenantFolder,
  useDeleteTenantBucket,
  useTenantBucketObjects,
  useTenantBuckets,
  useTenantBucketTree,
  useUploadTenantObject,
  type CreateTenantBucketInput,
  type TenantBucket,
  type TenantBucketObject,
  type TenantBucketTreeNode,
  type TenantBucketTreeResponse,
  type UploadTenantObjectInput,
} from './tenant-storage';

export { auditLogKeys, normalizeAuditLogList, useTenantAuditLogs, type AuditLog, type AuditLogListEnvelope, type AuditLogParams } from './audit-logs';

export {
  roleKeys,
  useCreateRole,
  useDeleteRole,
  useRole,
  useRoles,
  useUpdateRole,
  type CreateRoleInput,
  type CreateUserRoleAssignmentInput,
  type Role,
  type UpdateRoleInput,
  type UserRoleAssignment,
} from './roles';

export {
  departmentKeys,
  tenantDepartmentKeys,
  useCreateDepartment,
  useCreateTenantDepartment,
  useDeleteDepartment,
  useDeleteTenantDepartment,
  useDepartment,
  useDepartmentChildren,
  useDepartments,
  useRefreshTenantDepartmentDetail,
  useRootDepartments,
  useTenantDepartment,
  useTenantDepartmentChildren,
  useTenantDepartments,
  useUpdateDepartment,
  useUpdateDepartmentPromptConfig,
  useUpdateTenantDepartment,
  useUpdateTenantDepartmentPromptConfig,
  type CreateDepartmentInput,
  type Department,
  type UpdateDepartmentInput,
  type UpdatePromptConfigInput,
} from './departments';

export { adminClient as adminClientWithOptions, type RequestOptions } from './admin-client';

export { guardrailKeys, useGuardrailProviders, type GuardrailProvider } from './guardrail';

export {
  promptKeys,
  useActivatePromptVersion,
  useCreatePrompt,
  useDeletePrompt,
  usePromptTemplate,
  usePromptTemplates,
  usePromptTemplatesInfinite,
  usePromptUsageStats,
  usePromptVersions,
  useRefreshPromptDetails,
  useUpdatePrompt,
  type CreatePromptInput,
  type PromptTemplate,
  type PromptTemplateCategory,
  type PromptTemplateStatus,
  type PromptUsageStats,
  type PromptVariable,
  type PromptVersion,
  type UpdatePromptInput,
} from './prompts';

export {
  dnaReportsAdminKeys,
  useAdminUpdateDnaReport,
  useDnaReportVersions,
  useRefreshDnaReportVersions,
  useRefreshTenantDnaReportData,
  useTenantDnaReportData,
  type AdminDnaUpdateInput,
  type TenantDnaReportData,
} from './dna-reports';

export {
  audioPipelineKeys,
  useAudioPipeline,
  useAudioPipelines,
  useCreateAudioPipeline,
  useDeleteAudioPipeline,
  useUpdateAudioPipeline,
  useValidateAudioPipelineYaml,
  type AudioPipeline,
  type CreateAudioPipelineInput,
  type PaginatedAudioPipelines,
  type UpdateAudioPipelineInput,
  type YamlValidationResult,
} from './audio-pipelines';
