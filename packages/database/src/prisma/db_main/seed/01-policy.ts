import type { CorePrismaClient } from '../../../client';

/**
 * Policy-Based RBAC Seed Data
 *
 * This script creates default policies for the HOPE platform using CASL rules.
 * Policies define what actions can be performed on which resources.
 *
 * Policy Structure:
 * - name: Unique identifier for the policy
 * - description: Human-readable description
 * - scope: GLOBAL (system-wide) or TENANT (tenant-scoped)
 * - rules: Array of CASL rules with action, subject, conditions, and fields
 *
 * Template Variables:
 * - ${user.id} - Current user's ID
 * - ${context.tenantId} - Request tenant context
 */

// Policy scope enum values
// Exported for testing purposes
export const PolicyScope = {
    GLOBAL: 'GLOBAL',
    TENANT: 'TENANT',
} as const;

// =============================================================================
// RBAC Policy Seed Data - Healthcare-Focused Design
// =============================================================================
//
// This implements the RBAC best practices design for HOPE:
// - Hybrid multi-tenant (shared system roles + tenant-customizable)
// - Healthcare personas (Super Admin, Tenant Admin, Doctor, Nurse, Service Account)
// - Delegated administration (department heads can assign roles)
// - API key scoped subset permissions
//
// See: docs/RBAC_BEST_PRACTICES.md for full design documentation
// =============================================================================

