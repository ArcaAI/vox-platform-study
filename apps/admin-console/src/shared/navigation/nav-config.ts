import { canAny, type PermissionRule } from '@/shared/auth/ability';

/**
 * Full route map from the capabilities matrix (section 3, frames 10-40, as
 * reviewed 2026-07-04: AI models re-tiered to 10-19, tenant frontend config
 * folded into the tenant-detail tab). All design gates cleared (B0/B1/B2
 * approved 2026-07-05): every route is implemented. The sidebar only renders
 * implemented entries the caller's ability grants.
 */
export type NavTier = '10-19' | '20-29' | '30-49';

export interface NavEntry {
    route: string;
    label: string;
    tier: NavTier;
    /**
     * Ability gate: visible when ANY pair is granted (mirrors the gateway's
     * CanAny guards). An empty list means any authenticated user.
     */
    required: ReadonlyArray<readonly [string, string]>;
    implemented: boolean;
}

export interface NavSection {
    tier: NavTier;
    label: string;
}

export const NAV_SECTIONS: readonly NavSection[] = [
    { tier: '10-19', label: 'Platform' },
    { tier: '20-29', label: 'Administration' },
    { tier: '30-49', label: 'Tenant' },
];

export const NAV_ENTRIES: readonly NavEntry[] = [
    // Tier 10-19 — global admin (cross-tenant). Tenant frontend config is a
    // tenant-detail tab (matrix row 6), not a standalone nav entry.
    { route: '/dashboard', label: 'Dashboard', tier: '10-19', required: [['manage', 'PlatformMetrics']], implemented: true },
    { route: '/monitoring', label: 'Monitoring', tier: '10-19', required: [['manage', 'all'], ['read', 'TenantTelemetry']], implemented: true },
    { route: '/tenants', label: 'Tenants', tier: '10-19', required: [['manage', 'Tenant'], ['update', 'Tenant']], implemented: true },
    { route: '/entitlements', label: 'Entitlements & plans', tier: '10-19', required: [['manage', 'all']], implemented: true },
    { route: '/tenants/storage', label: 'Tenant storage', tier: '10-19', required: [['manage', 'Tenant'], ['read', 'Storage']], implemented: true },
    // Global-admin only per the 2026-07-04 review (backend guard re-pin: TASK-419).
    { route: '/ai-models', label: 'AI models', tier: '10-19', required: [['manage', 'all']], implemented: true },
    { route: '/rate-limits', label: 'Rate limits', tier: '10-19', required: [['manage', 'all']], implemented: true },
    { route: '/queues', label: 'Queues & jobs', tier: '10-19', required: [['manage', 'all']], implemented: true },
    { route: '/schedulers', label: 'Schedulers', tier: '10-19', required: [['manage', 'all']], implemented: true },
    { route: '/audit-logs', label: 'Audit logs', tier: '10-19', required: [['read', 'AuditLog']], implemented: true },
    { route: '/pstudio', label: 'Prisma Studio', tier: '10-19', required: [['manage', 'all']], implemented: true },

    // Tier 20-29 — shared (cross-tenant or tenant-scoped)
    { route: '/users', label: 'Users', tier: '20-29', required: [['manage', 'User']], implemented: true },
    { route: '/rbac/roles', label: 'Roles', tier: '20-29', required: [['read', 'Role'], ['manage', 'Role']], implemented: true },
    { route: '/rbac/policies', label: 'Policies', tier: '20-29', required: [['read', 'Policy'], ['manage', 'Policy']], implemented: true },
    { route: '/api-keys', label: 'API keys', tier: '20-29', required: [['read', 'ApiKey'], ['manage', 'ApiKey']], implemented: true },
    { route: '/settings', label: 'Settings & secrets', tier: '20-29', required: [['manage', 'GlobalSetting']], implemented: true },
    { route: '/tenant-profile', label: 'Tenant profile', tier: '20-29', required: [['read', 'Tenant'], ['update', 'Tenant']], implemented: true },
    { route: '/account', label: 'Account', tier: '20-29', required: [], implemented: true },

    // Tier 30-49 — tenant-admin scope (a global admin needs a working tenant)
    { route: '/departments', label: 'Departments', tier: '30-49', required: [['manage', 'Department']], implemented: true },
    { route: '/storage', label: 'Storage browser', tier: '30-49', required: [['read', 'Storage'], ['manage', 'Storage']], implemented: true },
    { route: '/agents', label: 'Agents', tier: '30-49', required: [['manage', 'PromptTemplate']], implemented: true },
    { route: '/dna-writing-styles', label: 'DNA writing styles', tier: '30-49', required: [['manage', 'DnaWritingStyleReport']], implemented: true },
    { route: '/audio/pipelines', label: 'Audio pipelines', tier: '30-49', required: [['manage', 'AsrPipeline']], implemented: true },
    { route: '/audio/transcription-jobs', label: 'Transcription jobs', tier: '30-49', required: [['read', 'AsrPipeline'], ['manage', 'Tenant']], implemented: true },
    { route: '/harness/policy', label: 'Harness policy', tier: '30-49', required: [['read', 'HarnessPolicy'], ['manage', 'HarnessPolicy']], implemented: true },
    {
        route: '/harness/observability',
        label: 'Harness observability',
        tier: '30-49',
        required: [['read', 'HarnessAudit'], ['read', 'HarnessEval'], ['read', 'HarnessWorkflow']],
        implemented: true,
    },
    { route: '/harness/workflows', label: 'Harness workflows', tier: '30-49', required: [['read', 'HarnessWorkflow'], ['manage', 'HarnessWorkflow']], implemented: true },
    { route: '/harness/pipeline-policy', label: 'Pipeline policy', tier: '30-49', required: [['read', 'PipelinePolicy'], ['manage', 'PipelinePolicy']], implemented: true },
    { route: '/consultations', label: 'Consultations', tier: '30-49', required: [['manage', 'Consultation']], implemented: true },
];

/** Implemented entries the caller's ability grants, in declaration order. */
export function visibleNavEntries(rules: readonly PermissionRule[] | null | undefined): NavEntry[] {
    return NAV_ENTRIES.filter((entry) => entry.implemented && (entry.required.length === 0 ? !!rules : canAny(rules, entry.required)));
}
