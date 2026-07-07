import {
    IconActivity,
    IconAdjustmentsAlt,
    IconBrain,
    IconBroadcast,
    IconBuilding,
    IconBuildings,
    IconCalendarTime,
    IconDatabase,
    IconDatabaseSearch,
    IconDna,
    IconDna2,
    IconFolders,
    IconGauge,
    IconHeartbeat,
    IconHistory,
    IconKey,
    IconLayoutDashboard,
    IconLicense,
    IconMicrophone,
    IconRobot,
    IconRoute,
    IconSettings,
    IconShieldCog,
    IconShieldLock,
    IconSitemap,
    IconSparkles,
    IconStack2,
    IconStethoscope,
    IconTelescope,
    IconUserCircle,
    IconUsers,
    IconUserScan,
    IconUserShield,
    IconWaveSine,
    type TablerIcon,
} from '@tabler/icons-react';
import { canAny, isElevated, type PermissionRule } from '@/shared/auth/ability';

/**
 * Full route map from the capabilities matrix (section 3, frames 10-40, as
 * reviewed 2026-07-04: AI models re-tiered to 10-19, tenant frontend config
 * folded into the tenant-detail tab). All design gates cleared (B0/B1/B2
 * approved 2026-07-05; Playground 50-59 approved 2026-07-06, TASK-420). The
 * sidebar only renders implemented entries the caller's ability grants;
 * AI models is hidden (implemented: false).
 */
export type NavTier = '10-19' | '20-29' | '30-49' | '50-59';

export interface NavEntry {
    route: string;
    label: string;
    tier: NavTier;
    /** Decorative leading icon; the icon-collapsed rail shows it alone (unique per entry). */
    icon: TablerIcon;
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
    { tier: '50-59', label: 'Playground' },
];

