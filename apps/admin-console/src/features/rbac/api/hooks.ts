'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
    assignPolicyToRole,
    createPolicy,
    createRole,
    deletePolicy,
    deleteRole,
    detachPolicyFromRole,
    getPolicy,
    getRole,
    listPolicies,
    listRoles,
    updatePolicy,
    updateRole,
    validatePolicyRules,
} from './client';
import { rbacKeys } from './keys';
import type { BreakGlass, CreatePolicyRequest, CreateRoleRequest, PolicyListParams, PolicyRule, RbacListParams, UpdatePolicyRequest, UpdateRoleRequest } from './types';

export function useRoles(params?: RbacListParams) {
    return useQuery({ queryKey: rbacKeys.roles(params), queryFn: () => listRoles(params) });
}

export function useRole(id: string) {
    return useQuery({ queryKey: rbacKeys.role(id), queryFn: () => getRole(id), enabled: !!id });
}

export function usePolicies(params?: PolicyListParams) {
    return useQuery({ queryKey: rbacKeys.policies(params), queryFn: () => listPolicies(params) });
}

export function usePolicy(id: string) {
    return useQuery({ queryKey: rbacKeys.policy(id), queryFn: () => getPolicy(id), enabled: !!id });
}

function useInvalidateRbac() {
    const queryClient = useQueryClient();
    return () => queryClient.invalidateQueries({ queryKey: rbacKeys.root });
}

export function useCreateRole() {
    const invalidate = useInvalidateRbac();
    return useMutation({ mutationFn: (body: CreateRoleRequest) => createRole(body), onSuccess: invalidate });
}

export function useUpdateRole() {
    const invalidate = useInvalidateRbac();
    return useMutation({
        mutationFn: ({ id, body }: { id: string; body: UpdateRoleRequest }) => updateRole(id, body),
        onSuccess: invalidate,
    });
}

export function useDeleteRole() {
    const invalidate = useInvalidateRbac();
    return useMutation({
        mutationFn: ({ id, breakGlass }: { id: string; breakGlass: BreakGlass }) => deleteRole(id, breakGlass),
        onSuccess: invalidate,
    });
}

export function useAssignPolicyToRole() {
    const invalidate = useInvalidateRbac();
    return useMutation({
        mutationFn: ({ roleId, policyId, priority }: { roleId: string; policyId: string; priority?: number }) =>
            assignPolicyToRole(roleId, policyId, priority),
        onSuccess: invalidate,
    });
}

export function useDetachPolicyFromRole() {
    const invalidate = useInvalidateRbac();
    return useMutation({
        mutationFn: ({ roleId, policyId, breakGlass }: { roleId: string; policyId: string; breakGlass: BreakGlass }) =>
            detachPolicyFromRole(roleId, policyId, breakGlass),
        onSuccess: invalidate,
    });
}

export function useCreatePolicy() {
    const invalidate = useInvalidateRbac();
    return useMutation({ mutationFn: (body: CreatePolicyRequest) => createPolicy(body), onSuccess: invalidate });
}

export function useUpdatePolicy() {
    const invalidate = useInvalidateRbac();
    return useMutation({
        mutationFn: ({ id, body }: { id: string; body: UpdatePolicyRequest }) => updatePolicy(id, body),
        onSuccess: invalidate,
    });
}

export function useDeletePolicy() {
    const invalidate = useInvalidateRbac();
    return useMutation({
        mutationFn: ({ id, breakGlass }: { id: string; breakGlass: BreakGlass }) => deletePolicy(id, breakGlass),
        onSuccess: invalidate,
    });
}

/** Editor dry-run; no cache impact. */
export function useValidatePolicyRules() {
    return useMutation({ mutationFn: (rules: PolicyRule[]) => validatePolicyRules(rules) });
}
