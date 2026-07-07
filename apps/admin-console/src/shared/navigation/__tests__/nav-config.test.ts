import { describe, expect, it } from 'vitest';
import type { PermissionRule } from '@/shared/auth/ability';
import { matchNavEntry, NAV_ENTRIES, NAV_SECTIONS, visibleNavEntries } from '../nav-config';

const GLOBAL_ADMIN_RULES: PermissionRule[] = [{ action: 'manage', subject: 'all' }];

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

describe('NAV_ENTRIES (capabilities-matrix section 3, reviewed 2026-07-04; playground tier TASK-420/431)', () => {
    it('covers the full 34-route map across the four tiers', () => {
        expect(NAV_ENTRIES).toHaveLength(34);
        expect(NAV_ENTRIES.filter((entry) => entry.tier === '10-19')).toHaveLength(11);
        expect(NAV_ENTRIES.filter((entry) => entry.tier === '20-29')).toHaveLength(7);
        expect(NAV_ENTRIES.filter((entry) => entry.tier === '30-49')).toHaveLength(11);
        expect(NAV_ENTRIES.filter((entry) => entry.tier === '50-59')).toHaveLength(5);
    });

    it('re-tiers AI models to global-admin only and folds frontend config into the tenant detail', () => {
        const aiModels = NAV_ENTRIES.find((entry) => entry.route === '/ai-models');
        expect(aiModels?.tier).toBe('10-19');
        expect(aiModels?.required).toEqual([['manage', 'all']]);
        expect(NAV_ENTRIES.some((entry) => entry.route === '/tenants/frontend-config')).toBe(false);
    });

    it('has unique routes and a section per tier', () => {
        const routes = NAV_ENTRIES.map((entry) => entry.route);
        expect(new Set(routes).size).toBe(routes.length);
        expect(NAV_SECTIONS.map((section) => section.tier)).toEqual(['10-19', '20-29', '30-49', '50-59']);
    });

    it('marks every tier implemented except the hidden AI models entry', () => {
        const byTier = (tier: string) => NAV_ENTRIES.filter((entry) => entry.tier === tier);
        expect(byTier('10-19').filter((entry) => !entry.implemented).map((entry) => entry.route)).toEqual(['/ai-models']);
        expect(byTier('20-29').every((entry) => entry.implemented)).toBe(true);
        expect(byTier('30-49').every((entry) => entry.implemented)).toBe(true);
        expect(byTier('50-59').every((entry) => entry.implemented)).toBe(true);
    });

    it('routes every playground entry under /playground with an empty ability gate (role-gated instead)', () => {
        const playground = NAV_ENTRIES.filter((entry) => entry.tier === '50-59');
        expect(playground.map((entry) => entry.route)).toEqual([
            '/playground/consultation',
            '/playground/live-transcription',
            '/playground/voice-profiles',
            '/playground/dna-writing-style',
            '/playground/llm',
        ]);
        expect(playground.every((entry) => entry.required.length === 0)).toBe(true);
    });

    it('ships a unique icon per entry (the icon-collapsed rail renders icons only)', () => {
        for (const entry of NAV_ENTRIES) {
            expect(entry.icon, `${entry.route} is missing an icon`).toBeDefined();
        }
        expect(new Set(NAV_ENTRIES.map((entry) => entry.icon)).size).toBe(NAV_ENTRIES.length);
    });
});

describe('matchNavEntry', () => {
    it('returns an exact match', () => {
        expect(matchNavEntry('/dashboard')?.route).toBe('/dashboard');
    });

    it('returns the parent for a detail route', () => {
        expect(matchNavEntry('/tenants/t-123')?.route).toBe('/tenants');
    });

    it('prefers the longest prefix (/tenants/storage over /tenants)', () => {
        expect(matchNavEntry('/tenants/storage')?.route).toBe('/tenants/storage');
    });

    it('returns undefined for an unknown route', () => {
        expect(matchNavEntry('/does-not-exist')).toBeUndefined();
    });

    it('accepts a custom entries subset', () => {
        const subset = NAV_ENTRIES.filter((e) => e.route === '/tenants/storage');
        expect(matchNavEntry('/tenants/storage', subset)?.route).toBe('/tenants/storage');
        expect(matchNavEntry('/dashboard', subset)).toBeUndefined();
    });
});

describe('visibleNavEntries', () => {
    it('shows a global admin every implemented entry (manage:all grants all tiers)', () => {
        const visible = visibleNavEntries(GLOBAL_ADMIN_RULES, ['GLOBAL_ADMIN']);
        const implemented = NAV_ENTRIES.filter((entry) => entry.implemented);
        expect(visible.map((entry) => entry.route)).toEqual(implemented.map((entry) => entry.route));
    });

    it('hides global-admin-only entries from tenant admins but keeps shared screens and the playground', () => {
        const visible = visibleNavEntries(TENANT_ADMIN_RULES, ['TENANT_ADMIN']).map((entry) => entry.route);
        expect(visible).not.toContain('/dashboard');
        expect(visible).not.toContain('/monitoring');
        expect(visible).not.toContain('/ai-models');
        expect(visible).toContain('/users');
        expect(visible).toContain('/tenant-profile');
        expect(visible).toContain('/account');
        expect(visible).toContain('/playground/consultation');
        expect(visible).toContain('/playground/llm');
    });

    it('shows only ungated entries (account) for an authenticated user with zero grants', () => {
        expect(visibleNavEntries([]).map((entry) => entry.route)).toEqual(['/account']);
    });

    it('hides the playground tier from non-admin roles even though its ability gate is empty', () => {
        const visible = visibleNavEntries([], ['DOCTOR']).map((entry) => entry.route);
        expect(visible).toEqual(['/account']);
        expect(visibleNavEntries([]).some((entry) => entry.tier === '50-59')).toBe(false);
    });

    it('shows nothing while permissions are unknown', () => {
        expect(visibleNavEntries(null, ['GLOBAL_ADMIN'])).toEqual([]);
        expect(visibleNavEntries(undefined)).toEqual([]);
    });

    it('filters unimplemented entries even when the ability grants them', () => {
        const visible = visibleNavEntries(GLOBAL_ADMIN_RULES, ['GLOBAL_ADMIN']);
        expect(visible.every((entry) => entry.implemented)).toBe(true);
    });
});
