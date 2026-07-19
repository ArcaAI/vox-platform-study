/**
 * Frame 20.1 — User detail screen: header + actions (impersonate entry,
 * reset-password, lifecycle), URL-synced tabs, per-tab data states, and the
 * OCC (412) handling on the etag'd department edit. fetch is stubbed with
 * URL/method branching across the user sub-resources.
 */

import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { useBreadcrumbStore } from '@/shared/navigation/breadcrumb-store';
import { renderWithProviders } from '@/test/render';
import type { User, UserDepartment, UserProfile, UserRoleAssignment, UserSetting, VoiceProfile } from '../../api/types';
import { UserDetailScreen } from '../user-detail-screen';

const push = vi.hoisted(() => vi.fn());
const refresh = vi.hoisted(() => vi.fn());

vi.mock('next/navigation', () => ({
    useRouter: () => ({ push, replace: vi.fn(), refresh, back: vi.fn() }),
}));

vi.mock('sonner', () => ({
    toast: { success: vi.fn(), error: vi.fn() },
}));

const DETAIL: User = {
    id: 'u-1',
    projectId: null,
    createdAt: '2025-03-02T10:00:00.000Z',
    updatedAt: '2025-06-28T10:00:00.000Z',
    resourceStatus: 'ENABLED',
    resourceStatusUpdatedAt: null,
    resourceStatusUpdatedBy: null,
    createdBy: null,
    updatedBy: null,
    username: 'mia.okafor',
    lastLoginAt: '2025-06-30T09:12:00.000Z',
    lastActiveAt: '2025-06-30T10:00:00.000Z',
    externalId: 'usr_7d3f',
    isServiceAccount: false,
};

const ROLE: UserRoleAssignment = {
    id: 'ra-1',
    projectId: null,
    createdAt: '2025-06-01T10:00:00.000Z',
    updatedAt: '2025-06-01T10:00:00.000Z',
    resourceStatus: 'ENABLED',
    resourceStatusUpdatedAt: null,
    resourceStatusUpdatedBy: null,
    createdBy: null,
    updatedBy: null,
    userId: 'u-1',
    roleId: 'role-clinician',
    roleName: 'Clinician',
    tenantId: 't-1',
};

const DEPARTMENTS: UserDepartment[] = [
    {
        id: 'da-1',
        userId: 'u-1',
        departmentId: 'd-cardio',
        departmentName: 'Cardiology',
        departmentCode: 'CARD',
        isPrimary: true,
        tenantId: 't-1',
        resourceStatus: 'ENABLED',
        createdAt: '2025-06-01T10:00:00.000Z',
        updatedAt: '2025-06-01T10:00:00.000Z',
        version: 2,
    },
    {
        id: 'da-2',
        userId: 'u-1',
        departmentId: 'd-icu',
        isPrimary: false,
        tenantId: 't-1',
        resourceStatus: 'ENABLED',
        createdAt: '2025-06-02T10:00:00.000Z',
        updatedAt: '2025-06-02T10:00:00.000Z',
        version: 3,
    },
];

const SETTING: UserSetting = {
    id: 's-1',
    projectId: null,
    createdAt: '2025-06-01T10:00:00.000Z',
    updatedAt: '2025-06-01T10:00:00.000Z',
    resourceStatus: 'ENABLED',
    resourceStatusUpdatedAt: null,
    resourceStatusUpdatedBy: null,
    createdBy: null,
    updatedBy: null,
    name: 'Theme',
    key: 'theme',
    value: 'dark',
    dataType: 'string',
    namespace: 'ui',
    userId: 'u-1',
};

const PROFILE: UserProfile = {
    id: 'p-1',
    projectId: null,
    createdAt: '2025-06-01T10:00:00.000Z',
    updatedAt: '2025-06-01T10:00:00.000Z',
    resourceStatus: 'ENABLED',
    resourceStatusUpdatedAt: null,
    resourceStatusUpdatedBy: null,
    createdBy: null,
    updatedBy: null,
    firstName: 'Mia',
    lastName: 'Okafor',
    email: 'mia@sunrise.example',
    phone: '+1 555 0100',
    userId: 'u-1',
};

const VOICE_PROFILES: VoiceProfile[] = [
    { id: 'vp-1', userId: 'u-1', isActive: true, label: 'Primary mic', modelId: 'ecapa-v2', createdAt: '2025-06-01T10:00:00.000Z', updatedAt: '2025-06-01T10:00:00.000Z' },
];

