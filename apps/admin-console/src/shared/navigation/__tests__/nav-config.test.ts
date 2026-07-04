import { describe, expect, it } from 'vitest';
import type { PermissionRule } from '@/shared/auth/ability';
import { NAV_ENTRIES, NAV_SECTIONS, visibleNavEntries } from '../nav-config';

const SUPER_ADMIN_RULES: PermissionRule[] = [{ action: 'manage', subject: 'all' }];

// Approximation of the seeded TENANT_ADMIN policy set (tenant-full-access,
// rbac-tenant-manage, prompt-template-manage, audit-log-read).
const TENANT_ADMIN_RULES: PermissionRule[] = [
    { action: 'read', subject: 'AuditLog' },
    { action: 'manage', subject: 'Department' },
    { action: 'manage', subject: 'User' },
    { action: 'manage', subject: 'PromptTemplate' },
    { action: 'read,update', subject: 'Tenant' },
    { action: 'read', subject: 'Role' },
];

describe('NAV_ENTRIES (capabilities-matrix section 3)', () => {
    it('covers the full 30-route map across the three tiers', () => {
        expect(NAV_ENTRIES).toHaveLength(30);
        expect(NAV_ENTRIES.filter((entry) => entry.tier === '10-19')).toHaveLength(11);
        expect(NAV_ENTRIES.filter((entry) => entry.tier === '20-29')).toHaveLength(7);
        expect(NAV_ENTRIES.filter((entry) => entry.tier === '30-49')).toHaveLength(12);
    });

    it('has unique routes and a section per tier', () => {
        const routes = NAV_ENTRIES.map((entry) => entry.route);
        expect(new Set(routes).size).toBe(routes.length);
        expect(NAV_SECTIONS.map((section) => section.tier)).toEqual(['10-19', '20-29', '30-49']);
    });

    it('marks only the dashboard as implemented (design gate)', () => {
        const implemented = NAV_ENTRIES.filter((entry) => entry.implemented);
        expect(implemented.map((entry) => entry.route)).toEqual(['/dashboard']);
    });
});

describe('visibleNavEntries', () => {
    it('shows implemented entries the ability grants (super-admin sees the dashboard)', () => {
        const visible = visibleNavEntries(SUPER_ADMIN_RULES);
        expect(visible.map((entry) => entry.route)).toEqual(['/dashboard']);
    });

    it('hides super-admin-only entries from tenant admins', () => {
        const visible = visibleNavEntries(TENANT_ADMIN_RULES);
        expect(visible.map((entry) => entry.route)).not.toContain('/dashboard');
    });

    it('shows nothing without permissions', () => {
        expect(visibleNavEntries([])).toEqual([]);
        expect(visibleNavEntries(null)).toEqual([]);
    });

    it('filters unimplemented entries even when the ability grants them', () => {
        const visible = visibleNavEntries(SUPER_ADMIN_RULES);
        expect(visible.every((entry) => entry.implemented)).toBe(true);
    });
});
