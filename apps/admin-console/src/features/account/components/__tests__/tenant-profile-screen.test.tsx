/**
 * TDD screen tests for frame 25 (tenant half — Tenant profile): identity from
 * GET /tenant/me, entitlement usage from GET /entitlements/me, editable
 * tenant settings over PATCH /tenant/me/config (per-row If-Match, OCC alert
 * on 412), and the frame's NoTenant variant for tenant-less global admins.
 */

import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EntitlementCapabilities } from '@/features/entitlements/api/types';
import type { Tenant, TenantConfig } from '@/features/tenants/api/types';
import { renderWithProviders } from '@/test/render';
import { TenantProfileScreen } from '../tenant-profile-screen';

const BASE = {
    projectId: null,
    createdAt: '2026-01-05T08:00:00.000Z',
    updatedAt: '2026-06-28T10:00:00.000Z',
    resourceStatus: 'ENABLED' as const,
    resourceStatusUpdatedAt: null,
    resourceStatusUpdatedBy: null,
    createdBy: null,
    updatedBy: null,
};

const TENANT: Tenant = {
    id: 'ten-1',
    ...BASE,
    version: 12,
    name: 'Sunrise Medical Group',
    key: 'sunrise-medical',
    description: 'Multi-clinic group in Da Nang',
    plan: 'ENTERPRISE',
    tags: ['pilot', 'apac'],
};

const EDITABLE_CONFIG: TenantConfig = {
    id: 'cfg-1',
    ...BASE,
    name: 'Session timeout',
    description: 'Idle minutes before members are signed out.',
    key: 'session-timeout-minutes',
    defaultValue: '30',
    value: '45',
    dataType: 'number',
    namespace: 'security',
    tenantId: 'ten-1',
    tenantCode: 'sunrise-medical',
    version: 3,
};

const LOCKED_CONFIG: TenantConfig = {
    ...EDITABLE_CONFIG,
    id: 'cfg-2',
    name: 'Data region',
    description: 'Platform-owned residency default.',
    key: 'data-region',
    defaultValue: 'ap-southeast-1',
    value: 'ap-southeast-1',
    dataType: 'string',
    namespace: 'platform',
    locked: true,
    version: 7,
};

/** The synthetic read-only row GET /tenant/me/config appends (id '', version 0). */
const SYNTHETIC_CONFIG: TenantConfig = {
    ...EDITABLE_CONFIG,
    id: '',
    name: 'Enable Local Raw Capture',
    description: 'Server-computed effective flag.',
    key: 'enable-local-raw-capture',
    defaultValue: 'false',
    value: 'true',
    dataType: 'boolean',
    namespace: 'feature-flags',
    version: 0,
};

const CONFIG_PAGE = { data: [EDITABLE_CONFIG, LOCKED_CONFIG, SYNTHETIC_CONFIG], count: 3, limit: 200, page: 1 };

const ENTITLEMENTS: EntitlementCapabilities = {
    tenantId: 'ten-1',
    plan: 'ENTERPRISE',
    gated: true,
    enforcementEnabled: false,
    quantities: [
        { key: 'users', limit: 25, used: 12, remaining: 13, unlimited: false, nearLimit: false, exceeded: false },
        { key: 'apiKeys', limit: 10, used: 9, remaining: 1, unlimited: false, nearLimit: true, exceeded: false },
        { key: 'departments', limit: null, used: 4, remaining: null, unlimited: true, nearLimit: false, exceeded: false },
        { key: 'storageBytes', limit: 107_374_182_400, used: 32_212_254_720, remaining: 75_161_927_680, unlimited: false, nearLimit: false, exceeded: false },
    ],
    meters: [
        { key: 'monthlyConsultations', limit: 1000, used: 310, remaining: 690, unlimited: false, nearLimit: false, exceeded: false },
    ],
    features: { dnaReports: true, voiceEnrollment: true, monitoringAccess: false },
    modelTier: 'full',
    rateLimitTier: 'relaxed',
    rateLimitPerMinute: null,
    trial: { isTrial: false, trialEndsAt: null, daysRemaining: null, expired: false },
};

const NO_TENANT_BODY = {
    statusCode: 400,
    message: 'Tenant context is required. Global-admins must use /admin/tenants endpoints to manage other tenants.',
    error: 'Bad Request',
};

interface RecordedCall {
    url: string;
    method: string;
    headers: Headers;
    body: unknown;
}

type Handler = (url: string, method: string) => Response | Promise<Response>;

function stubFetch(handler: Handler): RecordedCall[] {
    const calls: RecordedCall[] = [];
    vi.stubGlobal(
        'fetch',
        vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
            const url = String(input);
            const method = init?.method ?? 'GET';
            calls.push({
                url,
                method,
                headers: new Headers(init?.headers),
                body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
            });
            return handler(url, method);
        }),
    );
    return calls;
}

/** URL-branching happy-path handler; /tenant/me/config must match before /tenant/me. */
function happyHandler(overrides: { tenant?: () => Response; configPatch?: () => Response } = {}): Handler {
    return (url, method) => {
        if (url.includes('/tenant/me/config')) {
            if (method === 'PATCH') return (overrides.configPatch ?? (() => Response.json(CONFIG_PAGE)))();
            return Response.json(CONFIG_PAGE);
        }
        if (url.includes('/tenant/me')) return (overrides.tenant ?? (() => Response.json(TENANT)))();
        if (url.includes('/entitlements/me')) return Response.json(ENTITLEMENTS);
        throw new Error(`Unexpected fetch in test: ${method} ${url}`);
    };
}

function configGetCalls(calls: RecordedCall[]): number {
    return calls.filter((call) => call.method === 'GET' && call.url.includes('/tenant/me/config')).length;
}

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});

