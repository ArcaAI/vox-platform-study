import { describe, expect, it } from 'vitest';
import { getNavSections } from '../nav';

/** Flattened visible labels for a given role set. */
const labels = (roles?: string[] | null): string[] => getNavSections(roles).flatMap((s) => s.items.map((i) => i.label));

/**
 * TASK-391 follow-up — per-surface CASL-mirrored nav visibility (user decision:
 * per-surface, NOT blanket super-admin). API Keys + Audit are admin-tier
 * (tenant-admin OR super-admin); Roles & Policies + Global Settings are
 * super-admin only. Mirrors the server CASL as a nav-visibility hint only.
 */
describe('getNavSections — per-surface nav visibility', () => {
  it('super-admin sees all four super-admin-tier surfaces', () => {
    const seen = labels(['SUPER_ADMIN']);
    expect(seen).toEqual(expect.arrayContaining(['Roles & Policies', 'API Keys', 'Audit Log', 'Settings']));
  });

  it('tenant-admin sees API Keys + Audit Log but NOT Roles & Policies or Settings', () => {
    const seen = labels(['TENANT_ADMIN']);
    expect(seen).toContain('API Keys');
    expect(seen).toContain('Audit Log');
    expect(seen).not.toContain('Roles & Policies');
    expect(seen).not.toContain('Settings');
    // the cross-tenant Platform/Overview tiers remain super-admin only
    expect(seen).not.toContain('Tenants');
    expect(seen).not.toContain('Monitoring');
  });

  it('a regular user (no admin role) sees none of the four admin/super-admin surfaces', () => {
    const seen = labels(['USER']);
    expect(seen).not.toContain('API Keys');
    expect(seen).not.toContain('Audit Log');
    expect(seen).not.toContain('Roles & Policies');
    expect(seen).not.toContain('Settings');
  });
});
