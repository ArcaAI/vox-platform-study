/**
 * F-036: the `New provider` default-role picker must never offer roles the
 * backend rejects at JIT provisioning. `federated-auth.service.ts` hard-blocks
 * `GLOBAL_ADMIN` (`role.name === 'GLOBAL_ADMIN'` -> 403) and `SERVICE_ACCOUNT`
 * users cannot sign in interactively at all — both are dead/dangerous choices
 * that previously saved fine and only failed at end-user login time.
 */

import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '@/test/render';
import type { RoleOption } from '../../api/types';
import { CreateProviderForm } from '../identity-provider-form';

vi.mock('sonner', () => ({
    toast: { success: vi.fn(), error: vi.fn() },
}));

const ROLES: RoleOption[] = [
    { id: 'role-doctor', name: 'DOCTOR' },
    { id: 'role-nurse', name: 'NURSE' },
    { id: 'role-global-admin', name: 'GLOBAL_ADMIN' },
    { id: 'role-service-account', name: 'SERVICE_ACCOUNT' },
];

function stubFetch(): void {
    vi.stubGlobal(
        'fetch',
        vi.fn(async (input: string | URL | Request) => {
            const url = String(input);
            if (url.includes('admin/rbac/roles')) return Response.json({ data: ROLES });
            if (url.includes('admin/departments')) return Response.json([{ id: 'dept-1', code: 'GEN', name: 'General' }]);
            throw new Error(`Unhandled fetch: ${url}`);
        }),
    );
}

// Radix Select scrolls the highlighted item into view on open; happy-dom has no layout engine.
beforeAll(() => {
    if (!Element.prototype.scrollIntoView) {
        Element.prototype.scrollIntoView = () => {};
    }
});

afterEach(() => {
    vi.unstubAllGlobals();
    cleanup();
});

describe('CreateProviderForm — default-role picker', () => {
    it('excludes GLOBAL_ADMIN and SERVICE_ACCOUNT from the default-role options', async () => {
        stubFetch();
        renderWithProviders(<CreateProviderForm onCreated={() => {}} onCancel={() => {}} />);

        const trigger = await screen.findByLabelText(/default role/i);
        fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: 'mouse' });

        await waitFor(() => expect(screen.getByRole('option', { name: 'DOCTOR' })).toBeDefined());
        const listbox = screen.getByRole('listbox');
        expect(within(listbox).getByRole('option', { name: 'NURSE' })).toBeDefined();
        expect(within(listbox).queryByRole('option', { name: 'GLOBAL_ADMIN' })).toBeNull();
        expect(within(listbox).queryByRole('option', { name: 'SERVICE_ACCOUNT' })).toBeNull();
    });
});