describe('TenantProfileScreen', () => {
    it('renders the tenant identity, entitlement usage and tenant settings', async () => {
        stubFetch(happyHandler());
        renderWithProviders(<TenantProfileScreen />);

        expect(screen.getByRole('heading', { level: 1, name: 'Tenant profile' })).toBeDefined();

        // Identity region: name, mono key, plan, status.
        const identity = await screen.findByRole('region', { name: 'Organization' });
        expect(within(identity).getByText('Sunrise Medical Group')).toBeDefined();
        expect(within(identity).getByText('sunrise-medical')).toBeDefined();
        expect(within(identity).getByText('Enterprise')).toBeDefined();
        expect(within(identity).getByText('Active')).toBeDefined();
        expect(within(identity).getByText('pilot')).toBeDefined();

        // Entitlements region: usage rows, near-limit flag, unlimited, bytes.
        const entitlements = await screen.findByRole('region', { name: 'Plan & entitlements' });
        expect(within(entitlements).getByText('Users')).toBeDefined();
        expect(within(entitlements).getByText('12 / 25')).toBeDefined();
        expect(within(entitlements).getByText('Near limit')).toBeDefined();
        expect(within(entitlements).getByText('4 / Unlimited')).toBeDefined();
        expect(within(entitlements).getByText('30 GB / 100 GB')).toBeDefined();
        expect(within(entitlements).getByText('310 / 1,000')).toBeDefined();

        // Config rows render with their current values.
        const settings = await screen.findByRole('region', { name: 'Tenant settings' });
        expect(within(settings).getByText('Session timeout')).toBeDefined();
        const input = within(settings).getByLabelText('Value for session-timeout-minutes');
        expect((input as HTMLInputElement).value).toBe('45');
    });

    it('shows the friendly no-tenant empty state instead of an error for tenant-less global admins', async () => {
        stubFetch(() => Response.json(NO_TENANT_BODY, { status: 400 }));
        renderWithProviders(<TenantProfileScreen />);

        expect(await screen.findByText('No working tenant selected')).toBeDefined();
        expect(screen.queryByRole('alert')).toBeNull();
        expect(screen.queryByRole('region', { name: 'Tenant settings' })).toBeNull();
    });

    it('saving a config row PATCHes tenant/me/config with the row version as If-Match', async () => {
        const calls = stubFetch(happyHandler());
        renderWithProviders(<TenantProfileScreen />);

        const input = await screen.findByLabelText('Value for session-timeout-minutes');
        fireEvent.change(input, { target: { value: '60' } });
        fireEvent.click(screen.getByRole('button', { name: 'Save session-timeout-minutes' }));

        await waitFor(() => expect(calls.filter((call) => call.method === 'PATCH')).toHaveLength(1));
        const patch = calls.find((call) => call.method === 'PATCH');
        expect(patch?.url).toBe('/api/hope/tenant/me/config');
        expect(patch?.headers.get('if-match')).toBe('"3"');
        expect(patch?.body).toEqual([{ id: 'cfg-1', value: '60', expectedVersion: 3 }]);
    });

    it('surfaces the OCC alert on 412 and Reload latest refetches the configs', async () => {
        const calls = stubFetch(
            happyHandler({
                configPatch: () => Response.json({ statusCode: 412, message: 'Version drift', error: 'Precondition Failed' }, { status: 412 }),
            }),
        );
        renderWithProviders(<TenantProfileScreen />);

        const input = await screen.findByLabelText('Value for session-timeout-minutes');
        fireEvent.change(input, { target: { value: '60' } });
        fireEvent.click(screen.getByRole('button', { name: 'Save session-timeout-minutes' }));

        expect(await screen.findByText(/412 Precondition Failed/)).toBeDefined();

        const before = configGetCalls(calls);
        fireEvent.click(screen.getByRole('button', { name: 'Reload latest' }));
        await waitFor(() => expect(configGetCalls(calls)).toBe(before + 1));
        await waitFor(() => expect(screen.queryByText(/412 Precondition Failed/)).toBeNull());
    });

    it('locked and synthetic read-only rows cannot be edited', async () => {
        stubFetch(happyHandler());
        renderWithProviders(<TenantProfileScreen />);

        const locked = await screen.findByLabelText('Value for data-region');
        expect((locked as HTMLInputElement).disabled).toBe(true);
        const synthetic = screen.getByLabelText('Value for enable-local-raw-capture');
        expect((synthetic as HTMLInputElement).disabled).toBe(true);
    });

    it('mirrors the loaded layout with skeletons while the profile is in flight', () => {
        stubFetch(() => new Promise<Response>(() => {}));
        const { container } = renderWithProviders(<TenantProfileScreen />);

        expect(container.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(0);
        expect(screen.queryByRole('region', { name: 'Organization' })).toBeNull();
    });

    it('surfaces a block error with retry when tenant/me fails unexpectedly', async () => {
        let tenantAttempts = 0;
        stubFetch(
            happyHandler({
                tenant: () => {
                    tenantAttempts += 1;
                    return tenantAttempts === 1 ? Response.json({ message: 'upstream down' }, { status: 503 }) : Response.json(TENANT);
                },
            }),
        );
        renderWithProviders(<TenantProfileScreen />);

        expect(await screen.findByRole('alert')).toBeDefined();
        expect(screen.getByText('upstream down')).toBeDefined();

        fireEvent.click(screen.getByRole('button', { name: /retry/i }));
        // The name shows in both the header meta and the identity card.
        expect((await screen.findAllByText('Sunrise Medical Group')).length).toBeGreaterThan(0);
    });
});