const API_KEY = {
    id: 'ak-1',
    projectId: null,
    createdAt: '2025-06-01T10:00:00.000Z',
    updatedAt: '2025-06-01T10:00:00.000Z',
    resourceStatus: 'ENABLED',
    resourceStatusUpdatedAt: null,
    resourceStatusUpdatedBy: null,
    createdBy: null,
    updatedBy: null,
    keyName: 'SDK key',
    keyPrefix: 'ak_live_x1',
    keyType: 'SDK',
    keyStatus: 'ACTIVE',
    usageCount: 42,
    lastUsedAt: '2025-06-30T10:00:00.000Z',
    userId: 'u-1',
};

interface RecordedCall {
    url: string;
    method: string;
    headers: Headers;
    body: unknown;
}

function stubFetch(handler: (url: string, init?: RequestInit) => Response | undefined): RecordedCall[] {
    const calls: RecordedCall[] = [];
    vi.stubGlobal(
        'fetch',
        vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
            const url = String(input);
            calls.push({
                url,
                method: init?.method ?? 'GET',
                headers: new Headers(init?.headers),
                body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
            });
            const response = handler(url, init);
            if (!response) throw new Error(`Unhandled fetch: ${init?.method ?? 'GET'} ${url}`);
            return response;
        }),
    );
    return calls;
}

/** Happy-path handlers for every user sub-resource; overrides win. */
function stubDetailFetch(overrides?: (url: string, init?: RequestInit) => Response | undefined): RecordedCall[] {
    return stubFetch((url, init) => {
        const method = init?.method ?? 'GET';
        const custom = overrides?.(url, init);
        if (custom) return custom;
        if (method === 'GET' && url === '/api/hope/admin/users/u-1') return Response.json(DETAIL);
        if (method === 'GET' && url === '/api/hope/admin/users/u-1/roles') return Response.json({ data: [ROLE], count: 1, limit: 25, page: 0 });
        if (method === 'GET' && url === '/api/hope/admin/users/u-1/departments') return Response.json(DEPARTMENTS);
        if (method === 'GET' && url === '/api/hope/admin/users/u-1/settings') return Response.json([SETTING]);
        if (method === 'GET' && url === '/api/hope/admin/users/u-1/profile') return Response.json(PROFILE);
        if (method === 'GET' && url === '/api/hope/admin/users/u-1/voice-profiles') return Response.json(VOICE_PROFILES);
        if (method === 'GET' && url === '/api/hope/admin/users/u-1/api-keys') return Response.json({ data: [API_KEY], count: 1, limit: 25, page: 0 });
        // Shared id -> name catalogs (TASK-424): tenants (Paginated), rbac roles ({data,total,page,pageSize}), departments (plain array).
        if (method === 'GET' && url.startsWith('/api/hope/admin/tenants')) {
            return Response.json({
                data: [
                    { id: '00000000-0000-0000-0000-000000000000', name: 'Global', key: 'SYSTEM' },
                    { id: 't-1', name: 'Acme Clinic', key: 'acme' },
                ],
                count: 2,
                limit: 500,
                page: 0,
            });
        }
        if (method === 'GET' && url.startsWith('/api/hope/admin/rbac/roles')) {
            return Response.json({
                data: [{ id: 'role-clinician', name: 'Clinician', isSystemRole: false, resourceStatus: 'ENABLED', createdAt: '2025-01-01T00:00:00.000Z', updatedAt: '2025-01-01T00:00:00.000Z' }],
                total: 1,
                page: 1,
                pageSize: 500,
            });
        }
        if (method === 'GET' && url.startsWith('/api/hope/admin/departments')) {
            return Response.json([{ id: 'dept-1', code: 'CARD', name: 'Cardiology', isRootDepartment: true }]);
        }
        if (method === 'POST' && url === '/api/auth/impersonate') {
            return Response.json({ impersonation: { targetUserId: 'u-1', targetUsername: 'mia.okafor', expiresAt: '2025-07-01T10:00:00.000Z' } });
        }
        if (method === 'POST' && url === '/api/hope/admin/users/u-1/reset-password') {
            return Response.json({ mode: 'link', token: 'tok-1', resetPath: '/reset-password?token=tok-1', emailSent: false });
        }
        if (method === 'POST' && url === '/api/hope/admin/users/u-1/roles') return Response.json({ ...ROLE, id: 'ra-2', roleId: 'role-billing' });
        if (method === 'DELETE' && url === '/api/hope/admin/users/u-1/roles/ra-1') return new Response(null, { status: 204 });
        if (method === 'POST' && url === '/api/hope/admin/users/u-1/departments') return Response.json(DEPARTMENTS[1]);
        if (method === 'PATCH' && url === '/api/hope/admin/users/u-1/departments/da-2') {
            return Response.json({ ...DEPARTMENTS[1], isPrimary: true, version: 4 }, { headers: { etag: '"4"' } });
        }
        if (method === 'DELETE' && url === '/api/hope/admin/users/u-1/departments/da-2') return new Response(null, { status: 204 });
        if (method === 'PATCH' && url === '/api/hope/admin/users/u-1/settings/ui/theme') return Response.json({ ...SETTING, value: 'light' });
        if (method === 'PATCH' && url === '/api/hope/admin/users/u-1/profile') return Response.json(PROFILE);
        if (method === 'PATCH' && url === '/api/hope/admin/users/u-1/status') return Response.json({ ...DETAIL, resourceStatus: 'DISABLED' });
        if (method === 'DELETE' && url === '/api/hope/admin/users/u-1') return Response.json(DETAIL);
        return undefined;
    });
}

