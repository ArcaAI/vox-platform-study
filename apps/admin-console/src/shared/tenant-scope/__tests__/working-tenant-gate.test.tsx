import { screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '@/test/render';
import { WorkingTenantGate } from '../working-tenant-gate';

function stubSession(session: {
    isElevated: boolean;
    workingTenantId: string | null;
    /** BUG-005 — defaults to mirroring isElevated/workingTenantId (the non-impersonating projection). */
    effectiveIsElevated?: boolean;
    effectiveTenantId?: string | null;
}) {
    const effectiveIsElevated = session.effectiveIsElevated ?? session.isElevated;
    const effectiveTenantId = session.effectiveTenantId !== undefined ? session.effectiveTenantId : session.workingTenantId;
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
                effectiveUser: { id: 'u-1', username: 'admin', email: 'a@x.io', roles: session.isElevated ? ['GLOBAL_ADMIN'] : ['TENANT_ADMIN'], tenantId: null, departmentId: null },
                effectiveIsElevated,
                effectiveTenantId,
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

    /**
     * BUG-005 Issue 3 — while impersonating, `isElevated`/`workingTenantId`
     * stay the OPERATOR's (always elevated, often no working tenant picked),
     * so the old gate condition fired even though the impersonated user is
     * tenant-bound. The gate must key off the EFFECTIVE identity instead.
     */
    it('an impersonating session passes through — the target is tenant-bound even though the operator is elevated with no working tenant picked', async () => {
        stubSession({
            isElevated: true,
            workingTenantId: null,
            effectiveIsElevated: false,
            effectiveTenantId: 'tnt-impersonated',
        });
        renderWithProviders(
            <WorkingTenantGate title="Departments">
                <p>screen body</p>
            </WorkingTenantGate>,
        );

        expect(await screen.findByText('screen body')).toBeDefined();
        expect(screen.queryByText('Select a working tenant')).toBeNull();
    });

    it('a genuinely elevated session with no tenant picked still gates, even mid-impersonation-adjacent state', async () => {
        stubSession({
            isElevated: true,
            workingTenantId: null,
            effectiveIsElevated: true,
            effectiveTenantId: null,
        });
        renderWithProviders(
            <WorkingTenantGate title="Departments">
                <p>screen body</p>
            </WorkingTenantGate>,
        );

        expect(await screen.findByText('Select a working tenant')).toBeDefined();
        expect(screen.queryByText('screen body')).toBeNull();
    });
});
