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
    /**
     * Users holding this role, tenant-scoped for tenant-scoped
     * callers. Present on read responses only (mutations return no count).
     */
    memberCount?: number;
}

/**
 * One member of a role (`GET admin/rbac/roles/:id/members`).
 * `resourceStatus` is the membership (assignment) status; `userResourceStatus`
 * the account status; `department` is scoped to the assignment's tenant.
 */
export interface RoleMember {
    assignmentId: string;
    userId: string;
    tenantId: string;
    username: string;
    displayName: string;
    email: string | null;
    department: string | null;
    resourceStatus: string;
    userResourceStatus: string;
    assignedAt: string;
}

export interface CreateRoleRequest {
    name: string;
    description?: string;
    externalName?: string;
    externalId?: string;
    parentRoleId?: string;
    /** Global admin only — server rejects for a non-elevated caller. */
    isSystemRole?: boolean;
}

/** Clone a role (SYSTEM or CUSTOM) into a new CUSTOM role. */
export interface CloneRoleRequest {
    name: string;
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
    // CASL serializes both as a single value OR a list — the gateway ships
    // array actions (e.g. `["read","update","delete","list"]`).
    action: string | string[];
    subject: string | string[];
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
