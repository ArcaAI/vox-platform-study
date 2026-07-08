/** RBAC roles/policies admin. Destructive ops require break-glass step-up. */

import { deleteJson, getJson, patchJson, postJson } from '@/shared/api';
import type {
    BreakGlass,
    CreatePolicyRequest,
    CreateRoleRequest,
    Policy,
    PolicyListParams,
    PolicyRule,
    PolicyValidationResult,
    RbacListParams,
    RbacPaginated,
    Role,
    RoleMember,
    UpdatePolicyRequest,
    UpdateRoleRequest,
} from './types';

const ROLES = 'admin/rbac/roles';
const POLICIES = 'admin/rbac/policies';

export function listRoles(params?: RbacListParams): Promise<RbacPaginated<Role>> {
    return getJson(ROLES, params);
}

export function getRole(id: string): Promise<Role> {
    return getJson(`${ROLES}/${encodeURIComponent(id)}`);
}

/** TASK-444 — users holding a role (tenant-scoped on the gateway). */
export function listRoleMembers(roleId: string, params?: RbacListParams): Promise<RbacPaginated<RoleMember>> {
    return getJson(`${ROLES}/${encodeURIComponent(roleId)}/members`, params);
}

export function createRole(body: CreateRoleRequest): Promise<Role> {
    return postJson(ROLES, body);
}

export function updateRole(id: string, body: UpdateRoleRequest): Promise<Role> {
    return patchJson(`${ROLES}/${encodeURIComponent(id)}`, body);
}

/** Break-glass required (missing -> 428). */
export function deleteRole(id: string, breakGlass: BreakGlass): Promise<void> {
    return deleteJson(`${ROLES}/${encodeURIComponent(id)}`, breakGlass);
}

export function assignPolicyToRole(roleId: string, policyId: string, priority?: number): Promise<{ message: string }> {
    return postJson(`${ROLES}/${encodeURIComponent(roleId)}/policies/${encodeURIComponent(policyId)}`, priority === undefined ? {} : { priority });
}

/** Break-glass required (missing -> 428). */
export function detachPolicyFromRole(roleId: string, policyId: string, breakGlass: BreakGlass): Promise<void> {
    return deleteJson(`${ROLES}/${encodeURIComponent(roleId)}/policies/${encodeURIComponent(policyId)}`, breakGlass);
}

export function listPolicies(params?: PolicyListParams): Promise<RbacPaginated<Policy>> {
    return getJson(POLICIES, params);
}

export function getPolicy(id: string): Promise<Policy> {
    return getJson(`${POLICIES}/${encodeURIComponent(id)}`);
}

export function createPolicy(body: CreatePolicyRequest): Promise<Policy> {
    return postJson(POLICIES, body);
}

/** Editing rules of a multi-role policy needs body.breakGlass. */
export function updatePolicy(id: string, body: UpdatePolicyRequest): Promise<Policy> {
    return patchJson(`${POLICIES}/${encodeURIComponent(id)}`, body);
}

/** Break-glass required; protected policies always refuse (403). */
export function deletePolicy(id: string, breakGlass: BreakGlass): Promise<void> {
    return deleteJson(`${POLICIES}/${encodeURIComponent(id)}`, breakGlass);
}

/** Dry-run rule validation for the policy editor. */
export function validatePolicyRules(rules: PolicyRule[]): Promise<PolicyValidationResult> {
    return postJson(`${POLICIES}/validate`, { rules });
}
