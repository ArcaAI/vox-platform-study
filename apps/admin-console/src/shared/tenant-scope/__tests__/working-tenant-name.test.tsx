import { screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '@/test/render';
import { TenantScopeBanner } from '../tenant-scope-banner';

afterEach(() => vi.unstubAllGlobals());

describe('TenantScopeBanner name fallback', () => {
  it('resolves the tenant name instead of showing the UUID', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.includes('/api/hope/admin/tenants')) return Response.json({ data: [{ id: 'tnt-uuid', name: 'Sunrise Clinic' }] });
        return Response.json({
          user: { id: 'u', username: 'a', email: 'a@x.io', roles: ['SUPER_ADMIN'] },
          isElevated: true,
          workingTenantId: 'tnt-uuid',
          workingTenantName: null,
          impersonatingUserId: null,
          impersonatingUsername: null,
        });
      }),
    );
    renderWithProviders(<TenantScopeBanner />);
    expect(await screen.findByText(/Sunrise Clinic/)).toBeDefined();
    expect(screen.queryByText(/tnt-uuid/)).toBeNull();
  });
});
