import type { BaseResource, ListParams, ResourceStatus } from '@/shared/api';

/** GET /admin/users rows (UserResponse; ISO timestamps). */
export interface User extends BaseResource {
    username: string;
    lastLoginAt?: string;
    lastActiveAt?: string;
    externalId?: string;
    isServiceAccount: boolean;
    UserRoleAssignments?: UserRoleAssignment[];
}

export interface CreateUserRequest {
    username: string;
    password: string;
    email?: string;
    externalId?: string;
    isServiceAccount?: boolean;
    roleId?: string;
    departmentId?: string;
    isPrimaryDepartment?: boolean;
}

export interface UpdateUserRequest {
    username?: string;
    resourceStatus?: 'ENABLED' | 'DISABLED';
    password?: string;
    externalId?: string;
    isServiceAccount?: boolean;
}

export type UserExportFormat = 'csv' | 'xlsx' | 'pdf';

export interface ExportUsersParams extends ListParams {
    format: UserExportFormat;
}

export interface BulkUserActionRequest {
    action: 'enable' | 'disable' | 'delete' | 'assign-departments' | 'assign-role';
    ids: string[];
    departmentIds?: string[];
    primaryDepartmentId?: string;
    roleId?: string;
}

export interface BulkUserActionResult {
    action: string;
    total: number;
    succeeded: number;
    failed: number;
    results: { id: string; success: boolean; error?: string }[];
}

export interface UserSetting extends BaseResource {
    name: string;
    key: string;
    value: string;
    dataType: string;
    namespace?: string;
    userId: string;
}

export interface UpdateUserSettingRequest {
    value: string;
    dataType?: string;
    name?: string;
}

export interface ResetPasswordRequest {
    mode?: 'temporary' | 'link';
    temporaryPassword?: string;
}

export interface ResetPasswordResult {
    mode: 'temporary' | 'link';
    temporaryPassword?: string;
    token?: string;
    resetPath?: string;
    expiresInSeconds?: number;
    emailSent?: boolean;
}

export interface UserRoleAssignment extends BaseResource {
    userId: string;
    roleId: string;
    roleName?: string;
    tenantId: string | null;
}

export interface AssignRoleRequest {
    roleId: string;
    tenantId?: string;
}

export interface UserProfile extends BaseResource {
    firstName?: string;
    lastName?: string;
    email?: string;
    phone?: string;
    avatarId?: string;
    preferredPromptTemplateId?: string;
    userId: string;
}

export interface UpdateUserProfileRequest {
    firstName?: string;
    lastName?: string;
    email?: string;
    phone?: string;
    avatarId?: string;
    preferredPromptTemplateId?: string | null;
}

export interface VoiceProfile {
    id: string;
    userId: string;
    isActive: boolean;
    label: string | null;
    modelId: string | null;
    createdAt: string;
    updatedAt: string;
}

/** GET/POST/PATCH /admin/users/:id/departments rows. */
export interface UserDepartment {
    id: string;
    userId: string;
    departmentId: string;
    isPrimary: boolean;
    tenantId: string;
    resourceStatus?: ResourceStatus;
    createdAt: string;
    updatedAt: string;
    version: number;
}

export interface AssignDepartmentRequest {
    departmentId: string;
    isPrimary?: boolean;
}

/** PATCH :id/departments/:assignmentId body — If-Match route, version added by client. */
export interface UpdateDepartmentRequest {
    isPrimary?: boolean;
}

/** PATCH :id/departments (bulk reconcile to the given set). */
export interface SetUserDepartmentsRequest {
    departmentIds: string[];
    primaryDepartmentId?: string;
}

/** POST /api/auth/impersonate (BFF route, not the proxy). */
export interface ImpersonateRequest {
    userId: string;
    targetTenantId?: string;
    reason?: string;
}

/** SafeSession projection + impersonation summary returned by the BFF. */
export interface ImpersonationState {
    impersonation: { targetUserId: string; targetUsername: string; expiresAt: string };
    [key: string]: unknown;
}