export const NAV_ENTRIES: readonly NavEntry[] = [
    // Tier 10-19 — global admin (cross-tenant). Tenant frontend config is a
    // tenant-detail tab (matrix row 6), not a standalone nav entry.
    { route: '/dashboard', label: 'Dashboard', tier: '10-19', icon: IconLayoutDashboard, required: [['manage', 'PlatformMetrics']], implemented: true },
    { route: '/monitoring', label: 'Monitoring', tier: '10-19', icon: IconActivity, required: [['manage', 'all'], ['read', 'TenantTelemetry']], implemented: true },
    { route: '/tenants', label: 'Tenants', tier: '10-19', icon: IconBuildings, required: [['manage', 'Tenant'], ['update', 'Tenant']], implemented: true },
    { route: '/entitlements', label: 'Entitlements & plans', tier: '10-19', icon: IconLicense, required: [['manage', 'all']], implemented: true },
    { route: '/tenants/storage', label: 'Tenant storage', tier: '10-19', icon: IconDatabase, required: [['manage', 'Tenant'], ['read', 'Storage']], implemented: true },
    // Global-admin only per the 2026-07-04 review (backend guard re-pin: TASK-419).
    // Hidden from the sidebar/palette (route stays reachable by direct URL).
    { route: '/ai-models', label: 'AI models', tier: '10-19', icon: IconBrain, required: [['manage', 'all']], implemented: false },
    { route: '/rate-limits', label: 'Rate limits', tier: '10-19', icon: IconGauge, required: [['manage', 'all']], implemented: true },
    { route: '/queues', label: 'Queues & jobs', tier: '10-19', icon: IconStack2, required: [['manage', 'all']], implemented: true },
    { route: '/schedulers', label: 'Schedulers', tier: '10-19', icon: IconCalendarTime, required: [['manage', 'all']], implemented: true },
    { route: '/audit-logs', label: 'Audit logs', tier: '10-19', icon: IconHistory, required: [['read', 'AuditLog']], implemented: true },
    { route: '/pstudio', label: 'Prisma Studio', tier: '10-19', icon: IconDatabaseSearch, required: [['manage', 'all']], implemented: true },

    // Tier 20-29 — shared (cross-tenant or tenant-scoped)
    { route: '/users', label: 'Users', tier: '20-29', icon: IconUsers, required: [['manage', 'User']], implemented: true },
    { route: '/rbac/roles', label: 'Roles', tier: '20-29', icon: IconUserShield, required: [['read', 'Role'], ['manage', 'Role']], implemented: true },
    { route: '/rbac/policies', label: 'Policies', tier: '20-29', icon: IconShieldLock, required: [['read', 'Policy'], ['manage', 'Policy']], implemented: true },
    { route: '/api-keys', label: 'API keys', tier: '20-29', icon: IconKey, required: [['read', 'ApiKey'], ['manage', 'ApiKey']], implemented: true },
    { route: '/settings', label: 'Settings & secrets', tier: '20-29', icon: IconSettings, required: [['manage', 'GlobalSetting']], implemented: true },
    { route: '/tenant-profile', label: 'Tenant profile', tier: '20-29', icon: IconBuilding, required: [['read', 'Tenant'], ['update', 'Tenant']], implemented: true },
    { route: '/account', label: 'Account', tier: '20-29', icon: IconUserCircle, required: [], implemented: true },

    // Tier 30-49 — tenant-admin scope (a global admin needs a working tenant)
    { route: '/departments', label: 'Departments', tier: '30-49', icon: IconSitemap, required: [['manage', 'Department']], implemented: true },
    { route: '/storage', label: 'Storage browser', tier: '30-49', icon: IconFolders, required: [['read', 'Storage'], ['manage', 'Storage']], implemented: true },
    { route: '/agents', label: 'Agents', tier: '30-49', icon: IconRobot, required: [['manage', 'PromptTemplate']], implemented: true },
    { route: '/dna-writing-styles', label: 'DNA writing styles', tier: '30-49', icon: IconDna, required: [['manage', 'DnaWritingStyleReport']], implemented: true },
    { route: '/audio/pipelines', label: 'Audio pipelines', tier: '30-49', icon: IconWaveSine, required: [['manage', 'AsrPipeline']], implemented: true },
    { route: '/audio/transcription-jobs', label: 'Transcription jobs', tier: '30-49', icon: IconMicrophone, required: [['read', 'AsrPipeline'], ['manage', 'Tenant']], implemented: true },
    { route: '/harness/policy', label: 'Harness policy', tier: '30-49', icon: IconShieldCog, required: [['read', 'HarnessPolicy'], ['manage', 'HarnessPolicy']], implemented: true },
    {
        route: '/harness/observability',
        label: 'Harness observability',
        tier: '30-49',
        icon: IconTelescope,
        required: [['read', 'HarnessAudit'], ['read', 'HarnessEval'], ['read', 'HarnessWorkflow']],
        implemented: true,
    },
    { route: '/harness/workflows', label: 'Harness workflows', tier: '30-49', icon: IconRoute, required: [['read', 'HarnessWorkflow'], ['manage', 'HarnessWorkflow']], implemented: true },
    { route: '/harness/pipeline-policy', label: 'Pipeline policy', tier: '30-49', icon: IconAdjustmentsAlt, required: [['read', 'PipelinePolicy'], ['manage', 'PipelinePolicy']], implemented: true },
    { route: '/consultations', label: 'Consultations', tier: '30-49', icon: IconStethoscope, required: [['manage', 'Consultation']], implemented: true },

    // Tier 50-59 — Playground (TASK-420, approved 2026-07-06). End-user demo
    // planes run under the admin's OWN account, so the backend guards are
    // plain @Authorize() — visibility is role-gated (GLOBAL_ADMIN or
    // TENANT_ADMIN) via visibleNavEntries, mirroring the (playground) layout.
    { route: '/playground/consultation', label: 'Consultation demo', tier: '50-59', icon: IconHeartbeat, required: [], implemented: true },
    { route: '/playground/live-transcription', label: 'Live transcription', tier: '50-59', icon: IconBroadcast, required: [], implemented: true },
    { route: '/playground/voice-profiles', label: 'Voice profiles', tier: '50-59', icon: IconUserScan, required: [], implemented: true },
    { route: '/playground/dna-writing-style', label: 'My DNA style', tier: '50-59', icon: IconDna2, required: [], implemented: true },
    { route: '/playground/llm', label: 'LLM playground', tier: '50-59', icon: IconSparkles, required: [], implemented: true },
];

/** The playground audience — mirrors the (playground) route-group guard. */
function isAdminTier(roles: readonly string[] | null | undefined): boolean {
    return isElevated(roles) || !!roles?.includes('TENANT_ADMIN');
}

/**
 * Implemented entries the caller's ability grants, in declaration order.
 * Tier 50-59 additionally requires an admin role (`roles`), mirroring the
 * (playground) route-group guard — ability rules alone cannot express it.
 */
/** Longest-prefix nav match — `/tenants/storage` beats `/tenants`. */
export function matchNavEntry(pathname: string, entries: readonly NavEntry[] = NAV_ENTRIES): NavEntry | undefined {
    return entries
        .filter((e) => pathname === e.route || pathname.startsWith(`${e.route}/`))
        .sort((a, b) => b.route.length - a.route.length)[0];
}

export function visibleNavEntries(rules: readonly PermissionRule[] | null | undefined, roles?: readonly string[] | null): NavEntry[] {
    return NAV_ENTRIES.filter((entry) => {
        if (!entry.implemented) return false;
        if (entry.tier === '50-59' && !isAdminTier(roles)) return false;
        return entry.required.length === 0 ? !!rules : canAny(rules, entry.required);
    });
}
