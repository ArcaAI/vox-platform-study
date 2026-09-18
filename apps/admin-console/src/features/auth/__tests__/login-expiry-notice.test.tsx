import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), refresh: vi.fn(), push: vi.fn(), prefetch: vi.fn() }),
}));

import LoginPage from '@/app/(auth)/login/page';

afterEach(cleanup);

async function renderLogin(searchParams: { from?: string; error?: string; reason?: string }) {
  render(await LoginPage({ searchParams: Promise.resolve(searchParams) }));
}

describe('login screen expiry notice', () => {
  it('explains the sign-out when the operator arrives with ?reason=expired', async () => {
    await renderLogin({ reason: 'expired', from: '/tenants' });

    const notice = screen.getByRole('alert');
    expect(notice.textContent).toMatch(/session expired/i);
  });

  it('shows nothing extra on a bare /login', async () => {
    await renderLogin({});

    expect(screen.queryByRole('alert')).toBeNull();
  });
});
