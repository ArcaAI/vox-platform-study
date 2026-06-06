/**
 * AccessKeysPanel — smoke tests (TASK-328 A7)
 *
 * Pins the tenant storage access-key contract: the list never renders a
 * plaintext secret (secrets are masked server-side), a freshly created key
 * reveals its one-time secret exactly once, and revoking a key is GATED behind
 * an @arcaai/ui AlertDialog confirmation.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

// ── toast spy ───────────────────────────────────────────────────────
const toastSuccess = vi.fn();
const toastError = vi.fn();
vi.mock('sonner', () => ({ toast: { success: (...a: unknown[]) => toastSuccess(...a), error: (...a: unknown[]) => toastError(...a) } }));

// ── api/storage-keys mock ───────────────────────────────────────────
let keysData: any[] = [];
let keysLoading = false;
const createMutate = vi.fn();
const revokeMutate = vi.fn();
vi.mock('../../api/storage-keys', () => ({
    useStorageAccessKeys: () => ({ data: keysData, isLoading: keysLoading }),
    useCreateStorageAccessKey: () => ({ mutate: createMutate, isPending: false }),
    useRevokeStorageAccessKey: () => ({ mutate: revokeMutate, isPending: false }),
}));

// ── @arcaai/ui primitive stubs ──────────────────────────────────────
vi.mock('@arcaai/ui/button', () => ({
    Button: ({ children, onClick, disabled, ...rest }: any) => (
        <button onClick={onClick} disabled={disabled} aria-label={rest['aria-label']} title={rest.title}>
            {children}
        </button>
    ),
}));
vi.mock('@arcaai/ui/input', () => ({ Input: (props: any) => <input {...props} /> }));
vi.mock('@arcaai/ui/label', () => ({ Label: ({ children, ...rest }: any) => <label {...rest}>{children}</label> }));
vi.mock('@arcaai/ui/badge', () => ({ Badge: ({ children }: any) => <span>{children}</span> }));
vi.mock('@arcaai/ui/skeleton', () => ({ Skeleton: (props: any) => <div data-testid="skeleton" {...props} /> }));
vi.mock('@arcaai/ui/alert-dialog', () => ({
    AlertDialog: ({ open, children }: any) => (open ? <div role="alertdialog">{children}</div> : null),
    AlertDialogContent: ({ children }: any) => <div>{children}</div>,
    AlertDialogHeader: ({ children }: any) => <div>{children}</div>,
    AlertDialogFooter: ({ children }: any) => <div>{children}</div>,
    AlertDialogTitle: ({ children }: any) => <div>{children}</div>,
    AlertDialogDescription: ({ children }: any) => <div>{children}</div>,
}));

const { AccessKeysPanel } = await import('../access-keys-panel');

const existingKey = {
    id: 'key-1',
    tenantId: 't1',
    name: 'backup-worker',
    accessKeyId: 'AKIAPUBLICID1234',
    permissions: [] as string[],
    bucketIds: [] as string[],
    createdAt: '2026-01-01T00:00:00.000Z',
};

beforeEach(() => {
    keysData = [];
    keysLoading = false;
    createMutate.mockReset();
    revokeMutate.mockReset();
    toastSuccess.mockReset();
    toastError.mockReset();
});

describe('AccessKeysPanel (TASK-328 A7)', () => {
    it('lists keys without ever rendering a plaintext secret', () => {
        keysData = [existingKey];
        render(<AccessKeysPanel tenantId="t1" />);

        expect(screen.getByText('backup-worker')).toBeTruthy();
        // The one-time secret box is the ONLY place a secret can render — absent here.
        expect(screen.queryByTestId('secret-value')).toBeNull();
        expect(screen.queryByTestId('created-secret')).toBeNull();
    });

    it('shows an empty state when there are no keys', () => {
        keysData = [];
        render(<AccessKeysPanel tenantId="t1" />);
        expect(screen.getByText(/no access keys yet/i)).toBeTruthy();
    });

    // IC-06 (TASK-336) — the list row showed the (non-secret) accessKeyId masked
    // and mislabeled "secret". The real secret is write-only (one-time box only),
    // so the row must label the identifier as the Access Key ID, never "secret".
    it('labels the list row "Access Key ID" and never mislabels it as a secret (IC-06)', () => {
        keysData = [existingKey];
        const { container } = render(<AccessKeysPanel tenantId="t1" />);

        expect(screen.getByText('AKIAPUBLICID1234')).toBeTruthy();
        expect(container.textContent).toMatch(/access key id/i);
        expect(container.textContent).not.toMatch(/secret/i);
    });

    it('reveals the one-time secret after creating a key', () => {
        createMutate.mockImplementation((_vars: unknown, opts: any) => {
            opts?.onSuccess?.({ ...existingKey, id: 'key-2', accessKeyId: 'AKIANEWID5678', secretAccessKey: 'super-secret-shhh' });
        });
        render(<AccessKeysPanel tenantId="t1" />);

        fireEvent.change(screen.getByLabelText(/new access key/i), { target: { value: 'ci-runner' } });
        fireEvent.click(screen.getByRole('button', { name: /generate key/i }));

        expect(createMutate).toHaveBeenCalledWith({ name: 'ci-runner' }, expect.any(Object));
        expect(screen.getByTestId('secret-value').textContent).toBe('super-secret-shhh');
        expect(toastSuccess).toHaveBeenCalledWith(expect.stringMatching(/once/i));
    });

    it('gates revoke behind the confirmation dialog', () => {
        keysData = [existingKey];
        render(<AccessKeysPanel tenantId="t1" />);

        fireEvent.click(screen.getByRole('button', { name: /revoke backup-worker/i }));
        expect(revokeMutate).not.toHaveBeenCalled();
        expect(screen.getByRole('alertdialog')).toBeTruthy();

        fireEvent.click(screen.getByRole('button', { name: /^revoke$/i }));
        expect(revokeMutate).toHaveBeenCalledWith('key-1', expect.any(Object));
    });
});
