import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import * as React from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '@/test/render';
import { PlatformDashboard } from '../platform-dashboard';

// recharts' ResponsiveContainer relies on layout measurement that happy-dom
// lacks; inject a fixed size so MetricChart actually draws (standard shim).
// recharts is a transitive dep (via @arcaai/ui), so its types are not
// resolvable from this app — keep the module shape untyped.
vi.mock('recharts', async (importOriginal) => {
    const actual = await importOriginal<Record<string, unknown>>();
    return {
        ...actual,
        ResponsiveContainer: ({ children }: { children: React.ReactElement<{ width?: number; height?: number }> }) =>
            React.cloneElement(children, { width: 800, height: 300 }),
    };
});

beforeAll(() => {
    Element.prototype.getBoundingClientRect = function () {
        return { width: 800, height: 300, top: 0, left: 0, right: 800, bottom: 300, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
    };
});

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});

const METRICS = {
    requestsPerMinute: 1284,
    errorRatePct: 0.42,
    p95LatencyMs: 412,
    openSockets: 342,
    socketsPerMinute: 9,
    services: [
        { key: 'smr', p95LatencyMs: 210, requestsPerMinute: 480, errorRatePct: 0.1 },
        { key: 'stt', p95LatencyMs: 118, requestsPerMinute: 260, errorRatePct: 0.3 },
        { key: 'nlp', p95LatencyMs: 88, requestsPerMinute: 96, errorRatePct: null },
    ],
    models: { running: 3, perModel: [] },
    requestVolumeSeries: [{ t: '2026-07-05T09:00:00Z', requests: 640, sockets: 320 }],
    refreshedAt: new Date().toISOString(),
};

const HEALTH = {
    status: 'degraded',
    timestamp: new Date().toISOString(),
    services: {
        smr: { status: 'healthy', service: 'smr', uptime_seconds: 86_400, duration_ms: 42 },
        stt: { status: 'healthy', service: 'stt', duration_ms: 118 },
        guardrail: { status: 'degraded', service: 'guardrail', error: 'queue depth 117' },
        harness: { status: 'down', service: 'harness', error: 'ECONNREFUSED' },
    },
};

const AUDIT = {
    data: [
        {
            id: 'al_1',
            createdAt: new Date(Date.now() - 5 * 60_000).toISOString(),
            action: 'UPDATE',
            eventType: 'tenant.suspend',
            resourceType: 'TENANT',
            resourceId: 'tnt_bayview',
            responsibleUser: { id: 'u1', displayName: 'Tap Huynh', email: 'taphuynh@arca.ai' },
        },
        {
            id: 'al_2',
            createdAt: new Date(Date.now() - 18 * 60_000).toISOString(),
            action: 'CREATE',
            eventType: null,
            resourceType: 'API_KEY',
            resourceId: 'key_prod_7f2',
            responsibleUser: null,
        },
    ],
    count: 2,
    limit: 10,
    page: 0,
};

type RouteOverrides = Partial<Record<'metrics' | 'health' | 'audit', () => Response>>;

function installFetch(overrides: RouteOverrides = {}) {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.includes('admin/platform/metrics')) return (overrides.metrics ?? (() => Response.json(METRICS)))();
        if (url.includes('health/services')) return (overrides.health ?? (() => Response.json(HEALTH)))();
        if (url.includes('admin/audit-logs')) return (overrides.audit ?? (() => Response.json(AUDIT)))();
        throw new Error(`Unexpected fetch in test: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
}

function callsTo(fetchMock: ReturnType<typeof installFetch>, fragment: string): number {
    return fetchMock.mock.calls.filter(([input]) => String(input).includes(fragment)).length;
}

describe('PlatformDashboard', () => {
    it('renders the four platform stat tiles from the metrics payload', async () => {
        installFetch();
        renderWithProviders(<PlatformDashboard />);

        const stats = await screen.findByRole('region', { name: /key metrics/i });
        expect(await within(stats).findByText('1,284')).toBeDefined();
        expect(within(stats).getByText('Requests / min')).toBeDefined();
        expect(within(stats).getByText('412 ms')).toBeDefined();
        expect(within(stats).getByText('P95 latency')).toBeDefined();
        expect(within(stats).getByText('0.42%')).toBeDefined();
        expect(within(stats).getByText('Error rate')).toBeDefined();
        expect(within(stats).getByText('342')).toBeDefined();
        expect(within(stats).getByText('Open sockets')).toBeDefined();
    });

    it('renders the services strip with status details for non-healthy services', async () => {
        installFetch();
        renderWithProviders(<PlatformDashboard />);

        expect((await screen.findAllByText('smr')).length).toBeGreaterThan(0);
        expect(screen.getByText('(degraded · queue depth 117)')).toBeDefined();
        expect(screen.getByText('(down · ECONNREFUSED)')).toBeDefined();
    });

    it('renders recent admin activity rows and a link to the audit logs screen', async () => {
        installFetch();
        renderWithProviders(<PlatformDashboard />);

        expect(await screen.findByText('tenant.suspend')).toBeDefined();
        expect(screen.getByText('taphuynh@arca.ai')).toBeDefined();
        // Row without an eventType falls back to the gateway action enum.
        expect(screen.getByText('CREATE')).toBeDefined();
        const link = screen.getByRole('link', { name: /audit logs/i });
        expect(link.getAttribute('href')).toBe('/audit-logs');
    });

    it('shows loading skeletons that mirror the layout while queries are in flight', () => {
        vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})));
        const { container } = renderWithProviders(<PlatformDashboard />);

        expect(container.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(0);
        expect(screen.queryByText('1,284')).toBeNull();
    });

    it('shows a block error with retry when metrics fail with no cached data', async () => {
        const fetchMock = installFetch({
            metrics: () => Response.json({ statusCode: 503, message: 'Service unavailable' }, { status: 503 }),
        });
        renderWithProviders(<PlatformDashboard />);

        const alerts = await screen.findAllByRole('alert');
        expect(alerts.length).toBeGreaterThan(0);
        expect(callsTo(fetchMock, 'admin/platform/metrics')).toBe(1);

        fireEvent.click(within(alerts[0]).getByRole('button', { name: /retry/i }));
        await waitFor(() => expect(callsTo(fetchMock, 'admin/platform/metrics')).toBe(2));
    });

    it('renders empty states when the platform has no traffic or activity yet', async () => {
        installFetch({
            metrics: () => Response.json({ ...METRICS, services: [] }),
            health: () => Response.json({ ...HEALTH, services: {} }),
            audit: () => Response.json({ data: [], count: 0, limit: 10, page: 0 }),
        });
        renderWithProviders(<PlatformDashboard />);

        expect(await screen.findByText('No traffic yet')).toBeDefined();
        expect(screen.getByText('No admin activity yet')).toBeDefined();
        expect(screen.getByText('No services reporting')).toBeDefined();
    });
});
