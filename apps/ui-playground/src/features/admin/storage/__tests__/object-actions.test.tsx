/**
 * ObjectActions — smoke tests (TASK-328 A7)
 *
 * Pins the per-object storage action contract: a "Copy link" action that
 * fetches a presigned URL and copies it to the clipboard, and a delete action
 * that is GATED behind an @arcaai/ui AlertDialog confirmation before the
 * provider-side object delete fires.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// ── toast spy ───────────────────────────────────────────────────────
const toastSuccess = vi.fn();
const toastError = vi.fn();
vi.mock('sonner', () => ({ toast: { success: (...a: unknown[]) => toastSuccess(...a), error: (...a: unknown[]) => toastError(...a) } }));

// ── api/tenant-storage mock — control the presign + delete mutations ─
const presignMutate = vi.fn();
const deleteMutate = vi.fn();
vi.mock('../../api/tenant-storage', () => ({
  useTenantBucketPresignedUrl: () => ({ mutate: presignMutate, isPending: false }),
  useDeleteTenantBucketObject: () => ({ mutate: deleteMutate, isPending: false }),
}));

// ── @arcaai/ui primitive stubs (vitest stubs the real package to {}) ─
vi.mock('@arcaai/ui/button', () => ({
  Button: ({ children, onClick, disabled, ...rest }: any) => (
    <button onClick={onClick} disabled={disabled} aria-label={rest['aria-label']} title={rest.title}>
      {children}
    </button>
  ),
}));
vi.mock('@arcaai/ui/alert-dialog', () => ({
  AlertDialog: ({ open, children }: any) => (open ? <div role="alertdialog">{children}</div> : null),
  AlertDialogContent: ({ children }: any) => <div>{children}</div>,
  AlertDialogHeader: ({ children }: any) => <div>{children}</div>,
  AlertDialogFooter: ({ children }: any) => <div>{children}</div>,
  AlertDialogTitle: ({ children }: any) => <div>{children}</div>,
  AlertDialogDescription: ({ children }: any) => <div>{children}</div>,
}));

const { ObjectActions } = await import('../object-actions');

const baseProps = {
  tenantId: 't1',
  bucketId: 'b-1',
  bucketName: 'hope-audio-arcaai',
  objectKey: '2026/04/08/test.wav',
  compact: true,
};

beforeEach(() => {
  presignMutate.mockReset();
  deleteMutate.mockReset();
  toastSuccess.mockReset();
  toastError.mockReset();
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
  });
});

describe('ObjectActions (TASK-328 A7)', () => {
  it('renders the Copy link and Delete actions', () => {
    render(<ObjectActions {...baseProps} />);
    expect(screen.getByRole('button', { name: /copy presigned download link/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /delete file/i })).toBeTruthy();
  });

  it('copies a presigned link to the clipboard and toasts the expiry', async () => {
    presignMutate.mockImplementation((_vars: unknown, opts: any) => {
      opts?.onSuccess?.({ url: 'https://minio.local/signed?sig=abc' });
    });

    render(<ObjectActions {...baseProps} />);
    fireEvent.click(screen.getByRole('button', { name: /copy presigned download link/i }));

    expect(presignMutate).toHaveBeenCalledWith({ bucketId: 'b-1', fileKey: '2026/04/08/test.wav' }, expect.any(Object));
    await waitFor(() => {
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith('https://minio.local/signed?sig=abc');
      expect(toastSuccess).toHaveBeenCalledWith(expect.stringMatching(/1 hour/i));
    });
  });

  it('does NOT delete until the confirmation dialog is confirmed', () => {
    render(<ObjectActions {...baseProps} />);

    // Clicking the trash trigger only opens the dialog — no delete yet.
    fireEvent.click(screen.getByRole('button', { name: /delete file/i }));
    expect(deleteMutate).not.toHaveBeenCalled();
    expect(screen.getByRole('alertdialog')).toBeTruthy();

    // Confirm inside the dialog → provider-side delete fires with bucket id + key.
    fireEvent.click(screen.getByRole('button', { name: /^delete$/i }));
    expect(deleteMutate).toHaveBeenCalledTimes(1);
    expect(deleteMutate).toHaveBeenCalledWith(
      expect.objectContaining({ bucketId: 'b-1', bucketName: 'hope-audio-arcaai', fileKey: '2026/04/08/test.wav' }),
      expect.any(Object),
    );
  });
});
