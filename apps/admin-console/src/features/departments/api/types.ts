import type { BaseResource } from '@/shared/api';

/**
 * GET /admin/departments rows (DepartmentResponse — a bespoke DTO, NOT a
 * BaseResponse: only the fields below exist on the wire; timestamps are ISO
 * strings and `resourceStatus` is restricted to ENABLED/DISABLED).
 */
export interface Department {
    id: string;
    code?: string;
    name?: string;
    description?: string;
    parentDepartmentId?: string;
    isRootDepartment: boolean;
    createdAt: string;
    updatedAt: string;
    defaultSummaryTemplate?: string;
    preSummaryPromptId?: string;
    newPatientPromptId?: string;
    revisitPromptId?: string;
    dnaWritingStylePromptId?: string;
    promptConfig?: Record<string, unknown>;
    resourceStatus?: 'ENABLED' | 'DISABLED';
    /** OCC row version — echoed back as If-Match/`expectedVersion` on PATCH. */
    version: number;
}

/** GET /admin/departments accepts ONLY this flag (no pagination/search). */
export interface ListDepartmentsParams {
    includeDisabled?: boolean;
    [key: string]: string | number | boolean | undefined | null;
}

/** Role assignment nested on a member row (UserRoleAssignmentResponse). */
export interface DepartmentMemberRole extends BaseResource {
    userId: string;
    roleId: string;
    roleName?: string;
    tenantId: string | null;
}

/** GET /admin/departments/:id/users rows (UserResponse; no isPrimary field). */
export interface DepartmentMember extends BaseResource {
    username: string;
    lastLoginAt?: string;
    lastActiveAt?: string;
    externalId?: string;
    isServiceAccount: boolean;
    UserRoleAssignments?: DepartmentMemberRole[];
}

export interface CreateDepartmentRequest {
    code?: string;
    name?: string;
    description?: string;
    parentDepartmentId?: string;
    defaultSummaryTemplate?: string;
}

/** PATCH :id body — If-Match route; `expectedVersion` is added by the client. */
export interface UpdateDepartmentRequest {
    code?: string;
    name?: string;
    description?: string;
    /** null re-roots the department (removes its parent). */
    parentDepartmentId?: string | null;
    defaultSummaryTemplate?: string;
    preSummaryPromptId?: string;
    newPatientPromptId?: string;
    revisitPromptId?: string;
    promptConfig?: Record<string, unknown>;
    resourceStatus?: 'ENABLED' | 'DISABLED';
}

/** PATCH :id/prompt-config body — If-Match route, version added by the client. */
export interface UpdateDepartmentPromptConfigRequest {
    preSummaryPromptId?: string;
    newPatientPromptId?: string;
    revisitPromptId?: string;
    dnaWritingStylePromptId?: string;
}
