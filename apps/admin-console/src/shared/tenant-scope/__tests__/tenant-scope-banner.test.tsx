import { screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '@/test/render';
import { TenantScopeBanner } from '../tenant-scope-banner';

function stubSession(workingTenantId: string | null) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Response.json({
        user: { id: 'u-1', username: 'admin', email: 'a@x.io', roles: ['GLOBAL_ADMIN'] },
        isElevated: true,
        workingTenantId,
        workingTenantName: workingTenantId ? 'Sunrise Medical Group' : null,
        impersonatingUserId: null,
        impersonatingUsername: null,
      }),
    ),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('TenantScopeBanner', () => {
  it('names the working tenant in a status region', async () => {
    stubSession('tnt-1');
    renderWithProviders(<TenantScopeBanner />);

    const status = await screen.findByRole('status');
    expect(status.textContent).toContain('Acting on');
    expect(status.textContent).toContain('Sunrise Medical Group');
  });

  it('renders nothing when there is no working tenant', async () => {
    stubSession(null);
    const { container } = renderWithProviders(<TenantScopeBanner />);

    // Give the session query a tick to resolve, then assert nothing rendered.
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull());
    expect(container.textContent).toBe('');
  });
});
