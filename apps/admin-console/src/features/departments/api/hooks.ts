'use client';

/**
 * TanStack Query v5 hooks for department administration. Mutations invalidate
 * the whole ['departments'] namespace — fresh reads over cache cleverness
 * (rule 13), and the tree/list/members all depend on the same rows.
 */

import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ListParams } from '@/shared/api';
import {
    createDepartment,
    deleteDepartment,
    getDepartment,
    listDepartmentChildren,
    listDepartmentUsers,
    listDepartments,
    listRootDepartments,
    updateDepartment,
    updateDepartmentPromptConfig,
} from './client';
import { departmentKeys } from './keys';
import type { CreateDepartmentRequest, ListDepartmentsParams, UpdateDepartmentPromptConfigRequest, UpdateDepartmentRequest } from './types';

export function useDepartments(params?: ListDepartmentsParams) {
    return useQuery({ queryKey: departmentKeys.list(params), queryFn: () => listDepartments(params), placeholderData: keepPreviousData });
}

export function useRootDepartments() {
    return useQuery({ queryKey: departmentKeys.roots(), queryFn: listRootDepartments });
}

/** Lazy per-node children read — mount it only for expanded tree nodes. */
export function useDepartmentChildren(id: string) {
    return useQuery({ queryKey: departmentKeys.children(id), queryFn: () => listDepartmentChildren(id), enabled: !!id });
}

/** Detail read: `data.data` is the department, `data.etag` feeds the PATCHes. */
export function useDepartment(id: string) {
    return useQuery({ queryKey: departmentKeys.detail(id), queryFn: () => getDepartment(id), enabled: !!id });
}

export function useDepartmentUsers(id: string, params?: ListParams) {
    return useQuery({
        queryKey: departmentKeys.users(id, params),
        queryFn: () => listDepartmentUsers(id, params),
        enabled: !!id,
        placeholderData: keepPreviousData,
    });
}

function useInvalidateDepartments() {
    const queryClient = useQueryClient();
    return () => queryClient.invalidateQueries({ queryKey: departmentKeys.root });
}

export function useCreateDepartment() {
    const invalidate = useInvalidateDepartments();
    return useMutation({ mutationFn: (body: CreateDepartmentRequest) => createDepartment(body), onSuccess: invalidate });
}

export function useUpdateDepartment() {
    const invalidate = useInvalidateDepartments();
    return useMutation({
        mutationFn: ({ id, patch, etag }: { id: string; patch: UpdateDepartmentRequest; etag: string }) => updateDepartment(id, patch, etag),
        onSuccess: invalidate,
    });
}

export function useUpdateDepartmentPromptConfig() {
    const invalidate = useInvalidateDepartments();
    return useMutation({
        mutationFn: ({ id, patch, etag }: { id: string; patch: UpdateDepartmentPromptConfigRequest; etag: string }) =>
            updateDepartmentPromptConfig(id, patch, etag),
        onSuccess: invalidate,
    });
}

export function useDeleteDepartment() {
    const invalidate = useInvalidateDepartments();
    return useMutation({ mutationFn: (id: string) => deleteDepartment(id), onSuccess: invalidate });
}
