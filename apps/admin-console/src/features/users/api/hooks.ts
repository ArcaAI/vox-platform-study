'use client';

import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ListParams } from '@/shared/api';
import { invalidateGridLayoutCache } from '@/shared/data/grid-persistence';
import {
    assignDepartment,
    assignRole,
    bulkDeleteUsers,
    bulkUserAction,
    createUser,
    deleteUser,
    exportUsers,
    getUser,
    getUserProfile,
    impersonateUser,
    listUserApiKeys,
    listUserDepartments,
    listUserRoles,
    listUserSettings,
    listUsers,
    listUsersByTenant,
    listVoiceProfiles,
    removeDepartment,
    removeRole,
    resetPassword,
    revokeImpersonation,
    setUserDepartments,
    updateDepartment,
    updateUser,
    updateUserProfile,
    updateUserSetting,
    updateUserStatus,
} from './client';
import { userKeys } from './keys';
import type {
    AssignDepartmentRequest,
    AssignRoleRequest,
    BulkUserActionRequest,
    CreateUserRequest,
    ExportUsersParams,
    ImpersonateRequest,
    ResetPasswordRequest,
    SetUserDepartmentsRequest,
    UpdateDepartmentRequest,
    UpdateUserProfileRequest,
    UpdateUserRequest,
    UpdateUserSettingRequest,
} from './types';

export function useUsers(params?: ListParams, options?: { enabled?: boolean }) {
    return useQuery({
        queryKey: userKeys.list(params),
        queryFn: () => listUsers(params),
        placeholderData: keepPreviousData,
        // The list screen swaps to the by-tenant route when the
        // in-page tenant filter is active; the cross-tenant query pauses.
        enabled: options?.enabled ?? true,
    });
}

export function useUsersByTenant(tenantId: string, params?: ListParams) {
    return useQuery({
        queryKey: userKeys.byTenant(tenantId, params),
        queryFn: () => listUsersByTenant(tenantId, params),
        enabled: !!tenantId,
        placeholderData: keepPreviousData,
    });
}

export function useUser(id: string) {
    return useQuery({ queryKey: userKeys.detail(id), queryFn: () => getUser(id), enabled: !!id });
}

export function useUserRoles(id: string) {
    return useQuery({ queryKey: userKeys.roles(id), queryFn: () => listUserRoles(id), enabled: !!id });
}

export function useUserDepartments(id: string) {
    return useQuery({ queryKey: userKeys.departments(id), queryFn: () => listUserDepartments(id), enabled: !!id });
}

export function useUserSettings(id: string) {
    return useQuery({ queryKey: userKeys.settings(id), queryFn: () => listUserSettings(id), enabled: !!id });
}

export function useUserProfile(id: string) {
    return useQuery({ queryKey: userKeys.profile(id), queryFn: () => getUserProfile(id), enabled: !!id });
}

export function useVoiceProfiles(id: string) {
    return useQuery({ queryKey: userKeys.voiceProfiles(id), queryFn: () => listVoiceProfiles(id), enabled: !!id });
}

export function useUserApiKeys(id: string, params?: ListParams) {
    return useQuery({ queryKey: userKeys.apiKeys(id, params), queryFn: () => listUserApiKeys(id, params), enabled: !!id, placeholderData: keepPreviousData });
}

function useInvalidateUsers() {
    const queryClient = useQueryClient();
    return () => queryClient.invalidateQueries({ queryKey: userKeys.root });
}

export function useCreateUser() {
    const invalidate = useInvalidateUsers();
    return useMutation({ mutationFn: (body: CreateUserRequest) => createUser(body), onSuccess: invalidate });
}

export function useUpdateUser() {
    const invalidate = useInvalidateUsers();
    return useMutation({
        mutationFn: ({ id, body }: { id: string; body: UpdateUserRequest }) => updateUser(id, body),
        onSuccess: invalidate,
    });
}