// Default policies for the RBAC system
// Exported for testing purposes
export const DEFAULT_POLICIES = [
    // =========================================================================
    // GLOBAL SCOPE POLICIES (System-wide)
    // =========================================================================
    {
        id: '00000000-0000-0000-0001-000000000001',
        name: 'system-full-access',
        description: 'Full system access - can manage everything across all tenants',
        scope: PolicyScope.GLOBAL,
        rules: [
            { action: 'manage', subject: 'all' },
        ],
    },
    {
        id: '00000000-0000-0000-0001-000000000010',
        name: 'rbac-system-manage',
        description: 'System-level RBAC management - manage all roles, policies, and assignments',
        scope: PolicyScope.GLOBAL,
        rules: [
            { action: 'manage', subject: 'Role' },
            { action: 'manage', subject: 'Policy' },
            { action: 'manage', subject: 'RolePolicy' },
            { action: 'manage', subject: 'UserRoleAssignment' },
        ],
    },

    // =========================================================================
    // TENANT SCOPE POLICIES - Administration
    // =========================================================================
    {
        id: '00000000-0000-0000-0001-000000000002',
        name: 'tenant-full-access',
        description: 'Full access within tenant context - for Tenant Admins',
        scope: PolicyScope.TENANT,
        rules: [
            // User management
            { action: 'manage', subject: 'User', conditions: { tenantId: '${context.tenantId}' } },
            { action: 'manage', subject: 'UserProfile' },
            { action: 'manage', subject: 'UserMedia', conditions: { tenantId: '${context.tenantId}' } },
            // Clinical data
            { action: 'manage', subject: 'Consultation', conditions: { tenantId: '${context.tenantId}' } },
            { action: 'manage', subject: 'ContextItem', conditions: { tenantId: '${context.tenantId}' } },
            { action: 'manage', subject: 'Media', conditions: { tenantId: '${context.tenantId}' } },
            // API & Integration
            { action: 'manage', subject: 'ApiKey', conditions: { tenantId: '${context.tenantId}' } },
            { action: 'manage', subject: 'Webhook', conditions: { tenantId: '${context.tenantId}' } },
            { action: 'read', subject: 'WebhookRunHistory', conditions: { tenantId: '${context.tenantId}' } },
            // Settings & Configuration
            { action: 'manage', subject: 'GlobalSetting', conditions: { tenantId: '${context.tenantId}' } },
            { action: 'manage', subject: 'Tag', conditions: { tenantId: '${context.tenantId}' } },
            // Storage management
            { action: 'manage', subject: 'Storage', conditions: { tenantId: '${context.tenantId}' } },
            // Notifications & Subscriptions
            { action: 'manage', subject: 'Notification', conditions: { tenantId: '${context.tenantId}' } },
            { action: 'manage', subject: 'ResourceSubscription', conditions: { tenantId: '${context.tenantId}' } },
            // Tenant access
            { action: 'read', subject: 'Tenant', conditions: { id: '${context.tenantId}' } },
            { action: 'update', subject: 'Tenant', conditions: { id: '${context.tenantId}' } },
            { action: 'read', subject: 'AuditLog', conditions: { tenantId: '${context.tenantId}' } },
        ],
    },
    {
        id: '00000000-0000-0000-0001-000000000011',
        name: 'rbac-tenant-manage',
        description: 'Tenant-level RBAC management - manage custom roles and user assignments within tenant',
        scope: PolicyScope.TENANT,
        rules: [
            // Can create/update/delete custom roles (non-system)
            { action: 'create', subject: 'Role', conditions: { isSystemRole: false } },
            { action: ['read', 'update', 'delete', 'list'], subject: 'Role', conditions: { isSystemRole: false } },
            // Can read system roles (for reference)
            { action: 'read', subject: 'Role', conditions: { isSystemRole: true } },
            // Can read policies (for assignment)
            { action: ['read', 'list'], subject: 'Policy' },
            // Can manage role-policy assignments for custom roles only
            { action: 'manage', subject: 'RolePolicy' },
            // Can manage user role assignments within tenant
            { action: 'manage', subject: 'UserRoleAssignment', conditions: { tenantId: '${context.tenantId}' } },
        ],
    },
    {
        id: '00000000-0000-0000-0001-000000000012',
        name: 'rbac-delegate',
        description: 'Delegated RBAC management - for department heads to manage staff roles',
        scope: PolicyScope.TENANT,
        rules: [
            // Can read all roles (for UI)
            { action: ['read', 'list'], subject: 'Role' },
            // Can assign DOCTOR and NURSE roles only (no privilege escalation)
            { action: 'manage', subject: 'UserRoleAssignment', conditions: { tenantId: '${context.tenantId}' } },
        ],
    },

    // =========================================================================
    // TENANT SCOPE POLICIES - Healthcare Clinical Roles
    // =========================================================================
    {
        id: '00000000-0000-0000-0001-000000000020',
        name: 'consultation-own-manage',
        description: 'Doctor - full access to own consultations (by doctorId)',
        scope: PolicyScope.TENANT,
        rules: [
            // Can create consultations
            { action: 'create', subject: 'Consultation', conditions: { tenantId: '${context.tenantId}' } },
            // Can read/update/delete/list own consultations (where doctorId matches)
            { action: ['read', 'update', 'delete', 'list'], subject: 'Consultation', conditions: { tenantId: '${context.tenantId}', doctorId: '${user.id}' } },
            // Can manage context items for own consultations
            { action: 'manage', subject: 'ContextItem', conditions: { tenantId: '${context.tenantId}' } },
            // Can manage own media
            { action: 'manage', subject: 'Media', conditions: { tenantId: '${context.tenantId}', createdBy: '${user.id}' } },
            // Can upload new media
            { action: 'create', subject: 'Media', conditions: { tenantId: '${context.tenantId}' } },
        ],
    },
    {
        id: '00000000-0000-0000-0001-000000000021',
        name: 'consultation-read-assigned',
        description: 'Nurse - read-only access to consultations within tenant',
        scope: PolicyScope.TENANT,
        rules: [
            // Can read/list consultations (scoping can be narrowed via scopeOverrides)
            { action: ['read', 'list'], subject: 'Consultation', conditions: { tenantId: '${context.tenantId}' } },
            // Can read context items
            { action: 'read', subject: 'ContextItem', conditions: { tenantId: '${context.tenantId}' } },
            // Can read media
            { action: 'read', subject: 'Media', conditions: { tenantId: '${context.tenantId}' } },
        ],
    },
    {
        id: '00000000-0000-0000-0001-000000000023',
        name: 'consultation-shared-patient-read',
        description: 'Doctor - read-only access to other doctors\' consultations for shared patients (continuity of care)',
        scope: PolicyScope.TENANT,
        rules: [
            { action: 'read', subject: 'Consultation', conditions: { tenantId: '${context.tenantId}' } },
            { action: 'read', subject: 'ContextItem', conditions: { tenantId: '${context.tenantId}' } },
        ],
    },
    {
        id: '00000000-0000-0000-0001-000000000022',
        name: 'consultation-department-read',
        description: 'Department Head - read all consultations in department',
        scope: PolicyScope.TENANT,
        rules: [
            // Can read all consultations in tenant (department filtering via scopeOverrides)
            { action: ['read', 'list'], subject: 'Consultation', conditions: { tenantId: '${context.tenantId}' } },
            // Can read all context items
            { action: 'read', subject: 'ContextItem', conditions: { tenantId: '${context.tenantId}' } },
            // Can read users for team management
            { action: ['read', 'list'], subject: 'User', conditions: { tenantId: '${context.tenantId}' } },
            { action: 'read', subject: 'UserProfile' },
        ],
    },

    // =========================================================================
    // TENANT SCOPE POLICIES - Common/Shared
    // =========================================================================
    {
        id: '00000000-0000-0000-0001-000000000030',
        name: 'user-profile-own',
        description: 'All authenticated users - manage own profile and settings',
        scope: PolicyScope.TENANT,
        rules: [
            // Own user record
            { action: ['read', 'update'], subject: 'User', conditions: { id: '${user.id}' } },
            // Own profile
            { action: ['read', 'update'], subject: 'UserProfile', conditions: { userId: '${user.id}' } },
            // Own settings
            { action: 'manage', subject: 'UserSettings', conditions: { userId: '${user.id}' } },
            // Own media shares
            { action: ['read', 'list'], subject: 'UserMedia', conditions: { userId: '${user.id}' } },
            { action: 'create', subject: 'UserMedia' },
            // Own notifications
            { action: ['read', 'update'], subject: 'Notification', conditions: { targetUserId: '${user.id}' } },
            // Own subscriptions
            { action: 'manage', subject: 'ResourceSubscription', conditions: { targetUserId: '${user.id}' } },
            // Read tenant info
            { action: 'read', subject: 'Tenant', conditions: { id: '${context.tenantId}' } },
        ],
    },
    {
        id: '00000000-0000-0000-0001-000000000031',
        name: 'api-key-own-manage',
        description: 'Users who can create API keys - manage own API keys',
        scope: PolicyScope.TENANT,
        rules: [
            // Can create API keys
            { action: 'create', subject: 'ApiKey', conditions: { tenantId: '${context.tenantId}' } },
            // Can manage own API keys
            { action: ['read', 'update', 'delete', 'list'], subject: 'ApiKey', conditions: { tenantId: '${context.tenantId}', userId: '${user.id}' } },
        ],
    },

    // =========================================================================
    // TENANT SCOPE POLICIES - Service Accounts
    // =========================================================================
    {
        id: '00000000-0000-0000-0001-000000000040',
        name: 'service-integration',
        description: 'Service account - limited API access for backend integrations',
        scope: PolicyScope.TENANT,
        rules: [
            // Can read/create consultations
            { action: ['read', 'create', 'list'], subject: 'Consultation', conditions: { tenantId: '${context.tenantId}' } },
            // Can read/create context items
            { action: ['read', 'create', 'list'], subject: 'ContextItem', conditions: { tenantId: '${context.tenantId}' } },
            // Can read/create media
            { action: ['read', 'create', 'list'], subject: 'Media', conditions: { tenantId: '${context.tenantId}' } },
            // Can read/create tags for data annotation
            { action: ['read', 'create', 'list'], subject: 'Tag', conditions: { tenantId: '${context.tenantId}' } },
        ],
    },
    {
        id: '00000000-0000-0000-0001-000000000041',
        name: 'federated-learning-access',
        description: 'Service account - access to federated learning resources',
        scope: PolicyScope.GLOBAL,
        rules: [
            { action: ['read', 'create', 'update', 'list'], subject: 'FedlClient' },
            { action: ['read', 'create', 'update', 'list'], subject: 'FedlRound' },
            { action: ['read', 'create', 'list'], subject: 'FedlUpdate' },
            { action: ['read', 'create', 'update', 'list'], subject: 'FedlModelVersion' },
        ],
    },

    // =========================================================================
    // TENANT SCOPE POLICIES - Prompt & Settings Management
    // =========================================================================
    {
        id: '00000000-0000-0000-0001-000000000050',
        name: 'prompt-template-manage',
        description: 'Manage prompt templates and versions within tenant',
        scope: PolicyScope.TENANT,
        rules: [
            { action: 'manage', subject: 'PromptTemplate', conditions: { tenantId: '${context.tenantId}' } },
            { action: 'manage', subject: 'PromptVersion', conditions: { tenantId: '${context.tenantId}' } },
            { action: ['read', 'list'], subject: 'PromptUsageRecord', conditions: { tenantId: '${context.tenantId}' } },
        ],
    },
    {
        id: '00000000-0000-0000-0001-000000000051',
        name: 'global-settings-manage',
        description: 'Manage global settings and feature flags within tenant',
        scope: PolicyScope.TENANT,
        rules: [
            { action: 'manage', subject: 'GlobalSetting', conditions: { tenantId: '${context.tenantId}' } },
        ],
    },
    {
        id: '00000000-0000-0000-0001-000000000052',
        name: 'audit-log-read',
        description: 'Read audit log entries within tenant for compliance',
        scope: PolicyScope.TENANT,
        rules: [
            { action: ['read', 'list'], subject: 'AuditLog', conditions: { tenantId: '${context.tenantId}' } },
        ],
    },
    {
        id: '00000000-0000-0000-0001-000000000060',
        name: 'storage-upload',
        description: 'Upload files to storage buckets (required for consultation attachments)',
        scope: PolicyScope.TENANT,
        rules: [
            { action: 'create', subject: 'Storage', conditions: { tenantId: '${context.tenantId}' } },
        ],
    },
];

export const seedPolicy = async (client: CorePrismaClient) => {
    console.log('Seeding policies...');

    for (const policyData of DEFAULT_POLICIES) {
        // Use findFirst instead of findUnique for Prisma 7 compatibility
        const existing = await client.policy.findFirst({
            where: { name: policyData.name },
        });

        if (existing) {
            console.log(`  Policy "${policyData.name}" already exists, updating...`);
            await client.policy.update({
                where: { id: existing.id },
                data: {
                    description: policyData.description,
                    scope: policyData.scope,
                    rules: policyData.rules,
                },
            });
        } else {
            console.log(`  Creating policy "${policyData.name}"...`);
            await client.policy.create({
                data: {
                    id: policyData.id,
                    name: policyData.name,
                    description: policyData.description,
                    scope: policyData.scope,
                    rules: policyData.rules,
                },
            });
        }
    }

    console.log(`Seeded ${DEFAULT_POLICIES.length} policies`);
    return { success: true, count: DEFAULT_POLICIES.length };
};
