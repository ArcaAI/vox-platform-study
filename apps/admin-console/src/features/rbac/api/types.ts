/**
 * RBAC roles + policies (capabilities-matrix row 13). NOTE: this surface uses
 * its own list envelope { data, total, page, pageSize } and raw query params —
 * different from every other admin list.
 */

export type PolicyScope = 'GLOBAL' | 'TENANT';

export interface RbacListParams {
    /** One-based page (defaults to 1 on the gateway). */
    page?: number;
    pageSize?: number;
    search?: string;
    [key: string]: string | number | boolean | undefined | null;
}

export interface PolicyListParams extends RbacListParams {
    scope?: PolicyScope;
}

/** RBAC's custom list envelope. */
export interface RbacPaginated<T> {
    data: T[];
    total: number;
    page: number;
    pageSize: number;
}

export interface Role {
    id: string;
    name: string;
    description?: string;
    externalName?: string;
    externalId?: string;
    isSystemRole: boolean;
    parentRoleId?: string;
    resourceStatus: string;
    createdAt: string;
    updatedAt: string;
    policies?: { id: string; name: string; priority: number }[];
}

export interface CreateRoleRequest {
    name: string;
    description?: string;
    externalName?: string;
    externalId?: string;
    parentRoleId?: string;
}

export interface UpdateRoleRequest {
    name?: string;
    description?: string;
    externalName?: string;
    externalId?: string;
    parentRoleId?: string;
    resourceStatus?: 'ENABLED' | 'DISABLED';
}

/** One CASL rule inside a policy. */
export interface PolicyRule {
    action: string;
    subject: string;
    conditions?: Record<string, unknown>;
    fields?: string[];
    inverted?: boolean;
    reason?: string;
}

export interface Policy {
    id: string;
    name: string;
    description?: string;
    scope: PolicyScope;
    rules: PolicyRule[];
    resourceStatus: string;
    isProtected: boolean;
    createdAt: string;
    updatedAt: string;
}

export interface CreatePolicyRequest {
    name: string;
    description?: string;
    scope: PolicyScope;
    rules: PolicyRule[];
}

export interface UpdatePolicyRequest {
    name?: string;
    description?: string;
    scope?: PolicyScope;
    rules?: PolicyRule[];
    resourceStatus?: 'ENABLED' | 'DISABLED';
    /** Required when editing rules of a policy attached to multiple roles. */
    breakGlass?: BreakGlass;
}

/**
 * Step-up credentials for destructive RBAC operations: missing -> 428,
 * wrong password -> 401, name mismatch -> 400, protected target -> 403.
 */
export interface BreakGlass {
    password?: string;
    confirmationName?: string;
}

export interface PolicyValidationResult {
    valid: boolean;
    errors?: string[];
    warnings?: string[];
}
