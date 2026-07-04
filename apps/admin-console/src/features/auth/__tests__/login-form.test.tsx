import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { routerReplace, routerRefresh } = vi.hoisted(() => ({
    routerReplace: vi.fn(),
    routerRefresh: vi.fn(),
}));

vi.mock('next/navigation', () => ({
    useRouter: () => ({ replace: routerReplace, refresh: routerRefresh, push: vi.fn(), prefetch: vi.fn() }),
}));

import { LoginForm } from '../components/login-form';

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    routerReplace.mockReset();
    routerRefresh.mockReset();
});

function fillAndSubmit(username: string, password: string, tenantKey?: string) {
    fireEvent.change(screen.getByLabelText(/username/i), { target: { value: username } });
    fireEvent.change(screen.getByLabelText(/password/i), { target: { value: password } });
    if (tenantKey !== undefined) {
        fireEvent.change(screen.getByLabelText(/tenant key/i), { target: { value: tenantKey } });
    }
    fireEvent.click(screen.getByRole('button', { name: /sign in/i }));
}

describe('LoginForm', () => {
    it('renders username, password and optional tenant key fields', () => {
        render(<LoginForm redirectTo="/dashboard" />);
        expect(screen.getByLabelText(/username/i)).toBeDefined();
        expect(screen.getByLabelText(/password/i)).toBeDefined();
        expect(screen.getByLabelText(/tenant key/i)).toBeDefined();
        expect(screen.getByRole('button', { name: /sign in/i })).toBeDefined();
    });

    it('submits credentials to the BFF login route and redirects on success', async () => {
        const fetchMock = vi.fn(async () => Response.json({ user: { id: 'u1' }, passwordExpired: false }));
        vi.stubGlobal('fetch', fetchMock);

        render(<LoginForm redirectTo="/tenants" />);
        fillAndSubmit('root', 'secret', 'acme');

        await waitFor(() => expect(routerReplace).toHaveBeenCalledWith('/tenants'));
        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
        expect(url).toBe('/api/auth/login');
        expect(init.method).toBe('POST');
        expect(JSON.parse(String(init.body))).toEqual({ username: 'root', password: 'secret', tenantKey: 'acme' });
    });

    it('omits the tenant key from the payload when left blank', async () => {
        const fetchMock = vi.fn(async () => Response.json({ user: { id: 'u1' } }));
        vi.stubGlobal('fetch', fetchMock);

        render(<LoginForm redirectTo="/dashboard" />);
        fillAndSubmit('root', 'secret');

        await waitFor(() => expect(routerReplace).toHaveBeenCalled());
        const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
        expect(JSON.parse(String(init.body))).toEqual({ username: 'root', password: 'secret' });
    });

    it('surfaces gateway errors and does not redirect', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => Response.json({ message: 'Invalid credentials' }, { status: 401 })),
        );

        render(<LoginForm redirectTo="/dashboard" />);
        fillAndSubmit('root', 'wrong');

        expect(await screen.findByText('Invalid credentials')).toBeDefined();
        expect(routerReplace).not.toHaveBeenCalled();
    });

    it('shows the password-expired notice instead of silently redirecting', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => Response.json({ user: { id: 'u1' }, passwordExpired: true })),
        );

        render(<LoginForm redirectTo="/dashboard" />);
        fillAndSubmit('root', 'secret');

        expect(await screen.findByText(/password has expired/i)).toBeDefined();
        expect(routerReplace).not.toHaveBeenCalled();

        fireEvent.click(screen.getByRole('button', { name: /continue/i }));
        expect(routerReplace).toHaveBeenCalledWith('/dashboard');
    });
});
