/**
 * User directory administration (capabilities-matrix rows 11–12). Everything
 * proxies through /api/hope except impersonation, which must hit the BFF's own
 * /api/auth routes so the act-as token lands in the encrypted session.
 */

import { deleteJson, getBlob, getJson, patchJson, patchWithEtag, postJson, versionFromEtag } from '@/shared/api';
import type { ListParams, Paginated, WithEtag } from '@/shared/api';
import type { ApiKey } from '@/features/api-keys/api/types';
import type {
    AssignDepartmentRequest,
    AssignRoleRequest,
    BulkUserActionRequest,
    BulkUserActionResult,
    CreateUserRequest,
    ExportUsersParams,
    ImpersonateRequest,
    ImpersonationState,
    ResetPasswordRequest,
    ResetPasswordResult,
    SetUserDepartmentsRequest,
    UpdateDepartmentRequest,
    UpdateUserProfileRequest,
    UpdateUserRequest,
    UpdateUserSettingRequest,
    User,
    UserDepartment,
    UserProfile,
    UserRoleAssignment,
    UserSetting,
    VoiceProfile,
} from './types';

const BASE = 'admin/users';

const userPath = (id: string) => `${BASE}/${encodeURIComponent(id)}`;

export function listUsers(params?: ListParams): Promise<Paginated<User>> {
    return getJson(BASE, params);
}

export function listUsersByTenant(tenantId: string, params?: ListParams): Promise<Paginated<User>> {
    return getJson(`${BASE}/tenant/${encodeURIComponent(tenantId)}`, params);
}

export function getUser(id: string): Promise<User> {
    return getJson(userPath(id));
}

export function createUser(body: CreateUserRequest): Promise<User> {
    return postJson(BASE, body);
}

export function updateUser(id: string, body: UpdateUserRequest): Promise<User> {
    return patchJson(userPath(id), body);
}

export function updateUserStatus(id: string, resourceStatus: 'ENABLED' | 'DISABLED'): Promise<User> {
    return patchJson(`${userPath(id)}/status`, { resourceStatus });
}

/** Soft delete. */
export function deleteUser(id: string): Promise<User> {
    return deleteJson(userPath(id));
}

export function bulkDeleteUsers(ids: string[]): Promise<{ succeeded: User[]; failed: { id: string; reason: string }[] }> {
    return deleteJson(`${BASE}/bulk`, { ids });
}

export function bulkUserAction(body: BulkUserActionRequest): Promise<BulkUserActionResult> {
    return postJson(`${BASE}/bulk-actions`, body);
}

export function exportUsers(params: ExportUsersParams): Promise<{ blob: Blob; contentType: string | null; contentDisposition: string | null }> {
    return getBlob(`${BASE}/export`, params);
}

export function listUserRoles(id: string, params?: ListParams): Promise<Paginated<UserRoleAssignment>> {
    return getJson(`${userPath(id)}/roles`, params);
}

export function assignRole(id: string, body: AssignRoleRequest): Promise<UserRoleAssignment> {
    return postJson(`${userPath(id)}/roles`, body);
}

export function removeRole(id: string, assignmentId: string): Promise<void> {
    return deleteJson(`${userPath(id)}/roles/${encodeURIComponent(assignmentId)}`);
}

export function listUserDepartments(id: string): Promise<UserDepartment[]> {
    return getJson(`${userPath(id)}/departments`);
}

export function assignDepartment(id: string, body: AssignDepartmentRequest): Promise<UserDepartment> {
    return postJson(`${userPath(id)}/departments`, body);
}

/** OCC PATCH (If-Match required): version derived from the read ETag. */
export function updateDepartment(id: string, assignmentId: string, patch: UpdateDepartmentRequest, etag: string): Promise<WithEtag<UserDepartment>> {
    return patchWithEtag(`${userPath(id)}/departments/${encodeURIComponent(assignmentId)}`, { ...patch, expectedVersion: versionFromEtag(etag) }, etag);
}

export function removeDepartment(id: string, assignmentId: string): Promise<void> {
    return deleteJson(`${userPath(id)}/departments/${encodeURIComponent(assignmentId)}`);
}

/** Reconciles the user's departments to exactly the given set. */
export function setUserDepartments(id: string, body: SetUserDepartmentsRequest): Promise<User> {
    return patchJson(`${userPath(id)}/departments`, body);
}

export function listUserSettings(id: string): Promise<UserSetting[]> {
    return getJson(`${userPath(id)}/settings`);
}

export function updateUserSetting(id: string, namespace: string, key: string, body: UpdateUserSettingRequest): Promise<UserSetting> {
    return patchJson(`${userPath(id)}/settings/${encodeURIComponent(namespace)}/${encodeURIComponent(key)}`, body);
}

export function resetPassword(id: string, body: ResetPasswordRequest): Promise<ResetPasswordResult> {
    return postJson(`${userPath(id)}/reset-password`, body);
}

export function getUserProfile(id: string): Promise<UserProfile | null> {
    return getJson(`${userPath(id)}/profile`);
}

export function updateUserProfile(id: string, body: UpdateUserProfileRequest): Promise<UserProfile> {
    return patchJson(`${userPath(id)}/profile`, body);
}

export function listVoiceProfiles(id: string): Promise<VoiceProfile[]> {
    return getJson(`${userPath(id)}/voice-profiles`);
}

export function listUserApiKeys(id: string, params?: ListParams): Promise<Paginated<ApiKey>> {
    return getJson(`${userPath(id)}/api-keys`, params);
}

async function bffPost<T>(path: string, body?: unknown): Promise<T> {
    const response = await fetch(path, {
        method: 'POST',
        headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
        body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as { message?: string };
        throw new Error(payload.message ?? `Request failed with status ${response.status}`);
    }
    return response.json() as Promise<T>;
}

/** BFF-owned: mints the act-as token and stores it in the session cookie. */
export function impersonateUser(body: ImpersonateRequest): Promise<ImpersonationState> {
    return bffPost('/api/auth/impersonate', body);
}

/** BFF-owned: restores the original session tokens. */
export function revokeImpersonation(): Promise<Record<string, unknown>> {
    return bffPost('/api/auth/revoke-impersonation');
}
