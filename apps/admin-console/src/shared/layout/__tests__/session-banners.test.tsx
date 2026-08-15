import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SafeSession } from '@/shared/auth/hooks';
import { renderWithProviders } from '@/test/render';
import { ImpersonationBanner, WorkingTenantBanner } from '../session-banners';

const refresh = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh, push: vi.fn() }),
}));

function session(overrides: Partial<SafeSession>): SafeSession {
  return {
    userId: 'u-1',
    username: 'admin',
    email: null,
    roles: ['SUPER_ADMIN'],
    tenantId: null,
    isElevated: true,
    workingTenantId: null,
    workingTenantName: null,
    impersonatingUserId: null,
    impersonatingUsername: null,
    expiresAt: Date.now() + 60_000,
    ...overrides,
  } as SafeSession;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('WorkingTenantBanner', () => {
  it('renders nothing without a working tenant', () => {
    renderWithProviders(<WorkingTenantBanner session={session({})} />);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('shows the tenant name and clears it through the BFF', async () => {
    const fetchMock = vi.fn(async () => Response.json({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);
    renderWithProviders(<WorkingTenantBanner session={session({ workingTenantId: 't-1', workingTenantName: 'Sunrise Medical Group' })} />);

    expect(screen.getByRole('status').textContent).toContain('Sunrise Medical Group');
    fireEvent.click(screen.getByRole('button', { name: /clear working tenant/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/auth/working-tenant', { method: 'DELETE' }));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });
});

describe('ImpersonationBanner', () => {
  it('renders nothing when not impersonating', () => {
    renderWithProviders(<ImpersonationBanner session={session({})} />);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('shows the impersonated user and revokes through the BFF', async () => {
    const fetchMock = vi.fn(async () => Response.json({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);
    renderWithProviders(<ImpersonationBanner session={session({ impersonatingUserId: 'u-9', impersonatingUsername: 'dr.mia' })} />);

    expect(screen.getByRole('status').textContent).toContain('dr.mia');
    fireEvent.click(screen.getByRole('button', { name: /revoke impersonation/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/auth/revoke-impersonation', { method: 'POST' }));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });
});
