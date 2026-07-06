/**
 * TDD screen tests for frame 16 (Rate Limits): the single-policy screen —
 * global kill-switch (confirm on disable), tier defaults inline edit, route
 * override edit/pause flows — against a URL-branching fetch stub.
 */

import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '@/test/render';
import type { RateLimitPolicy } from '../../api/types';
import { RateLimitsScreen } from '../rate-limits-screen';

const POLICY: RateLimitPolicy = {
    enabled: true,
    enabledSource: 'db',
    tiers: [
        { tier: 'default', limit: 600, ttl: 60, limitSource: 'db', ttlSource: 'code' },
        { tier: 'strict', limit: 10, ttl: 60, limitSource: 'code', ttlSource: 'code' },
        { tier: 'heavy', limit: 30, ttl: 300, limitSource: 'default', ttlSource: 'default' },
        { tier: 'relaxed', limit: 2000, ttl: 60, limitSource: 'code', ttlSource: 'code' },
    ],
    routes: [
        {
            routeId: 'AuthController#login',
            controller: 'AuthController',
            handler: 'login',
            description: 'POST /auth/login',
            tier: 'strict',
            limit: 10,
            ttl: 60,
            enabled: true,
            limitSource: 'db',
            ttlSource: 'code',
        },
        {
            routeId: 'SummariesController#create',
            controller: 'SummariesController',
            handler: 'create',
            description: 'POST /summaries',
            tier: 'heavy',
            limit: 60,
            ttl: 60,
            enabled: false,
            limitSource: 'code',
            ttlSource: 'code',
        },
    ],
};

interface RecordedCall {
    url: string;
    method: string;
    body: unknown;
}

function stubFetch(handler: (url: string, method: string, body: unknown) => Response | Promise<Response>): RecordedCall[] {
    const calls: RecordedCall[] = [];
    vi.stubGlobal(
        'fetch',
        vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
            const url = String(input);
            const method = init?.method ?? 'GET';
            const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
            calls.push({ url, method, body });
            return handler(url, method, body);
        }),
    );
    return calls;
}

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});

