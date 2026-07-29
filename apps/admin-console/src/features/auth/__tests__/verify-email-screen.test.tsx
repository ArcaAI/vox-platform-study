import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { VerifyEmailScreen } from '../components/verify-email-screen';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('VerifyEmailScreen', () => {
  it('shows a missing-token error and never calls the BFF when the link has no token', () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    render(<VerifyEmailScreen token={undefined} />);

    expect(screen.getByText(/missing/i)).toBeDefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('auto-submits the token on mount and shows the tenant on success', async () => {
    const fetchMock = vi.fn(async () => Response.json({ userId: 'u1', tenantId: 't1', tenantKey: 'acme-health' }));
    vi.stubGlobal('fetch', fetchMock);

    render(<VerifyEmailScreen token="raw-token" />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/auth/register/verify');
    expect(JSON.parse(String(init.body))).toEqual({ token: 'raw-token' });

    expect(await screen.findByText(/acme-health/i)).toBeDefined();
    expect(screen.getByRole('link', { name: /sign in/i })).toBeDefined();
  });

  it('shows the gateway error message on an invalid/expired token', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ message: 'Verification link is invalid or has expired' }, { status: 400 })),
    );

    render(<VerifyEmailScreen token="bogus" />);

    expect(await screen.findByText(/invalid or has expired/i)).toBeDefined();
  });

  it('does not double-submit on re-render', async () => {
    const fetchMock = vi.fn(async () => Response.json({ userId: 'u1', tenantId: 't1', tenantKey: 'acme-health' }));
    vi.stubGlobal('fetch', fetchMock);

    const { rerender } = render(<VerifyEmailScreen token="raw-token" />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    rerender(<VerifyEmailScreen token="raw-token" />);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
