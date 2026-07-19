/**
 * TDD screen tests for TASK-512 screen 3 (Agentic Policy): the global-default
 * knob editor with If-Match OCC + tri-state overrides, the engine kill-switch,
 * the read-only agentic.* catalog, the GLOBAL_ADMIN-only gate and axe-cleanliness
 * — against a URL-branching fetch stub covering the BFF session route.
 */

import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import * as axeMatchers from 'vitest-axe/matchers';
import { renderWithProviders } from '@/test/render';
import type { AgenticPolicy, SettingCatalog } from '../../api/types';
import { AgenticPolicyScreen } from '../agentic-policy-screen';

expect.extend(axeMatchers);

vi.mock('sonner', () => ({
    toast: { success: vi.fn(), error: vi.fn() },
}));

function policy(overrides: Partial<AgenticPolicy> = {}): AgenticPolicy {
    return {
        id: 'hp-sys',
        tenantId: '00000000-0000-0000-0000-000000000000',
        source: 'system-default',
        entityFaithfulnessThreshold: 1,
        coverageThreshold: 0.8,
        citationPresenceThreshold: 1,
        numericDoseThreshold: 1,
        groundednessThreshold: 0.8,
        safetyEnabled: true,
        phiEnabled: true,
        phiFailClosed: true,
        safetyProvider: 'lm-studio',
        safetyModel: 'granite-guardian-4.1-8b',
        smrProvider: null,
        smrModel: null,
        maxRegen: 2,
        gateSlaSeconds: 86400,
        gateEscalationSeconds: 43200,
        toolAllowlist: null,
        optimisticDeliveryEnabled: null,
        atomicFactEnabled: true,
        retrievalEnabled: null,
        warmStartEnabled: null,
        nerPriorsEnabled: null,
        maxEditReruns: null,
        regenFeedbackEnabled: null,
        updatedAt: '2026-07-01T00:00:00.000Z',
        version: 3,
        ...overrides,
    };
}

const CATALOG: SettingCatalog = {
    items: [
        {
            key: 'agentic.context.maxTokens',
            tier: 'platform',
            dataType: 'number',
            sensitivity: 'internal',
            maxScope: 'tenant',
            editableBy: 'GLOBAL_ADMIN',
            category: 'Agentic Context',
            globalOnly: true,
            label: 'Context window',
            description: 'Max tokens fed to the agentic loop.',
        },
        {
            key: 'pipeline.harnessEnabled',
            tier: 'platform',
            dataType: 'boolean',
            sensitivity: 'internal',
            maxScope: 'tenant',
            editableBy: 'GLOBAL_ADMIN',
            category: 'Pipeline',
        },
    ],
    categories: ['Agentic Context', 'Pipeline'],
};

const SESSION = {
    user: { id: 'u-1', username: 'super_admin', email: 'admin@arca.ai', roles: ['GLOBAL_ADMIN'] },
    isElevated: true,
    workingTenantId: null as string | null,
    workingTenantName: null as string | null,
    impersonatingUserId: null,
    impersonatingUsername: null,
    effectiveUser: { id: 'u-1', username: 'super_admin', email: 'admin@arca.ai', roles: ['GLOBAL_ADMIN'], tenantId: null, departmentId: null },
    effectiveIsElevated: true,
    effectiveTenantId: null as string | null,
};

const TENANT_ADMIN_SESSION = {
    ...SESSION,
    user: { ...SESSION.user, username: 'tenant_admin', roles: ['TENANT_ADMIN'] },
    isElevated: false,
    effectiveUser: { ...SESSION.effectiveUser, username: 'tenant_admin', roles: ['TENANT_ADMIN'] },
    effectiveIsElevated: false,
};

interface RecordedCall {
    url: string;
    method: string;
    headers: Headers;
    body: unknown;
}

interface StubOptions {
    session?: typeof SESSION;
    globalPolicy?: AgenticPolicy;
    custom?: (call: RecordedCall) => Response | undefined;
}

function stubFetch({ session = SESSION, globalPolicy = policy(), custom }: StubOptions = {}): RecordedCall[] {
    const calls: RecordedCall[] = [];
    vi.stubGlobal(
        'fetch',
        vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
            const call: RecordedCall = {
                url: String(input),
                method: init?.method ?? 'GET',
                headers: new Headers(init?.headers),
                body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
            };
            calls.push(call);
            const handled = custom?.(call);
            if (handled) return handled;
            if (call.url === '/api/auth/session') return Response.json(session);
            if (call.method === 'GET' && call.url === '/api/hope/admin/harness/policy/global') {
                return Response.json(globalPolicy, { headers: { etag: `"${globalPolicy.version}"` } });
            }
            if (call.method === 'GET' && call.url === '/api/hope/admin/harness/live/config') {
                return Response.json({ enabled: true, envDefault: true, source: 'env-default' });
            }
            if (call.method === 'GET' && call.url === '/api/hope/admin/settings/catalog') {
                return Response.json(CATALOG);
            }
            throw new Error(`Unhandled fetch: ${call.method} ${call.url}`);
        }),
    );
    return calls;
}

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});