// Radix Select scrolls the highlighted item into view on open; happy-dom has no layout engine.
beforeAll(() => {
    if (!Element.prototype.scrollIntoView) {
        Element.prototype.scrollIntoView = () => {};
    }
});

/** Open a Radix Select trigger and pick an option by its visible label (happy-dom pointer path). */
async function selectOption(trigger: HTMLElement, optionName: string | RegExp) {
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: 'mouse' });
    const option = await screen.findByRole('option', { name: optionName });
    fireEvent.pointerUp(option, { button: 0, ctrlKey: false, pointerType: 'mouse' });
    fireEvent.click(option);
}

afterEach(() => {
    vi.unstubAllGlobals();
    push.mockClear();
    refresh.mockClear();
    cleanup();
});

describe('UserDetailScreen', () => {
    it('renders the user header, tabs and publishes the breadcrumb', async () => {
        stubDetailFetch();
        renderWithProviders(<UserDetailScreen id="u-1" />);

        expect(await screen.findByRole('heading', { level: 1, name: 'mia.okafor' })).toBeDefined();
        expect(screen.getByText('u-1')).toBeDefined();
        // Status is shown in the header meta AND the ScreenTemplate footer (TASK-427).
        expect(screen.getAllByText('Active').length).toBeGreaterThan(0);
        for (const tab of ['Roles', 'Departments', 'Settings', 'Profile', 'Security']) {
            expect(screen.getByRole('tab', { name: tab })).toBeDefined();
        }
        await waitFor(() => expect(useBreadcrumbStore.getState().trailing).toBe('mia.okafor'));
    });

    it('renders the 404-over-403 not-found state instead of crashing', async () => {
        stubFetch(() => Response.json({ message: 'User not found' }, { status: 404 }));
        renderWithProviders(<UserDetailScreen id="u-missing" />);

        expect(await screen.findByText(/user not found/i)).toBeDefined();
        expect(screen.getByText(/may not exist or you may not have access/i)).toBeDefined();
        expect(screen.getByRole('button', { name: /back to users/i })).toBeDefined();
    });

    it('impersonates through the confirm dialog by POSTing to the BFF auth route', async () => {
        const calls = stubDetailFetch();
        renderWithProviders(<UserDetailScreen id="u-1" />);

        fireEvent.click(await screen.findByRole('button', { name: /impersonate/i }));
        const dialog = await screen.findByRole('alertdialog');
        expect(within(dialog).getByText(/audit/i)).toBeDefined();
        fireEvent.click(within(dialog).getByRole('button', { name: /impersonate/i }));

        await waitFor(() => {
            const post = calls.find((call) => call.method === 'POST' && call.url === '/api/auth/impersonate');
            expect(post?.body).toEqual({ userId: 'u-1' });
        });
        await waitFor(() => expect(refresh).toHaveBeenCalled());
    });

    it('resets the password through the confirm dialog and surfaces the reset link', async () => {
        const calls = stubDetailFetch();
        renderWithProviders(<UserDetailScreen id="u-1" />);

        fireEvent.click(await screen.findByRole('button', { name: /reset password/i }));
        const dialog = await screen.findByRole('alertdialog');
        fireEvent.click(within(dialog).getByRole('button', { name: /reset password/i }));

        await waitFor(() => expect(calls.some((call) => call.method === 'POST' && call.url === '/api/hope/admin/users/u-1/reset-password')).toBe(true));
        expect(await screen.findByText('/reset-password?token=tok-1')).toBeDefined();
    });

    it('requires typing the username to arm delete, then navigates back to the list', async () => {
        const calls = stubDetailFetch();
        renderWithProviders(<UserDetailScreen id="u-1" />);

        fireEvent.click(await screen.findByRole('button', { name: /^delete$/i }));
        const dialog = await screen.findByRole('alertdialog');
        const confirm = within(dialog).getByRole('button', { name: /delete user/i }) as HTMLButtonElement;
        expect(confirm.disabled).toBe(true);

        fireEvent.change(within(dialog).getByLabelText(/to confirm/i), { target: { value: 'mia.okafor' } });
        expect(confirm.disabled).toBe(false);
        fireEvent.click(confirm);

        await waitFor(() => expect(calls.some((call) => call.method === 'DELETE' && call.url === '/api/hope/admin/users/u-1')).toBe(true));
        await waitFor(() => expect(push).toHaveBeenCalledWith('/users'));
    });

    it('lists role assignments with the role name primary and the scope tenant resolved by name', async () => {
        stubDetailFetch();
        renderWithProviders(<UserDetailScreen id="u-1" />);

        // Role name is the primary label; the raw role id is demoted to metadata.
        expect(await screen.findByText('Clinician')).toBeDefined();
        expect(screen.getByText('role-clinician')).toBeDefined();
        // Scope tenant id resolves to the catalog display name, with the id still shown.
        expect(await screen.findByText('Acme Clinic')).toBeDefined();
        expect(screen.getByText('t-1')).toBeDefined();
    });

    it('assigns a role by selecting from the catalog and posts the system tenant for a global scope', async () => {
        const calls = stubDetailFetch();
        renderWithProviders(<UserDetailScreen id="u-1" />);

        await screen.findByText('Clinician');
        fireEvent.click(screen.getByRole('button', { name: /assign role/i }));
        const dialog = await screen.findByRole('dialog');

        // The role field is now a catalog-fed select offering the "Clinician" option.
        await selectOption(within(dialog).getByLabelText(/^role/i), 'Clinician');
        // Tenant defaults to the catalog's real SYSTEM tenant row.
        fireEvent.click(within(dialog).getByRole('button', { name: /^assign$/i }));

        await waitFor(() => {
            const post = calls.find((call) => call.method === 'POST' && call.url === '/api/hope/admin/users/u-1/roles');
            expect(post?.body).toEqual({ roleId: 'role-clinician', tenantId: '00000000-0000-0000-0000-000000000000' });
        });
    });

    it('removes a role assignment through its confirm dialog', async () => {
        const calls = stubDetailFetch();
        renderWithProviders(<UserDetailScreen id="u-1" />);

        fireEvent.click(await screen.findByRole('button', { name: /remove role clinician/i }));
        const dialog = await screen.findByRole('alertdialog');
        fireEvent.click(within(dialog).getByRole('button', { name: /^remove$/i }));

        await waitFor(() => expect(calls.some((call) => call.method === 'DELETE' && call.url === '/api/hope/admin/users/u-1/roles/ra-1')).toBe(true));
    });

    it('makes a department primary with If-Match and the body expectedVersion', async () => {
        const calls = stubDetailFetch();
        renderWithProviders(<UserDetailScreen id="u-1" />, { searchParams: '?tab=departments' });

        fireEvent.click(await screen.findByRole('button', { name: /make d-icu primary/i }));

        await waitFor(() => {
            const patch = calls.find((call) => call.method === 'PATCH' && call.url === '/api/hope/admin/users/u-1/departments/da-2');
            expect(patch?.body).toEqual({ isPrimary: true, expectedVersion: 3 });
            expect(patch?.headers.get('if-match')).toBe('"3"');
        });
    });

    it('renders the OCC conflict alert when the department edit hits 412', async () => {
        stubDetailFetch((url, init) => {
            if (init?.method === 'PATCH' && url === '/api/hope/admin/users/u-1/departments/da-2') {
                return Response.json({ message: 'Precondition failed' }, { status: 412 });
            }
            return undefined;
        });
        renderWithProviders(<UserDetailScreen id="u-1" />, { searchParams: '?tab=departments' });

        fireEvent.click(await screen.findByRole('button', { name: /make d-icu primary/i }));

        expect(await screen.findByText(/412 precondition failed/i)).toBeDefined();
        expect(screen.getByRole('button', { name: /reload latest/i })).toBeDefined();
    });

    it('shows the department name and code as the primary label', async () => {
        stubDetailFetch();
        renderWithProviders(<UserDetailScreen id="u-1" />, { searchParams: '?tab=departments' });

        expect(await screen.findByText('Cardiology (CARD)')).toBeDefined();
        // The raw department id remains as secondary metadata beneath the name.
        expect(screen.getByText('d-cardio')).toBeDefined();
    });

    // TASK-430 — cross-tenant memberships are attributed to their tenant.
    it('renders a Tenant column on the departments tab with the catalog name', async () => {
        stubDetailFetch();
        renderWithProviders(<UserDetailScreen id="u-1" />, { searchParams: '?tab=departments' });

        await screen.findByText('Cardiology (CARD)');
        // Both fixture rows belong to t-1, resolved to the catalog name.
        expect((await screen.findAllByText('Acme Clinic')).length).toBeGreaterThan(0);
    });

    it('assigns a department by selecting from the catalog', async () => {
        const calls = stubDetailFetch();
        renderWithProviders(<UserDetailScreen id="u-1" />, { searchParams: '?tab=departments' });

        fireEvent.click(await screen.findByRole('button', { name: /assign department/i }));
        const dialog = await screen.findByRole('dialog');

        await selectOption(within(dialog).getByLabelText(/^department/i), 'Cardiology (CARD)');
        fireEvent.click(within(dialog).getByRole('button', { name: /^assign$/i }));

        await waitFor(() => {
            const post = calls.find((call) => call.method === 'POST' && call.url === '/api/hope/admin/users/u-1/departments');
            expect(post?.body).toEqual({ departmentId: 'dept-1' });
        });
    });

    it('edits a setting value through the dialog PATCHing namespace/key', async () => {
        const calls = stubDetailFetch();
        renderWithProviders(<UserDetailScreen id="u-1" />, { searchParams: '?tab=settings' });

        fireEvent.click(await screen.findByRole('button', { name: /edit ui\/theme/i }));
        const dialog = await screen.findByRole('dialog');
        fireEvent.change(within(dialog).getByLabelText(/^value/i), { target: { value: 'light' } });
        fireEvent.click(within(dialog).getByRole('button', { name: /^save$/i }));

        await waitFor(() => {
            const patch = calls.find((call) => call.method === 'PATCH' && call.url === '/api/hope/admin/users/u-1/settings/ui/theme');
            expect(patch?.body).toEqual({ value: 'light' });
        });
    });

    it('renders an empty profile form when the user has no profile', async () => {
        stubDetailFetch((url, init) => {
            if (init?.method === 'GET' && url === '/api/hope/admin/users/u-1/profile') return new Response(null, { status: 204 });
            return undefined;
        });
        renderWithProviders(<UserDetailScreen id="u-1" />, { searchParams: '?tab=profile' });

        expect((await screen.findByLabelText('First name') as HTMLInputElement).value).toBe('');
        expect(screen.getByText(/no profile yet/i)).toBeDefined();
    });

    it('saves the profile form through the upsert PATCH', async () => {
        const calls = stubDetailFetch();
        renderWithProviders(<UserDetailScreen id="u-1" />, { searchParams: '?tab=profile' });

        const firstName = await screen.findByLabelText(/first name/i);
        fireEvent.change(firstName, { target: { value: 'Amelia' } });
        fireEvent.click(screen.getByRole('button', { name: /save profile/i }));

        await waitFor(() => {
            const patch = calls.find((call) => call.method === 'PATCH' && call.url === '/api/hope/admin/users/u-1/profile');
            expect(patch?.body).toEqual({ firstName: 'Amelia', lastName: 'Okafor', email: 'mia@sunrise.example', phone: '+1 555 0100' });
        });
    });

    it('renders read-only voice profiles and API keys on the security tab', async () => {
        stubDetailFetch();
        renderWithProviders(<UserDetailScreen id="u-1" />, { searchParams: '?tab=security' });

        expect(await screen.findByText('Primary mic')).toBeDefined();
        expect(screen.getByText('SDK key')).toBeDefined();
        expect(screen.getByText('ak_live_x1')).toBeDefined();
    });
});