export function useUpdateUserStatus() {
    const invalidate = useInvalidateUsers();
    return useMutation({
        mutationFn: ({ id, resourceStatus }: { id: string; resourceStatus: 'ENABLED' | 'DISABLED' }) => updateUserStatus(id, resourceStatus),
        onSuccess: invalidate,
    });
}

export function useDeleteUser() {
    const invalidate = useInvalidateUsers();
    return useMutation({ mutationFn: (id: string) => deleteUser(id), onSuccess: invalidate });
}

export function useBulkDeleteUsers() {
    const invalidate = useInvalidateUsers();
    return useMutation({ mutationFn: (ids: string[]) => bulkDeleteUsers(ids), onSuccess: invalidate });
}

export function useBulkUserAction() {
    const invalidate = useInvalidateUsers();
    return useMutation({ mutationFn: (body: BulkUserActionRequest) => bulkUserAction(body), onSuccess: invalidate });
}

export function useExportUsers() {
    return useMutation({ mutationFn: (params: ExportUsersParams) => exportUsers(params) });
}

export function useAssignRole() {
    const invalidate = useInvalidateUsers();
    return useMutation({
        mutationFn: ({ id, body }: { id: string; body: AssignRoleRequest }) => assignRole(id, body),
        onSuccess: invalidate,
    });
}

export function useRemoveRole() {
    const invalidate = useInvalidateUsers();
    return useMutation({
        mutationFn: ({ id, assignmentId }: { id: string; assignmentId: string }) => removeRole(id, assignmentId),
        onSuccess: invalidate,
    });
}

export function useAssignDepartment() {
    const invalidate = useInvalidateUsers();
    return useMutation({
        mutationFn: ({ id, body }: { id: string; body: AssignDepartmentRequest }) => assignDepartment(id, body),
        onSuccess: invalidate,
    });
}

export function useUpdateDepartment() {
    const invalidate = useInvalidateUsers();
    return useMutation({
        mutationFn: ({ id, assignmentId, patch, etag }: { id: string; assignmentId: string; patch: UpdateDepartmentRequest; etag: string }) =>
            updateDepartment(id, assignmentId, patch, etag),
        onSuccess: invalidate,
    });
}

export function useRemoveDepartment() {
    const invalidate = useInvalidateUsers();
    return useMutation({
        mutationFn: ({ id, assignmentId }: { id: string; assignmentId: string }) => removeDepartment(id, assignmentId),
        onSuccess: invalidate,
    });
}

export function useSetUserDepartments() {
    const invalidate = useInvalidateUsers();
    return useMutation({
        mutationFn: ({ id, body }: { id: string; body: SetUserDepartmentsRequest }) => setUserDepartments(id, body),
        onSuccess: invalidate,
    });
}

export function useUpdateUserSetting() {
    const invalidate = useInvalidateUsers();
    return useMutation({
        mutationFn: ({ id, namespace, key, body }: { id: string; namespace: string; key: string; body: UpdateUserSettingRequest }) =>
            updateUserSetting(id, namespace, key, body),
        onSuccess: invalidate,
    });
}

export function useResetPassword() {
    return useMutation({ mutationFn: ({ id, body }: { id: string; body: ResetPasswordRequest }) => resetPassword(id, body) });
}

export function useUpdateUserProfile() {
    const invalidate = useInvalidateUsers();
    return useMutation({
        mutationFn: ({ id, body }: { id: string; body: UpdateUserProfileRequest }) => updateUserProfile(id, body),
        onSuccess: invalidate,
    });
}

/** Impersonation flips the whole session — drop every cache on success. */
export function useImpersonateUser() {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: (body: ImpersonateRequest) => impersonateUser(body),
        onSuccess: () => {
            invalidateGridLayoutCache();
            return queryClient.invalidateQueries();
        },
    });
}

export function useRevokeImpersonation() {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: () => revokeImpersonation(),
        onSuccess: () => {
            invalidateGridLayoutCache();
            return queryClient.invalidateQueries();
        },
    });
}
