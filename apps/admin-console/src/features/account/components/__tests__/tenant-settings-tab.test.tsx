/**
 * BUG-005 Issue 2 — end-user-safe Settings tab. `TenantSettingsTab` is shared
 * by admins (editable) and end-users/impersonated sessions (read-only): the
 * `readOnly` prop disables every control and suppresses the Save/Cancel bar,
 * regardless of `locked`/synthetic row state.
 */

import { cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TenantConfig } from '@/features/tenants/api/types';
import { renderWithProviders } from '@/test/render';
import { TenantSettingsTab } from '../tenant-settings-tab';

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

const EDITABLE_CONFIG: TenantConfig = {
    id: 'cfg-1',
    ...BASE,
    name: 'Session timeout',
    description: 'Idle minutes before members are signed out.',
    key: 'session-timeout-minutes',
    defaultValue: '30',
    value: '45',
    dataType: 'Integer',
    namespace: 'security',
    tenantId: 'ten-1',
    tenantCode: 'sunrise-medical',
    version: 3,
};

const CONFIG_PAGE = { data: [EDITABLE_CONFIG], count: 1, limit: 200, page: 1 };

function stubConfigFetch(): void {
    vi.stubGlobal(
        'fetch',
        vi.fn(async (input: string | URL | Request) => {
            const url = String(input);
            if (url.includes('/tenant/me/config')) return Response.json(CONFIG_PAGE);
            throw new Error(`Unexpected fetch in test: ${url}`);
        }),
    );
}

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});

describe('TenantSettingsTab — readOnly (BUG-005 Issue 2)', () => {
    it('disables a normally-editable row when readOnly', async () => {
        stubConfigFetch();
        renderWithProviders(<TenantSettingsTab readOnly />);

        const input = await screen.findByLabelText('Value for session-timeout-minutes');
        expect((input as HTMLInputElement).disabled).toBe(true);
    });

    it('leaves a normally-editable row enabled when NOT readOnly (regression)', async () => {
        stubConfigFetch();
        renderWithProviders(<TenantSettingsTab />);

        const input = await screen.findByLabelText('Value for session-timeout-minutes');
        expect((input as HTMLInputElement).disabled).toBe(false);
    });

    it('never shows the Save/Cancel bar when readOnly, even if a change event fires', async () => {
        stubConfigFetch();
        renderWithProviders(<TenantSettingsTab readOnly />);

        const input = await screen.findByLabelText('Value for session-timeout-minutes');
        fireEvent.change(input, { target: { value: '60' } });

        expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
        expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
    });

    it('shows the Save/Cancel bar for a dirty row when NOT readOnly (regression)', async () => {
        stubConfigFetch();
        renderWithProviders(<TenantSettingsTab />);

        const input = await screen.findByLabelText('Value for session-timeout-minutes');
        fireEvent.change(input, { target: { value: '60' } });

        expect(await screen.findByRole('button', { name: 'Save' })).toBeDefined();
    });
});
