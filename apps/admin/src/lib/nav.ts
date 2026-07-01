import type { LucideIcon } from 'lucide-react';
import { Activity, Building2, FolderTree, Gauge, History, KeyRound, LayoutDashboard, Radio, ScrollText, Settings, Shield, Users } from 'lucide-react';
import { isSuperAdmin, isTenantAdmin } from '@/features/tenants/permissions';

export interface NavItem {
    label: string;
    to: string;
    icon: LucideIcon;
    /** Short caption shown under the section, mirrors TASK-371 pillars. */
    description?: string;
    /** Default-deny RBAC (X5): when true, only platform super-admins see the item. */
    requireSuperAdmin?: boolean;
    /**
     * Admin-tier gate (TASK-391 follow-up): when true, the item is visible to
     * tenant-admins **and** super-admins (but not regular users) — they
     * legitimately manage their own tenant's data. Mirrors the server CASL as a
     * visibility hint only; same default-deny pattern as {@link requireSuperAdmin}.
     */
    requireAdmin?: boolean;
}

export interface NavSection {
    /** Design-aligned tier label (TASK-371 §5.12). */
    title: string;
    items: NavItem[];
}

/**
 * Role-tiered navigation (TASK-379). Tiers mirror the design's section labels;
 * the **Platform** tier (cross-tenant tenant management) is super-admin only, so
 * a tenant-admin's nav is scoped to their own workspace. Only routes that exist
 * today are listed (no placeholders for unbuilt Dashboard/Queues surfaces).
 */
const ALL_SECTIONS: NavSection[] = [
    {
        title: 'Overview',
        items: [
            { label: 'Dashboard', to: '/dashboard', icon: LayoutDashboard, description: 'Cross-tenant platform overview', requireSuperAdmin: true },
        ],
    },
    {
        title: 'Platform',
        items: [{ label: 'Tenants', to: '/tenants', icon: Building2, description: 'Organizations on the platform', requireSuperAdmin: true }],
    },
    {
        title: 'Identity & Access',
        items: [
            { label: 'Users', to: '/users', icon: Users, description: 'People and service accounts' },
            { label: 'Roles & Policies', to: '/roles', icon: Shield, description: 'RBAC and CASL policies', requireSuperAdmin: true },
            { label: 'API Keys', to: '/api-keys', icon: KeyRound, description: 'Programmatic credentials', requireAdmin: true },
        ],
    },
    {
        title: 'Clinical Operations',
        items: [
            { label: 'Departments & Prompts', to: '/departments', icon: FolderTree, description: 'Departments and prompt templates' },
            { label: 'Consultation History', to: '/history', icon: History, description: 'Context timeline by consultation' },
            { label: 'Live Session', to: '/live', icon: Radio, description: 'Realtime transcript capture' },
        ],
    },
    {
        title: 'Observability',
        items: [
            { label: 'Audit Log', to: '/audit-log', icon: ScrollText, description: 'Tenant activity, keyset-paginated', requireAdmin: true },
            { label: 'Monitoring', to: '/system-health', icon: Activity, description: 'Service health, latency and throughput', requireSuperAdmin: true },
        ],
    },
    {
        title: 'Settings',
        items: [
            // TASK-392 — super-admins get the full plan-matrix + per-tenant tools;
            // tenant-admins see their own read-only capability/usage snapshot.
            { label: 'Entitlements', to: '/entitlements', icon: Gauge, description: 'Plan limits, usage and overrides', requireAdmin: true },
            { label: 'Settings', to: '/settings', icon: Settings, description: 'Global and personal settings', requireSuperAdmin: true },
        ],
    },
];

/** Sections + items filtered to the viewer's role (default-deny). Empty sections drop out. */
export function getNavSections(roles?: string[] | null): NavSection[] {
    const superAdmin = isSuperAdmin(roles);
    const admin = superAdmin || isTenantAdmin(roles);
    const canSee = (item: NavItem): boolean => {
        if (item.requireSuperAdmin) return superAdmin;
        if (item.requireAdmin) return admin;
        return true;
    };
    return ALL_SECTIONS.map((section) => ({
        ...section,
        items: section.items.filter(canSee),
    })).filter((section) => section.items.length > 0);
}

/** Flat list of every nav item (role-agnostic) for active-title / label lookups. */
export const NAV_ITEMS: NavItem[] = ALL_SECTIONS.flatMap((s) => s.items);
