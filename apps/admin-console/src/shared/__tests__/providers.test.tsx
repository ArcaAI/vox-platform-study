import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
    usePathname: () => '/',
    useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
    useSearchParams: () => new URLSearchParams(),
}));

import { useSession } from '@/shared/auth';
import type { SafeSession } from '@/server/safe-user';
import { Providers } from '../providers';

afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
});

const FAKE_SESSION: SafeSession = {
    user: { id: 'u1', username: 'demo-admin', email: 'demo@example.com', roles: ['GLOBAL_ADMIN'], tenantId: null },
    isElevated: true,
    workingTenantId: null,
    workingTenantName: null,
    impersonatingUserId: null,
    impersonatingUsername: null,
    effectiveUser: {
        id: 'u1',
        username: 'demo-admin',
        email: 'demo@example.com',
        roles: ['GLOBAL_ADMIN'],
        tenantId: null,
        departmentId: null,
    },
    effectiveIsElevated: true,
    effectiveTenantId: null,
};

function SessionProbe() {
    const session = useSession();
    return <div data-testid="session-state">{session.data ? session.data.user.username : 'loading'}</div>;
}

describe('Providers', () => {
    /**
     * The React canary bundled with Next 16 logs "Encountered a
     * script tag while rendering React component" for every executable
     * <script> created during a client render. next-themes' FOUC bootstrap
     * must therefore be an inert data block on the client (it is never
     * executed there anyway); only the SSR copy stays executable.
     */
    it('renders the next-themes bootstrap script as an inert data block on the client', () => {
        const { container } = render(
            <Providers>
                <div />
            </Providers>,
        );

        const script = [...container.querySelectorAll('script')].find((el) => el.innerHTML.includes('documentElement'));

        expect(script, 'next-themes bootstrap script not found').toBeDefined();
        expect(script?.getAttribute('type')).toBe('application/json');
    });

    /**
     * F-035 (systemic hydration mismatch): the layout decrypts the session
     * server-side but previously never seeded the query cache, so the first
     * client render raced the `/api/auth/session` fetch against the SSR HTML
     * (which had rendered off a `session.data === undefined` gate branch).
     * Seeding `['auth','session']` from the server-provided session makes the
     * first render (server AND client) synchronously agree — no fetch, no race.
     */
    it('seeds the auth session query from a server-provided session with no fetch race', () => {
        const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(new Response(JSON.stringify(FAKE_SESSION)));

        render(
            <Providers session={FAKE_SESSION}>
                <SessionProbe />
            </Providers>,
        );

        expect(screen.getByTestId('session-state').textContent).toBe('demo-admin');
        expect(fetchSpy).not.toHaveBeenCalled();
    });
});
