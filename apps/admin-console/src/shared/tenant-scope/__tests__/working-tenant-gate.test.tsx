import { screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '@/test/render';
import { WorkingTenantGate } from '../working-tenant-gate';

function stubSession(session: { isElevated: boolean; workingTenantId: string | null }) {
    vi.stubGlobal(
        'fetch',
        vi.fn(async () =>
            Response.json({
                user: { id: 'u-1', username: 'admin', email: 'a@x.io', roles: session.isElevated ? ['GLOBAL_ADMIN'] : ['TENANT_ADMIN'] },
                isElevated: session.isElevated,
                workingTenantId: session.workingTenantId,
                workingTenantName: session.workingTenantId ? 'Sunrise Medical Group' : null,
                impersonatingUserId: null,
                impersonatingUsername: null,
            }),
        ),
    );
}

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('WorkingTenantGate', () => {
    it('gates an elevated session without a working tenant behind the NoTenant empty state', async () => {
        stubSession({ isElevated: true, workingTenantId: null });
        renderWithProviders(
            <WorkingTenantGate title="Departments">
                <p>screen body</p>
            </WorkingTenantGate>,
        );

        expect(await screen.findByText('Select a working tenant')).toBeDefined();
        expect(screen.getByRole('heading', { level: 1, name: 'Departments' })).toBeDefined();
        expect(screen.queryByText('screen body')).toBeNull();
    });

    it('mounts the body once an elevated session has a working tenant', async () => {
        stubSession({ isElevated: true, workingTenantId: 'tnt-1' });
        renderWithProviders(
            <WorkingTenantGate title="Departments">
                <p>screen body</p>
            </WorkingTenantGate>,
        );

        expect(await screen.findByText('screen body')).toBeDefined();
        expect(screen.queryByText('Select a working tenant')).toBeNull();
    });

    it('passes tenant-pinned admins straight through (they never see the gate)', async () => {
        stubSession({ isElevated: false, workingTenantId: null });
        renderWithProviders(
            <WorkingTenantGate title="Departments">
                <p>screen body</p>
            </WorkingTenantGate>,
        );

        expect(await screen.findByText('screen body')).toBeDefined();
        expect(screen.queryByText('Select a working tenant')).toBeNull();
    });
});
