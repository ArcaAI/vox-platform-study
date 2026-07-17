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
        // TASK-409 — anti-lockout protected marker (rename-proof; pairs with the
        // legacy name match in PolicyService.PROTECTED_SYSTEM_POLICIES).
        isProtected: true,
        rules: [
            { action: 'manage', subject: 'all' },
        ],
    },
    {
        id: '00000000-0000-0000-0001-000000000010',
        name: 'rbac-system-manage',
        description: 'System-level RBAC management - manage all roles, policies, and assignments',
        scope: PolicyScope.GLOBAL,
        // TASK-409 — anti-lockout protected marker (see system-full-access above).
        isProtected: true,
        rules: [
            { action: 'manage', subject: 'Role' },
            { action: 'manage', subject: 'Policy' },
            { action: 'manage', subject: 'RolePolicy' },
            { action: 'manage', subject: 'UserRoleAssignment' },
        ],
    },
    {
        id: '00000000-0000-0000-0001-000000000080',
        name: 'prisma-studio-manage',
        description: 'Access the embedded Prisma Studio database browser (dedicated production-capable grant)',
        scope: PolicyScope.GLOBAL,
        // TASK-419 item 4 — Prisma Studio runs raw SQL against the unscoped
        // client (untenanted, privileged). Access is a DEDICATED subject so it
        // can be granted/delegated without handing out `manage:all`; the module
        // itself additionally requires the ENABLE_PRISMA_STUDIO env flag
        // (fail-closed default). Granted to the GLOBAL_ADMIN policy set.
        rules: [
            { action: 'manage', subject: 'PrismaStudio' },
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
            // Departments & ASR pipelines (TASK-331 doc-04 F1) — close the
            // nav↔backend gap: tenant admins self-serve their own tenant's
            // departments and audio (ASR) pipelines, both tenant-scoped.
            { action: 'manage', subject: 'Department', conditions: { tenantId: '${context.tenantId}' } },
            { action: 'manage', subject: 'AsrPipeline', conditions: { tenantId: '${context.tenantId}' } },
            // AI model catalog (TASK-356 Phase 1) — tenant admins self-serve
            // their own tenant's clone of the SYSTEM model catalog. Tenant-scoped
            // (SUPER_ADMIN already covered by the `manage:all` system grant).
            { action: 'manage', subject: 'AiModel', conditions: { tenantId: '${context.tenantId}' } },
            // DNA writing-style management (TASK-326 X7) — tenant admins manage
            // their own tenant's doctor writing-style reports. The service still
            // enforces the PHI/tenant scope guard (`assertReportInScope`); even
            // SUPER_ADMIN cannot cross tenants on these PHI-derived artifacts.
            { action: 'manage', subject: 'DnaWritingStyleReport', conditions: { tenantId: '${context.tenantId}' } },
            // Notifications & Subscriptions
            { action: 'manage', subject: 'Notification', conditions: { tenantId: '${context.tenantId}' } },
            { action: 'manage', subject: 'ResourceSubscription', conditions: { tenantId: '${context.tenantId}' } },
            // Tenant access
            { action: 'read', subject: 'Tenant', conditions: { id: '${context.tenantId}' } },
            { action: 'update', subject: 'Tenant', conditions: { id: '${context.tenantId}' } },
            { action: 'read', subject: 'AuditLog', conditions: { tenantId: '${context.tenantId}' } },
            // TASK-386 (#21) — tenant-scoped telemetry: tenant admins read their
            // own tenant's service sessions/health/uptime (the widened
            // MonitoringController + ApiHealthController `/services` gates accept
            // `read:TenantTelemetry`). SUPER_ADMIN is covered by `manage:all`.
            { action: 'read', subject: 'TenantTelemetry', conditions: { tenantId: '${context.tenantId}' } },
            // Clinical documentation harness (TASK-330 Phase 6) — tenant admins
            // self-serve their own tenant's harness: tune the policy + drive the
            // gate/Temporal workflow ops, and read the WORM audit trail + eval
            // runs. All tenant-scoped (the admin controller + policy service
            // additionally pin every read/write to the caller's tenant).
            // TASK-419 item 1 — HarnessEval upgraded read → manage: golden-set
            // curation (`POST /admin/harness/golden-sets*`) is a tenant-admin
            // capability. HarnessAudit stays read-only (WORM).
            { action: 'manage', subject: 'HarnessPolicy', conditions: { tenantId: '${context.tenantId}' } },
            { action: 'manage', subject: 'HarnessWorkflow', conditions: { tenantId: '${context.tenantId}' } },
            { action: 'read', subject: 'HarnessAudit', conditions: { tenantId: '${context.tenantId}' } },
            { action: 'manage', subject: 'HarnessEval', conditions: { tenantId: '${context.tenantId}' } },
            // Realtime-pipeline toggle cascade (TASK-356 Phase 5) — tenant admins
            // manage their own tenant's PipelinePolicy rows (auto-summary / auto-NER
            // / harness-vs-legacy routing). A SEPARATE subject from HarnessPolicy so
            // realtime-toggle admin stays decoupled from harness-gating admin. `manage`
            // implies `read` (used by the GET routes). Tenant-scoped; the controller
            // pins every read/write to the caller's tenant.
            { action: 'manage', subject: 'PipelinePolicy', conditions: { tenantId: '${context.tenantId}' } },
            // TASK-496 — tenant admins manage their own tenant's TTS config + BYO
            // provider credentials. Tenant-scoped; the controller pins every op to
            // the caller's tenant. `manage` implies `read` (used by the GET routes).
            { action: 'manage', subject: 'TenantTtsConfig', conditions: { tenantId: '${context.tenantId}' } },
            // TASK-506 — tenant admins read + manage their own tenant's AI
            // task-model defaults (AiTaskDefault). Tenant-scoped; global admins
            // are covered by `manage:all`. NOTE (governance): tenant admins DO
            // hold manage:AiTaskDefault here — the `guardrail.*` task-key
            // restriction (GLOBAL-ADMIN-ONLY writes) is enforced at the
            // application-service layer, not by RBAC.
            { action: ['read', 'manage'], subject: 'AiTaskDefault', conditions: { tenantId: '${context.tenantId}' } },
            // TASK-498 — tenant admins manage their own tenant's external OIDC
            // identity provider config. Tenant-scoped; the controller pins every
            // op to the caller's tenant. `manage` implies `read` (used by the GET
            // routes). GLOBAL_ADMIN already covers this via the wildcard `manage
            // all` rule above.
            { action: 'manage', subject: 'TenantIdentityProvider', conditions: { tenantId: '${context.tenantId}' } },
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
            // Own voice profile (biometric data — user-owned only, not exposed to tenant admins)
            { action: 'manage', subject: 'UserVoiceProfile', conditions: { userId: '${user.id}' } },
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
    // TASK-331 doc-09 — end-user (clinician) read-only prompt-template ability.
    // Clinicians need to populate the Pre-Summary / Summary template selector
    // via the end-user `GET /prompt-templates/available` route. This grants ONLY
    // `read`+`list` on PromptTemplate (tenant-scoped) — NOT `manage`. Combined
    // with doc-09 D1 (the admin read surface bumped to `manage:PromptTemplate`),
    // this ability satisfies the end-user controller without opening the admin
    // `/admin/prompt-templates` GET routes (list-all / drafts / peers' personal
    // templates / usage analytics) to doctors.
    {
        id: '00000000-0000-0000-0001-000000000053',
        name: 'prompt-template-read',
        description: 'Read-only access to prompt templates within tenant (clinician template selector)',
        scope: PolicyScope.TENANT,
        rules: [
            { action: ['read', 'list'], subject: 'PromptTemplate', conditions: { tenantId: '${context.tenantId}' } },
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

    // =========================================================================
    // CLINICAL DOCUMENTATION HARNESS (TASK-330 Phase 6)
    // =========================================================================
    // Subjects: HarnessPolicy (the runtime knobs that drive the document loop),
    // HarnessWorkflow (Temporal document-workflow ops + the clinician gate queue),
    // HarnessAudit (the append-only WORM audit trail), HarnessEval (eval runs +
    // per-case scores). Used by `/admin/harness/*` (`HarnessAdminController`).
    {
        // Platform operators: administer the harness across ALL tenants. (Super
        // admins are already covered by `system-full-access`; this is the discrete,
        // re-usable platform grant for a non-super harness-operator role.)
        id: '00000000-0000-0000-0001-000000000070',
        name: 'harness-platform-manage',
        description: 'Platform-level clinical documentation harness administration — manage policy + Temporal workflow ops + eval datasets/runs and read the WORM audit trail across all tenants',
        scope: PolicyScope.GLOBAL,
        rules: [
            { action: 'manage', subject: 'HarnessPolicy' },
            { action: 'manage', subject: 'HarnessWorkflow' },
            { action: 'read', subject: 'HarnessAudit' },
            // TASK-419 item 1 — manage (was read): golden-set curation.
            { action: 'manage', subject: 'HarnessEval' },
            // TASK-356 Phase 5 — platform-wide realtime-pipeline cascade admin
            // (incl. the SYSTEM-tenant global-default row). `manage` implies `read`.
            { action: 'manage', subject: 'PipelinePolicy' },
        ],
    },
    {
        // Tenant-scoped harness administration — the same grant as
        // `harness-platform-manage` but pinned to the caller's tenant. The
        // tenant-scoped abilities are also folded into `tenant-full-access` so
        // tenant admins get them out of the box; this stays a discrete re-usable
        // policy for custom (e.g. harness-operator) tenant roles.
        id: '00000000-0000-0000-0001-000000000071',
        name: 'harness-tenant-manage',
        description: 'Tenant-scoped clinical documentation harness administration — manage the tenant policy + Temporal workflow ops + eval datasets/runs and read the WORM audit trail within the tenant',
        scope: PolicyScope.TENANT,
        rules: [
            { action: 'manage', subject: 'HarnessPolicy', conditions: { tenantId: '${context.tenantId}' } },
            { action: 'manage', subject: 'HarnessWorkflow', conditions: { tenantId: '${context.tenantId}' } },
            { action: 'read', subject: 'HarnessAudit', conditions: { tenantId: '${context.tenantId}' } },
            // TASK-419 item 1 — manage (was read): golden-set curation.
            { action: 'manage', subject: 'HarnessEval', conditions: { tenantId: '${context.tenantId}' } },
            // TASK-356 Phase 5 — tenant-scoped realtime-pipeline cascade admin.
            // `manage` implies `read`; the controller pins every op to the tenant.
            { action: 'manage', subject: 'PipelinePolicy', conditions: { tenantId: '${context.tenantId}' } },
        ],
    },
];

export const seedPolicy = async (client: CorePrismaClient) => {
    console.log('Seeding policies...');

    for (const policyData of DEFAULT_POLICIES) {
        // TASK-409 — only assert `isProtected` when the seed data explicitly
        // defines it (the two system-critical policies). Policies without the
        // marker rely on the column default and are never clobbered here.
        const isProtected = (policyData as { isProtected?: boolean }).isProtected;
        const protectedPatch = isProtected === undefined ? {} : { isProtected };

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
                    ...protectedPatch,
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
                    ...protectedPatch,
                },
            });
        }
    }

    console.log(`Seeded ${DEFAULT_POLICIES.length} policies`);
    return { success: true, count: DEFAULT_POLICIES.length };
};