describe('RateLimitsScreen', () => {
    it('renders the kill-switch, tier defaults and route overrides from the policy', async () => {
        stubFetch(() => Response.json(POLICY));
        renderWithProviders(<RateLimitsScreen />);

        expect(screen.getByRole('heading', { level: 1, name: 'Rate Limits' })).toBeDefined();
        const toggle = await screen.findByRole('switch', { name: 'Rate limiting enabled' });
        expect(toggle.getAttribute('data-state')).toBe('checked');
        // Tier defaults region: all four fixed tiers with their limits.
        const tierTable = screen.getByRole('grid', { name: 'Tier defaults' });
        expect(within(tierTable).getByText('default')).toBeDefined();
        expect(within(tierTable).getByText('strict')).toBeDefined();
        expect(within(tierTable).getByText('heavy')).toBeDefined();
        expect(within(tierTable).getByText('relaxed')).toBeDefined();
        expect(within(tierTable).getByText('600')).toBeDefined();
        // Route overrides region.
        const routeTable = screen.getByRole('grid', { name: 'Route overrides' });
        expect(within(routeTable).getByText('AuthController#login')).toBeDefined();
        expect(within(routeTable).getByText('POST /auth/login')).toBeDefined();
    });

    it('mirrors the loaded layout with skeletons while the policy is in flight', () => {
        stubFetch(() => new Promise<Response>(() => {}));
        const { container } = renderWithProviders(<RateLimitsScreen />);

        expect(container.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(0);
        expect(screen.queryByRole('switch')).toBeNull();
    });

    it('surfaces a block error with retry and refetches the policy', async () => {
        let attempts = 0;
        stubFetch(() => {
            attempts += 1;
            return attempts === 1 ? Response.json({ message: 'Redis unreachable' }, { status: 503 }) : Response.json(POLICY);
        });
        renderWithProviders(<RateLimitsScreen />);

        expect(await screen.findByRole('alert')).toBeDefined();
        expect(screen.getByText('Redis unreachable')).toBeDefined();

        fireEvent.click(screen.getByRole('button', { name: /retry/i }));
        expect(await screen.findByRole('switch', { name: 'Rate limiting enabled' })).toBeDefined();
    });

    it('shows a neutral empty state when the gateway reports no routes', async () => {
        stubFetch(() => Response.json({ ...POLICY, routes: [] }));
        renderWithProviders(<RateLimitsScreen />);

        expect(await screen.findByText('No rate-limited routes')).toBeDefined();
    });

    it('disabling the kill-switch requires a confirm before the PUT fires', async () => {
        const calls = stubFetch((url, method) => {
            if (method === 'PUT') return Response.json({ ...POLICY, enabled: false });
            return Response.json(POLICY);
        });
        renderWithProviders(<RateLimitsScreen />);

        fireEvent.click(await screen.findByRole('switch', { name: 'Rate limiting enabled' }));
        expect(calls.filter((call) => call.method === 'PUT')).toHaveLength(0);

        const dialog = await screen.findByRole('alertdialog');
        fireEvent.click(within(dialog).getByRole('button', { name: 'Disable rate limiting' }));

        await waitFor(() => expect(calls.filter((call) => call.method === 'PUT')).toHaveLength(1));
        const put = calls.find((call) => call.method === 'PUT');
        expect(put?.url).toBe('/api/hope/admin/rate-limit/enabled');
        expect(put?.body).toEqual({ enabled: false });
        // The write returns the fresh policy — the switch reflects it.
        const toggle = await screen.findByRole('switch', { name: 'Rate limiting enabled' });
        await waitFor(() => expect(toggle.getAttribute('data-state')).toBe('unchecked'));
    });

    it('re-enabling fires the PUT directly without a confirm', async () => {
        const calls = stubFetch((url, method) => {
            if (method === 'PUT') return Response.json(POLICY);
            return Response.json({ ...POLICY, enabled: false });
        });
        renderWithProviders(<RateLimitsScreen />);

        fireEvent.click(await screen.findByRole('switch', { name: 'Rate limiting enabled' }));

        await waitFor(() => expect(calls.filter((call) => call.method === 'PUT')).toHaveLength(1));
        expect(calls.find((call) => call.method === 'PUT')?.body).toEqual({ enabled: true });
        expect(screen.queryByRole('alertdialog')).toBeNull();
    });

    it('saving a tier override PUTs limit and ttl to the tier route', async () => {
        const calls = stubFetch((url, method) => {
            if (method === 'PUT') {
                return Response.json({
                    ...POLICY,
                    tiers: POLICY.tiers.map((tier) => (tier.tier === 'default' ? { ...tier, limit: 900 } : tier)),
                });
            }
            return Response.json(POLICY);
        });
        renderWithProviders(<RateLimitsScreen />);

        fireEvent.click(await screen.findByRole('button', { name: 'Edit default tier' }));
        const dialog = await screen.findByRole('dialog');
        const limitInput = within(dialog).getByLabelText(/limit/i);
        expect((limitInput as HTMLInputElement).value).toBe('600');
        fireEvent.change(limitInput, { target: { value: '900' } });
        fireEvent.click(within(dialog).getByRole('button', { name: 'Save override' }));

        await waitFor(() => expect(calls.filter((call) => call.method === 'PUT')).toHaveLength(1));
        const put = calls.find((call) => call.method === 'PUT');
        expect(put?.url).toBe('/api/hope/admin/rate-limit/tiers/default');
        expect(put?.body).toEqual({ limit: 900, ttl: 60 });
        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    });

    it('saving a route override PUTs to the encoded routeId', async () => {
        const calls = stubFetch((url, method) => {
            if (method === 'PUT') return Response.json(POLICY);
            return Response.json(POLICY);
        });
        renderWithProviders(<RateLimitsScreen />);

        fireEvent.click(await screen.findByRole('button', { name: 'Edit AuthController#login' }));
        const dialog = await screen.findByRole('dialog');
        fireEvent.change(within(dialog).getByLabelText(/limit/i), { target: { value: '25' } });
        fireEvent.click(within(dialog).getByRole('button', { name: 'Save override' }));

        await waitFor(() => expect(calls.filter((call) => call.method === 'PUT')).toHaveLength(1));
        const put = calls.find((call) => call.method === 'PUT');
        expect(put?.url).toBe('/api/hope/admin/rate-limit/routes/AuthController%23login');
        expect(put?.body).toEqual({ limit: 25, ttl: 60 });
    });

    it('pausing a route confirms, then PUTs enabled=false; resuming needs no confirm', async () => {
        const calls = stubFetch((url, method, body) => {
            if (method === 'PUT') {
                const enabled = (body as { enabled: boolean }).enabled;
                return Response.json({
                    ...POLICY,
                    routes: POLICY.routes.map((route) => (route.routeId === 'AuthController#login' ? { ...route, enabled } : route)),
                });
            }
            return Response.json(POLICY);
        });
        renderWithProviders(<RateLimitsScreen />);

        fireEvent.click(await screen.findByRole('button', { name: 'Pause AuthController#login' }));
        expect(calls.filter((call) => call.method === 'PUT')).toHaveLength(0);
        const dialog = await screen.findByRole('alertdialog');
        fireEvent.click(within(dialog).getByRole('button', { name: 'Pause route' }));

        await waitFor(() => expect(calls.filter((call) => call.method === 'PUT')).toHaveLength(1));
        expect(calls.find((call) => call.method === 'PUT')?.url).toBe('/api/hope/admin/rate-limit/routes/AuthController%23login');
        expect(calls.find((call) => call.method === 'PUT')?.body).toEqual({ enabled: false });

        // Resume the pre-seeded paused route: direct PUT, no confirm.
        fireEvent.click(await screen.findByRole('button', { name: 'Resume SummariesController#create' }));
        await waitFor(() => expect(calls.filter((call) => call.method === 'PUT')).toHaveLength(2));
        expect(calls.at(-1)?.url).toBe('/api/hope/admin/rate-limit/routes/SummariesController%23create');
        expect(calls.at(-1)?.body).toEqual({ enabled: true });
    });
});