describe('AgenticPolicyScreen', () => {
    it('renders the global-default knob editor with the loop toggles and kill-switches', async () => {
        stubFetch();
        renderWithProviders(<AgenticPolicyScreen />);

        expect(screen.getByRole('heading', { level: 1, name: 'Agentic Policy' })).toBeDefined();
        expect(await screen.findByText('Global default agentic loop')).toBeDefined();
        expect(screen.getByLabelText('Optimistic delivery')).toBeDefined();
        expect(screen.getByLabelText('Max edit re-runs')).toBeDefined();
        expect(screen.getByLabelText('Safety guardrail')).toBeDefined();
        expect(screen.getByLabelText('Reason')).toBeDefined();
        expect(screen.getByRole('button', { name: /Save · If-Match/ })).toBeDefined();
    });

    it('saves a sparse patch with If-Match + expectedVersion, clearing/setting tri-state overrides', async () => {
        const calls = stubFetch({
            custom: (call) => {
                if (call.method === 'PATCH' && call.url === '/api/hope/admin/harness/policy/global') {
                    return Response.json(policy({ optimisticDeliveryEnabled: true, version: 4 }), { headers: { etag: '"4"' } });
                }
                return undefined;
            },
        });
        renderWithProviders(<AgenticPolicyScreen />);

        const optimistic = await screen.findByLabelText('Optimistic delivery');
        fireEvent.change(optimistic, { target: { value: 'on' } });
        fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'enable optimistic delivery' } });
        expect(screen.getByText('Unsaved changes')).toBeDefined();
        fireEvent.click(screen.getByRole('button', { name: /Save · If-Match/ }));

        await waitFor(() => expect(calls.some((call) => call.method === 'PATCH')).toBe(true));
        const patch = calls.find((call) => call.method === 'PATCH');
        expect(patch?.url).toBe('/api/hope/admin/harness/policy/global');
        expect(patch?.headers.get('if-match')).toBe('"3"');
        expect(patch?.body).toEqual({ optimisticDeliveryEnabled: true, reason: 'enable optimistic delivery', expectedVersion: 3 });
    });

    it('shows the OCC conflict alert with reload-merge when the PATCH returns 412', async () => {
        stubFetch({
            custom: (call) => {
                if (call.method === 'PATCH') return Response.json({ message: 'Precondition Failed' }, { status: 412 });
                return undefined;
            },
        });
        renderWithProviders(<AgenticPolicyScreen />);

        fireEvent.change(await screen.findByLabelText('Max edit re-runs'), { target: { value: '3' } });
        fireEvent.click(screen.getByRole('button', { name: /Save · If-Match/ }));

        expect(await screen.findByText(/412 Precondition Failed/)).toBeDefined();
        expect(screen.getByRole('button', { name: 'Reload latest' })).toBeDefined();
        // Local edits are kept for the reload-merge.
        expect((screen.getByLabelText('Max edit re-runs') as HTMLInputElement).value).toBe('3');
    });

    it('renders the engine kill-switch on the engine tab', async () => {
        stubFetch();
        renderWithProviders(<AgenticPolicyScreen />, { searchParams: '?tab=engine' });

        expect(await screen.findByText('Agentic engine')).toBeDefined();
        expect(screen.getByLabelText('Engine enabled')).toBeDefined();
    });

    it('lists only the agentic.* catalog rows on the context tab', async () => {
        stubFetch();
        renderWithProviders(<AgenticPolicyScreen />, { searchParams: '?tab=context' });

        const table = await screen.findByRole('table', { name: 'Agentic context settings catalog' });
        expect(table).toBeDefined();
        expect(screen.getByText('agentic.context.maxTokens')).toBeDefined();
        // Pipeline row is a different category and must not leak in.
        expect(screen.queryByText('pipeline.harnessEnabled')).toBeNull();
    });

    it('gates a non-elevated session behind the global-admins-only empty state', async () => {
        stubFetch({ session: TENANT_ADMIN_SESSION });
        renderWithProviders(<AgenticPolicyScreen />);

        expect(await screen.findByText('Global admins only')).toBeDefined();
        expect(screen.queryByRole('tab', { name: 'Global default' })).toBeNull();
    });

    it('surfaces a block error with retry when the global policy read fails', async () => {
        let attempts = 0;
        stubFetch({
            custom: (call) => {
                if (call.method === 'GET' && call.url === '/api/hope/admin/harness/policy/global') {
                    attempts += 1;
                    if (attempts === 1) return Response.json({ message: 'harness unavailable' }, { status: 503 });
                }
                return undefined;
            },
        });
        renderWithProviders(<AgenticPolicyScreen />);

        expect(await screen.findByRole('alert')).toBeDefined();
        expect(screen.getByText('harness unavailable')).toBeDefined();

        fireEvent.click(screen.getByRole('button', { name: /retry/i }));
        expect(await screen.findByText('Global default agentic loop')).toBeDefined();
    });

    it('has no axe violations on the global-default editor', async () => {
        stubFetch();
        const { container } = renderWithProviders(<AgenticPolicyScreen />);
        await screen.findByText('Global default agentic loop');
        expect(await axe(container)).toHaveNoViolations();
    });
});
