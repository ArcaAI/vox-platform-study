import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '@/test/render';
import type { TenantCheckpoint, TenantCheckpointRestore } from '../../api/types';
import { RestoreDialog } from '../restore-dialog';

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

const CHECKPOINT: TenantCheckpoint = {
  id: 'cp-1',
  tenantId: 't-1',
  label: 'Before upgrade',
  kind: 'MANUAL',
  origin: 'CREATED',
  status: 'READY',
  includesMedia: true,
  passphraseProtected: false,
  sizeBytes: 1024,
  progress: null,
  createdAt: '2026-10-01T00:00:00.000Z',
  createdBy: null,
  expiresAt: null,
  heartbeatAt: null,
  failureReason: null,
  failureDetail: null,
  version: 1,
};

const RESTORE: TenantCheckpointRestore = {
  id: 'r-1',
  checkpointId: 'cp-1',
  categories: ['CONFIG_CONTENT'],
  reason: 'rolling back the failed upgrade',
  status: 'PENDING',
  safetyCheckpointId: null,
  counts: null,
  warnings: [],
  requestedBy: 'u-1',
  createdAt: '2026-10-01T00:00:00.000Z',
  lockAcquiredAt: null,
  lockReleasedAt: null,
  failureReason: null,
  failureDetail: null,
  version: 1,
};

interface Call {
  url: string;
  body: unknown;
}

function stubRestore(respond: () => Response): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined });
      return respond();
    }),
  );
  return calls;
}

function renderDialog(isSuperAdmin: boolean, onRestored = vi.fn(), onLocked = vi.fn()) {
  renderWithProviders(
    <RestoreDialog
      open
      onOpenChange={vi.fn()}
      tenantId="t-1"
      tenantName="Acme Clinic"
      checkpoint={CHECKPOINT}
      isSuperAdmin={isSuperAdmin}
      onRestored={onRestored}
      onLocked={onLocked}
    />,
  );
  return { onRestored, onLocked };
}

function fill({ category = true, reason = 'rolling back the failed upgrade', password = 'pw', name = 'Acme Clinic' } = {}) {
  if (category) fireEvent.click(screen.getByRole('checkbox', { name: /Configuration and content/ }));
  fireEvent.change(screen.getByLabelText(/Reason/), { target: { value: reason } });
  fireEvent.change(screen.getByLabelText('Your password'), { target: { value: password } });
  fireEvent.change(screen.getByLabelText(/to confirm/), { target: { value: name } });
}

const submit = () => screen.getByRole('button', { name: 'Restore checkpoint' }) as HTMLButtonElement;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('RestoreDialog', () => {
  it('hides the Clinical data category from a tenant admin and shows it, with a warning, to a super admin', () => {
    renderDialog(false);
    expect(screen.queryByRole('checkbox', { name: /Clinical data/ })).toBeNull();
    cleanup();
    renderDialog(true);
    expect(screen.getByRole('checkbox', { name: /Clinical data/ })).toBeDefined();
    expect(screen.getByText(/overwrites live clinical records/i)).toBeDefined();
  });

  it('keeps submit disabled until a category, a 10+ char reason, a password and the typed tenant name are all present', () => {
    renderDialog(false);
    expect(submit().disabled).toBe(true);
    fill({ category: false });
    expect(submit().disabled).toBe(true);
    fireEvent.click(screen.getByRole('checkbox', { name: /Configuration and content/ }));
    expect(submit().disabled).toBe(false);
    fireEvent.change(screen.getByLabelText(/Reason/), { target: { value: 'too short' } });
    expect(submit().disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/Reason/), { target: { value: 'long enough reason' } });
    fireEvent.change(screen.getByLabelText(/to confirm/), { target: { value: 'acme clinic' } });
    expect(submit().disabled).toBe(true);
  });

  it.each([
    [401, 'Password is incorrect'],
    [400, 'Tenant name does not match'],
    [403, 'Not allowed to restore clinical data'],
    [409, 'Checkpoint is not READY'],
  ])('renders a %s rejection inside the dialog, not as a toast', async (status, message) => {
    stubRestore(() => Response.json({ statusCode: status, message }, { status }));
    renderDialog(false);
    fill();
    fireEvent.click(submit());
    expect((await screen.findByRole('alert')).textContent).toContain(message);
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('posts the break-glass body, then toasts and hands the restore to the history tab', async () => {
    const calls = stubRestore(() => Response.json(RESTORE, { status: 202 }));
    const { onRestored } = renderDialog(false);
    fill();
    fireEvent.click(submit());
    await waitFor(() => expect(onRestored).toHaveBeenCalledWith(expect.objectContaining({ id: 'r-1' })));
    expect(calls[0]).toEqual({
      url: '/api/hope/admin/tenants/t-1/checkpoints/cp-1/restore',
      body: { categories: ['CONFIG_CONTENT'], reason: 'rolling back the failed upgrade', password: 'pw', confirmationName: 'Acme Clinic' },
    });
    expect(toast.success).toHaveBeenCalledTimes(1);
  });

  it('reports a 423 to the screen so it can show the read-only banner', async () => {
    stubRestore(() => Response.json({ statusCode: 423, code: 'TENANT_RESTORE_IN_PROGRESS', message: 'Locked' }, { status: 423 }));
    const { onLocked } = renderDialog(false);
    fill();
    fireEvent.click(submit());
    await waitFor(() => expect(onLocked).toHaveBeenCalled());
  });
});
