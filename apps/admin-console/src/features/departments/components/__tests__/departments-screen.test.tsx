/**
 * Frame 30 — Departments screen. fetch is stubbed at the network boundary
 * (session + gateway proxy); assertions cover the hierarchy/members render,
 * the lazy children expansion, the NoTenant gate, the If-Match edit save,
 * the type-to-confirm delete, and the empty/error states.
 */

import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '@/test/render';
import type { Department, DepartmentMember } from '../../api/types';
import { DepartmentsScreen } from '../departments-screen';
import { installFetchStub, type FetchHandler, type RecordedCall } from './fetch-stub';

vi.mock('sonner', () => ({
    toast: { success: vi.fn(), error: vi.fn() },
}));

function department(overrides: Partial<Department> = {}): Department {
    return {
        id: 'dep-cardio',
        code: 'CARD',
        name: 'Cardiology',
        description: 'Cardiology department',
        isRootDepartment: true,
        createdAt: '2025-04-01T10:00:00.000Z',
        updatedAt: '2025-06-20T10:00:00.000Z',
        resourceStatus: 'ENABLED',
        version: 7,
        ...overrides,
    };
}

const CARDIOLOGY = department();
const RADIOLOGY = department({ id: 'dep-radio', code: 'RAD', name: 'Radiology', version: 2 });
const INTERVENTIONAL = department({
    id: 'dep-interv',
    code: 'CARD-INT',
    name: 'Interventional',
    isRootDepartment: false,
    parentDepartmentId: 'dep-cardio',
    version: 1,
});

const DEPARTMENTS: Department[] = [CARDIOLOGY, RADIOLOGY, INTERVENTIONAL];
const ROOTS: Department[] = [CARDIOLOGY, RADIOLOGY];

function member(overrides: Partial<DepartmentMember> = {}): DepartmentMember {
    return {
        id: 'u-1',
        projectId: null,
        username: 'elena.vasquez',
        isServiceAccount: false,
        resourceStatus: 'ENABLED',
        resourceStatusUpdatedAt: null,
        resourceStatusUpdatedBy: null,
        createdBy: null,
        updatedBy: null,
        createdAt: '2023-05-10T08:00:00.000Z',
        updatedAt: '2026-06-01T08:00:00.000Z',
        UserRoleAssignments: [
            {
                id: 'ura-1',
                projectId: null,
                userId: 'u-1',
                roleId: 'role-1',
                roleName: 'Cardiologist',
                tenantId: 'tnt-1',
                resourceStatus: 'ENABLED',
                resourceStatusUpdatedAt: null,
                resourceStatusUpdatedBy: null,
                createdBy: null,
                updatedBy: null,
                createdAt: '2023-05-10T08:00:00.000Z',
                updatedAt: '2023-05-10T08:00:00.000Z',
            },
        ],
        ...overrides,
    };
}

const MEMBERS: DepartmentMember[] = [
    member(),
    member({ id: 'u-2', username: 'marcus.chen', UserRoleAssignments: [] }),
];

function session(overrides: Partial<{ isElevated: boolean; workingTenantId: string | null }> = {}) {
    return {
        user: { id: 'u-admin', username: 'root', email: 'root@hope.local', roles: ['GLOBAL_ADMIN'] },
        isElevated: true,
        workingTenantId: 'tnt-1',
        workingTenantName: 'Sunrise Medical Group',
        impersonatingUserId: null,
        impersonatingUsername: null,
        ...overrides,
    };
}

/** Read paths through the proxy that every test starts from. */
function defaultHandler(call: RecordedCall): Response | undefined {
    if (call.method !== 'GET') return undefined;
    const path = new URL(call.url, 'http://test.local').pathname;
    if (path === '/api/auth/session') return Response.json(session());
    if (path === '/api/hope/admin/departments') return Response.json(DEPARTMENTS);
    if (path === '/api/hope/admin/departments/roots') return Response.json(ROOTS);
    if (path === '/api/hope/admin/departments/dep-cardio/children') return Response.json([INTERVENTIONAL]);
    if (path === '/api/hope/admin/departments/dep-cardio/users') {
        return Response.json({ data: MEMBERS, count: 2, limit: 25, page: 0 });
    }
    if (path === '/api/hope/admin/departments/dep-cardio') {
        return Response.json(CARDIOLOGY, { headers: { etag: '"7"' } });
    }
    return undefined;
}

