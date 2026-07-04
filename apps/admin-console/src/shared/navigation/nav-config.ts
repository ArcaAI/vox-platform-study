import { canAny, type PermissionRule } from '@/shared/auth/ability';

/**
 * Full route map from the capabilities matrix (section 3, frames 10-41).
 * Feature screens are BLOCKED behind the Figma design gate: every entry ships
 * with implemented=false except the dashboard placeholder. Flip the flag as
 * screens land — the sidebar only renders implemented entries.
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
    // Tier 10-19 — global / super-admin (cross-tenant)
    { route: '/dashboard', label: 'Dashboard', tier: '10-19', required: [['manage', 'PlatformMetrics']], implemented: true },
    { route: '/monitoring', label: 'Monitoring', tier: '10-19', required: [['manage', 'all'], ['read', 'TenantTelemetry']], implemented: false },
    { route: '/tenants', label: 'Tenants', tier: '10-19', required: [['manage', 'Tenant'], ['update', 'Tenant']], implemented: false },
    { route: '/entitlements', label: 'Entitlements & plans', tier: '10-19', required: [['manage', 'all']], implemented: false },
    { route: '/tenants/storage', label: 'Tenant storage', tier: '10-19', required: [['manage', 'Tenant'], ['read', 'Storage']], implemented: false },
    { route: '/tenants/frontend-config', label: 'Frontend config', tier: '10-19', required: [['manage', 'Tenant'], ['update', 'Tenant']], implemented: false },
    { route: '/rate-limits', label: 'Rate limits', tier: '10-19', required: [['manage', 'all']], implemented: false },
    { route: '/queues', label: 'Queues & jobs', tier: '10-19', required: [['manage', 'all']], implemented: false },
    { route: '/schedulers', label: 'Schedulers', tier: '10-19', required: [['manage', 'all']], implemented: false },
    { route: '/audit-logs', label: 'Audit logs', tier: '10-19', required: [['read', 'AuditLog']], implemented: false },
    { route: '/pstudio', label: 'Prisma Studio', tier: '10-19', required: [['manage', 'all']], implemented: false },

    // Tier 20-29 — shared (cross-tenant or tenant-scoped)
    { route: '/users', label: 'Users', tier: '20-29', required: [['manage', 'User']], implemented: false },
    { route: '/rbac/roles', label: 'Roles', tier: '20-29', required: [['read', 'Role'], ['manage', 'Role']], implemented: false },
    { route: '/rbac/policies', label: 'Policies', tier: '20-29', required: [['read', 'Policy'], ['manage', 'Policy']], implemented: false },
    { route: '/api-keys', label: 'API keys', tier: '20-29', required: [['read', 'ApiKey'], ['manage', 'ApiKey']], implemented: false },
    { route: '/settings', label: 'Settings & secrets', tier: '20-29', required: [['manage', 'GlobalSetting']], implemented: false },
    { route: '/tenant-profile', label: 'Tenant profile', tier: '20-29', required: [['read', 'Tenant'], ['update', 'Tenant']], implemented: false },
    { route: '/account', label: 'Account', tier: '20-29', required: [], implemented: false },

    // Tier 30-49 — tenant-admin scope (super-admin needs a working tenant)
    { route: '/departments', label: 'Departments', tier: '30-49', required: [['manage', 'Department']], implemented: false },
    { route: '/storage', label: 'Storage browser', tier: '30-49', required: [['read', 'Storage'], ['manage', 'Storage']], implemented: false },
    { route: '/agents', label: 'Agents', tier: '30-49', required: [['manage', 'PromptTemplate']], implemented: false },
    { route: '/dna-writing-styles', label: 'DNA writing styles', tier: '30-49', required: [['manage', 'DnaWritingStyleReport']], implemented: false },
    { route: '/ai-models', label: 'AI models', tier: '30-49', required: [['manage', 'AiModel']], implemented: false },
    { route: '/audio/pipelines', label: 'Audio pipelines', tier: '30-49', required: [['manage', 'AsrPipeline']], implemented: false },
    { route: '/audio/transcription-jobs', label: 'Transcription jobs', tier: '30-49', required: [['read', 'AsrPipeline'], ['manage', 'Tenant']], implemented: false },
    { route: '/harness/policy', label: 'Harness policy', tier: '30-49', required: [['read', 'HarnessPolicy'], ['manage', 'HarnessPolicy']], implemented: false },
    {
        route: '/harness/observability',
        label: 'Harness observability',
        tier: '30-49',
        required: [['read', 'HarnessAudit'], ['read', 'HarnessEval'], ['read', 'HarnessWorkflow']],
        implemented: false,
    },
    { route: '/harness/workflows', label: 'Harness workflows', tier: '30-49', required: [['read', 'HarnessWorkflow'], ['manage', 'HarnessWorkflow']], implemented: false },
    { route: '/harness/pipeline-policy', label: 'Pipeline policy', tier: '30-49', required: [['read', 'PipelinePolicy'], ['manage', 'PipelinePolicy']], implemented: false },
    { route: '/consultations', label: 'Consultations', tier: '30-49', required: [['manage', 'Consultation']], implemented: false },
];

/** Implemented entries the caller's ability grants, in declaration order. */
export function visibleNavEntries(rules: readonly PermissionRule[] | null | undefined): NavEntry[] {
    return NAV_ENTRIES.filter((entry) => entry.implemented && (entry.required.length === 0 ? !!rules : canAny(rules, entry.required)));
}