function stubDepartments(custom: FetchHandler = () => undefined): RecordedCall[] {
    return installFetchStub((call) => custom(call) ?? defaultHandler(call));
}

function pathOf(call: RecordedCall): string {
    return new URL(call.url, 'http://test.local').pathname;
}

afterEach(() => {
    vi.unstubAllGlobals();
    cleanup();
});

describe('DepartmentsScreen', () => {
    it('asks an elevated session without a working tenant to pick one (no gateway queries fired)', async () => {
        const calls = stubDepartments((call) => {
            if (pathOf(call) === '/api/auth/session') return Response.json(session({ workingTenantId: null }));
            return undefined;
        });
        renderWithProviders(<DepartmentsScreen />);

        expect(await screen.findByText('Select a working tenant')).toBeDefined();
        expect(calls.every((call) => !call.url.includes('/api/hope/'))).toBe(true);
    });

    it('renders the hierarchy roots and the selected department members from stubbed data', async () => {
        stubDepartments();
        renderWithProviders(<DepartmentsScreen />);

        expect(await screen.findByRole('heading', { level: 1, name: 'Departments' })).toBeDefined();
        expect(await screen.findByText(/3 departments/)).toBeDefined();

        const tree = await screen.findByRole('list', { name: 'Department hierarchy' });
        expect(within(tree).getByText('Cardiology')).toBeDefined();
        expect(within(tree).getByText('Radiology')).toBeDefined();

        // Cardiology (first root) is selected by default -> members grid.
        const grid = await screen.findByRole('table', { name: 'Members of Cardiology' });
        expect(await within(grid).findByText('elena.vasquez')).toBeDefined();
        expect(within(grid).getByText('marcus.chen')).toBeDefined();
        expect(within(grid).getByText('Cardiologist')).toBeDefined();
    });

    it('expands a root lazily through GET :id/children', async () => {
        const calls = stubDepartments();
        renderWithProviders(<DepartmentsScreen />);

        const tree = await screen.findByRole('list', { name: 'Department hierarchy' });
        expect(calls.some((call) => pathOf(call) === '/api/hope/admin/departments/dep-cardio/children')).toBe(false);

        fireEvent.click(screen.getByRole('button', { name: 'Expand Cardiology' }));

        expect(await within(tree).findByText('Interventional')).toBeDefined();
        expect(calls.some((call) => pathOf(call) === '/api/hope/admin/departments/dep-cardio/children')).toBe(true);
        // The sibling stays collapsed — one children read per expanded node.
        expect(calls.some((call) => pathOf(call) === '/api/hope/admin/departments/dep-radio/children')).toBe(false);
    });

    it('saves the edit form with If-Match and the body expectedVersion (OCC contract)', async () => {
        const calls = stubDepartments((call) => {
            if (call.method === 'PATCH' && pathOf(call) === '/api/hope/admin/departments/dep-cardio') {
                return Response.json({ ...CARDIOLOGY, name: 'Cardiology & Vascular', version: 8 }, { headers: { etag: '"8"' } });
            }
            return undefined;
        });
        renderWithProviders(<DepartmentsScreen />);

        const nameInput = await screen.findByLabelText('Name');
        const saveButton = screen.getByRole('button', { name: 'Save changes' }) as HTMLButtonElement;
        expect(saveButton.disabled).toBe(true);

        fireEvent.change(nameInput, { target: { value: 'Cardiology & Vascular' } });
        expect(saveButton.disabled).toBe(false);
        fireEvent.click(saveButton);

        await waitFor(() => {
            const patch = calls.find((call) => call.method === 'PATCH' && pathOf(call) === '/api/hope/admin/departments/dep-cardio');
            expect(patch).toBeDefined();
            expect(patch?.headers.get('if-match')).toBe('"7"');
            expect(patch?.body).toEqual({ name: 'Cardiology & Vascular', expectedVersion: 7 });
        });
    });

    it('saves the prompt config through its own OCC PATCH route', async () => {
        const calls = stubDepartments((call) => {
            if (call.method === 'PATCH' && pathOf(call) === '/api/hope/admin/departments/dep-cardio/prompt-config') {
                return Response.json({ ...CARDIOLOGY, preSummaryPromptId: 'pt-1', version: 8 }, { headers: { etag: '"8"' } });
            }
            return undefined;
        });
        renderWithProviders(<DepartmentsScreen />);

        fireEvent.change(await screen.findByLabelText('Pre-summary prompt ID'), { target: { value: 'pt-1' } });
        fireEvent.click(screen.getByRole('button', { name: 'Save prompt config' }));

        await waitFor(() => {
            const patch = calls.find((call) => call.method === 'PATCH' && pathOf(call) === '/api/hope/admin/departments/dep-cardio/prompt-config');
            expect(patch).toBeDefined();
            expect(patch?.headers.get('if-match')).toBe('"7"');
            expect(patch?.body).toEqual({ preSummaryPromptId: 'pt-1', expectedVersion: 7 });
        });
    });

    it('surfaces a 412 drift through the OCC conflict alert instead of a toast', async () => {
        stubDepartments((call) => {
            if (call.method === 'PATCH' && pathOf(call) === '/api/hope/admin/departments/dep-cardio') {
                return Response.json({ statusCode: 412, message: 'Version drift', error: 'Precondition Failed' }, { status: 412 });
            }
            return undefined;
        });
        renderWithProviders(<DepartmentsScreen />);

        fireEvent.change(await screen.findByLabelText('Name'), { target: { value: 'Renamed' } });
        fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

        expect(await screen.findByText(/412 Precondition Failed/)).toBeDefined();
        expect(screen.getByRole('button', { name: 'Reload latest' })).toBeDefined();
    });

    it('deletes the selected department only after typing its code to confirm', async () => {
        const calls = stubDepartments((call) => {
            if (call.method === 'DELETE' && pathOf(call) === '/api/hope/admin/departments/dep-cardio') return Response.json(CARDIOLOGY);
            return undefined;
        });
        renderWithProviders(<DepartmentsScreen />);

        fireEvent.click(await screen.findByRole('button', { name: 'Delete Cardiology' }));

        const dialog = await screen.findByRole('alertdialog');
        const confirm = within(dialog).getByRole('button', { name: 'Delete department' }) as HTMLButtonElement;
        expect(confirm.disabled).toBe(true);

        fireEvent.change(within(dialog).getByLabelText(/to confirm/i), { target: { value: 'CARD' } });
        expect(confirm.disabled).toBe(false);
        fireEvent.click(confirm);

        await waitFor(() =>
            expect(calls.some((call) => call.method === 'DELETE' && pathOf(call) === '/api/hope/admin/departments/dep-cardio')).toBe(true),
        );
    });

    it('shows the neutral empty state with the create CTA when no departments exist', async () => {
        stubDepartments((call) => {
            const path = pathOf(call);
            if (path === '/api/hope/admin/departments' || path === '/api/hope/admin/departments/roots') return Response.json([]);
            return undefined;
        });
        renderWithProviders(<DepartmentsScreen />);

        expect(await screen.findByText('No departments yet')).toBeDefined();
        expect(screen.getAllByRole('button', { name: 'New department' }).length).toBeGreaterThanOrEqual(2);
    });

    it('renders the block error state and retries the departments list', async () => {
        const calls = stubDepartments((call) => {
            if (pathOf(call) === '/api/hope/admin/departments') {
                return Response.json({ statusCode: 503, message: 'Service unavailable' }, { status: 503 });
            }
            return undefined;
        });
        renderWithProviders(<DepartmentsScreen />);

        expect(await screen.findByRole('alert')).toBeDefined();
        expect(screen.getByText(/service unavailable/i)).toBeDefined();

        fireEvent.click(screen.getByRole('button', { name: /retry/i }));
        await waitFor(() => expect(calls.filter((call) => pathOf(call) === '/api/hope/admin/departments').length).toBe(2));
    });
});
