/**
 * TDD tests for the Settings detail/create drawer: the type-aware
 * value editor (real code editor for Json — no modal), OCC If-Match PATCH with
 * the 412 path, the permission-gated step-up reveal + the server-side rotate
 * endpoint flow, the create flow, and the audit-log-backed History tab.
 */

import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { renderWithProviders } from '@/test/render';
import type { GlobalSetting } from '../../api/types';
import { SettingCreateDrawer, SettingDetailDrawer } from '../setting-drawer';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

/** Radix tabs activate on focus (automatic mode); focus then click mirrors a real click. */
function selectTab(name: string | RegExp) {
  const tab = screen.getByRole('tab', { name });
  fireEvent.focus(tab);
  fireEvent.click(tab);
}

function setting(overrides: Partial<GlobalSetting> = {}): GlobalSetting {
  return {
    id: 's-1',
    projectId: null,
    createdAt: '2026-06-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
    resourceStatus: 'ENABLED',
    resourceStatusUpdatedAt: null,
    resourceStatusUpdatedBy: null,
    createdBy: null,
    updatedBy: null,
    name: 'SMTP relay host',
    description: 'Outbound mail relay',
    key: 'smtp.host',
    value: 'mail.local',
    dataType: 'String',
    namespace: 'smtp',
    tenantId: null,
    locked: false,
    version: 2,
    isSecret: false,
    ...overrides,
  };
}

const MANAGE_ALL = [{ action: 'manage', subject: 'all' }];
const READ_ONLY = [{ action: 'read', subject: 'GlobalSetting' }];

interface RecordedCall {
  url: string;
  method: string;
  headers: Headers;
  body: unknown;
}

function stubFetch({
  permissions = MANAGE_ALL,
  custom,
}: {
  permissions?: { action: string; subject: string }[];
  custom?: (call: RecordedCall) => Response | undefined;
} = {}): RecordedCall[] {
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
      if (call.url === '/api/auth/session') {
        return Response.json({ user: { id: 'u-1', roles: ['SUPER_ADMIN'] }, isElevated: true, workingTenantId: null });
      }
      if (call.url === '/api/hope/users/me/permission-checks') return Response.json({ userId: 'u-1', tenantId: null, permissions });
      if (call.method === 'GET' && call.url === '/api/hope/admin/settings/s-1') {
        return Response.json(setting(), { headers: { etag: '"2"' } });
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

describe('SettingDetailDrawer', () => {
  it('renders the header key, type badge, meta and value; saves with If-Match + expectedVersion', async () => {
    const calls = stubFetch({
      custom: (call) => {
        if (call.method === 'PATCH' && call.url === '/api/hope/admin/settings/s-1') {
          return Response.json(setting({ value: 'mail2.local', version: 3 }), { headers: { etag: '"3"' } });
        }
        return undefined;
      },
    });
    const onClose = vi.fn();
    renderWithProviders(<SettingDetailDrawer settingId="s-1" onClose={onClose} onDelete={vi.fn()} />);

    // Detail loads (fresh ETag) → header + value render.
    expect(await screen.findByText('smtp.host')).toBeDefined();
    expect(screen.getByText('String')).toBeDefined();

    const valueInput = screen.getByRole('textbox', { name: 'Value' });
    fireEvent.change(valueInput, { target: { value: 'mail2.local' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(calls.some((call) => call.method === 'PATCH')).toBe(true));
    const patch = calls.find((call) => call.method === 'PATCH');
    expect(patch?.headers.get('if-match')).toBe('"2"');
    expect(patch?.body).toEqual({ value: 'mail2.local', expectedVersion: 2 });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  // TASK-932 R-8 — the advisory badge and note are gone with the five rows they
  // described. This case is kept as the regression pin that NOTHING marks a
  // `feature-flags` row advisory any more.
  it('does not mark enable-consultation-sharing as advisory — it is genuinely enforced', async () => {
    const enforced = setting({ id: 's-6', key: 'enable-consultation-sharing', namespace: 'feature-flags', name: 'Consultation Sharing' });
    stubFetch({
      custom: (call) => {
        if (call.method === 'GET' && call.url === '/api/hope/admin/settings/s-6') {
          return Response.json(enforced, { headers: { etag: '"2"' } });
        }
        return undefined;
      },
    });
    renderWithProviders(<SettingDetailDrawer settingId="s-6" onClose={vi.fn()} onDelete={vi.fn()} />);

    expect(await screen.findByText('enable-consultation-sharing')).toBeDefined();
    expect(screen.queryByText('Advisory')).toBeNull();
  });

  it('blocks Save while JSON is invalid and enables it once valid (no modal, real editor)', async () => {
    stubFetch({
      custom: (call) => {
        if (call.method === 'GET' && call.url === '/api/hope/admin/settings/s-1') {
          return Response.json(setting({ dataType: 'Json', value: '{"a":1}' }), { headers: { etag: '"2"' } });
        }
        return undefined;
      },
    });
    renderWithProviders(<SettingDetailDrawer settingId="s-1" onClose={vi.fn()} onDelete={vi.fn()} />);

    const editor = await screen.findByRole('textbox', { name: 'Value' });
    // Pristine → Save disabled.
    expect((screen.getByRole('button', { name: 'Save changes' }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(editor, { target: { value: '{ broken' } });
    expect(screen.getByText(/Invalid JSON/)).toBeDefined();
    expect((screen.getByRole('button', { name: 'Save changes' }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(editor, { target: { value: '{"a":2}' } });
    expect((screen.getByRole('button', { name: 'Save changes' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('surfaces the OCC conflict alert on 412 and keeps the drawer open', async () => {
    stubFetch({
      custom: (call) => {
        if (call.method === 'PATCH') return Response.json({ message: 'Precondition Failed' }, { status: 412 });
        return undefined;
      },
    });
    renderWithProviders(<SettingDetailDrawer settingId="s-1" onClose={vi.fn()} onDelete={vi.fn()} />);

    fireEvent.change(await screen.findByRole('textbox', { name: 'Value' }), { target: { value: 'mail2.local' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(await screen.findByText(/412 Precondition Failed/)).toBeDefined();
    expect(screen.getByRole('button', { name: 'Reload latest' })).toBeDefined();
    expect(screen.getByRole('dialog')).toBeDefined();
  });

  it('reveals a secret via step-up and replaces it on save through the write-only field', async () => {
    const calls = stubFetch({
      custom: (call) => {
        if (call.method === 'GET' && call.url === '/api/hope/admin/settings/s-2') {
          return Response.json(setting({ id: 's-2', key: 'smtp.password', value: '', isSecret: true, version: 4 }), { headers: { etag: '"4"' } });
        }
        if (call.method === 'POST' && call.url === '/api/hope/admin/settings/s-2/reveal') {
          return Response.json({ id: 's-2', key: 'smtp.password', value: 'hunter2', revealedAt: '2026-07-05T00:00:00.000Z' });
        }
        if (call.method === 'PATCH' && call.url === '/api/hope/admin/settings/s-2') {
          return Response.json(setting({ id: 's-2', isSecret: true, version: 5 }), { headers: { etag: '"5"' } });
        }
        return undefined;
      },
    });
    renderWithProviders(<SettingDetailDrawer settingId="s-2" onClose={vi.fn()} onDelete={vi.fn()} />);

    const newValue = await screen.findByLabelText(/new value/i);
    // Save is disabled until a replacement value is entered (write-only rule).
    expect((screen.getByRole('button', { name: 'Save changes' }) as HTMLButtonElement).disabled).toBe(true);

    // Step-up reveal shows the plaintext (permission-gated control resolves async).
    fireEvent.click(await screen.findByRole('button', { name: 'Reveal smtp.password' }));
    const stepUp = await screen.findByRole('dialog', { name: /reveal secret/i });
    fireEvent.change(within(stepUp).getByLabelText(/password/i), { target: { value: 'p@ss' } });
    fireEvent.click(within(stepUp).getByRole('button', { name: 'Reveal secret' }));
    expect(await screen.findByText('hunter2')).toBeDefined();

    // Entering a replacement enables Save; PATCH carries the new value only.
    fireEvent.change(newValue, { target: { value: 'newpass' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(calls.some((call) => call.method === 'PATCH')).toBe(true));
    expect(calls.find((call) => call.method === 'PATCH')?.body).toEqual({ value: 'newpass', expectedVersion: 4 });
  });

  // Rotate is a REAL server-side call (POST :id/rotate with step-up
  // + If-Match), no longer the guided-replace that focused the write-only field.
  it('rotates a secret through the rotate endpoint (step-up password + new value, If-Match)', async () => {
    const { toast } = await import('sonner');
    const calls = stubFetch({
      custom: (call) => {
        if (call.method === 'GET' && call.url === '/api/hope/admin/settings/s-2') {
          return Response.json(setting({ id: 's-2', key: 'smtp.password', value: '', isSecret: true, version: 4 }), { headers: { etag: '"4"' } });
        }
        if (call.method === 'POST' && call.url === '/api/hope/admin/settings/s-2/rotate') {
          return Response.json(setting({ id: 's-2', key: 'smtp.password', value: '', isSecret: true, version: 5 }), { headers: { etag: '"5"' } });
        }
        return undefined;
      },
    });
    renderWithProviders(<SettingDetailDrawer settingId="s-2" onClose={vi.fn()} onDelete={vi.fn()} />);

    fireEvent.click(await screen.findByRole('button', { name: /Rotate/ }));
    const dialog = await screen.findByRole('dialog', { name: /rotate secret/i });
    fireEvent.change(within(dialog).getByLabelText(/new secret value/i), { target: { value: 'rotated-pass' } });
    fireEvent.change(within(dialog).getByLabelText(/password/i), { target: { value: 'p@ss' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Rotate secret' }));

    await waitFor(() => expect(calls.some((call) => call.method === 'POST' && call.url.endsWith('/rotate'))).toBe(true));
    const rotate = calls.find((call) => call.method === 'POST' && call.url.endsWith('/rotate'));
    expect(rotate?.headers.get('if-match')).toBe('"4"');
    expect(rotate?.body).toEqual({ password: 'p@ss', newValue: 'rotated-pass', expectedVersion: 4 });
    expect(toast.success).toHaveBeenCalled();
    // Success closes the rotate dialog (the drawer itself stays open).
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /rotate secret/i })).toBeNull());
  });

  it('shows a rotate failure in-dialog (break-glass style) and keeps the dialog open', async () => {
    stubFetch({
      custom: (call) => {
        if (call.method === 'GET' && call.url === '/api/hope/admin/settings/s-2') {
          return Response.json(setting({ id: 's-2', key: 'smtp.password', value: '', isSecret: true, version: 4 }), { headers: { etag: '"4"' } });
        }
        if (call.method === 'POST' && call.url === '/api/hope/admin/settings/s-2/rotate') {
          return Response.json({ message: 'Step-up re-authentication failed: incorrect password.' }, { status: 401 });
        }
        return undefined;
      },
    });
    renderWithProviders(<SettingDetailDrawer settingId="s-2" onClose={vi.fn()} onDelete={vi.fn()} />);

    fireEvent.click(await screen.findByRole('button', { name: /Rotate/ }));
    const dialog = await screen.findByRole('dialog', { name: /rotate secret/i });
    fireEvent.change(within(dialog).getByLabelText(/new secret value/i), { target: { value: 'rotated-pass' } });
    fireEvent.change(within(dialog).getByLabelText(/password/i), { target: { value: 'wrong' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Rotate secret' }));

    const alert = await within(dialog).findByRole('alert');
    expect(alert.textContent).toContain('incorrect password');
    expect(screen.getByRole('dialog', { name: /rotate secret/i })).toBeDefined();
  });

  it('hides the reveal and rotate controls without the manage/all permission', async () => {
    stubFetch({
      permissions: READ_ONLY,
      custom: (call) => {
        if (call.method === 'GET' && call.url === '/api/hope/admin/settings/s-2') {
          return Response.json(setting({ id: 's-2', key: 'smtp.password', value: '', isSecret: true }), { headers: { etag: '"2"' } });
        }
        return undefined;
      },
    });
    renderWithProviders(<SettingDetailDrawer settingId="s-2" onClose={vi.fn()} onDelete={vi.fn()} />);

    await screen.findByLabelText(/new value/i);
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Reveal smtp.password' })).toBeNull());
    expect(screen.queryByRole('button', { name: /Rotate/ })).toBeNull();
  });

  it('lists audit-log-backed history on the History tab', async () => {
    stubFetch({
      custom: (call) => {
        if (call.method === 'GET' && call.url.startsWith('/api/hope/admin/audit-logs/resource/GlobalSetting/s-1')) {
          return Response.json({
            data: [
              {
                id: 'a-1',
                action: 'UPDATE',
                createdAt: '2026-07-01T00:00:00.000Z',
                responsibleUserId: 'u-9',
                responsibleUser: { id: 'u-9', displayName: 'Dana Admin', email: null },
                data: { version: 2 },
              },
            ],
            count: 1,
            limit: 20,
            page: 0,
          });
        }
        return undefined;
      },
    });
    renderWithProviders(<SettingDetailDrawer settingId="s-1" onClose={vi.fn()} onDelete={vi.fn()} />);

    await screen.findByRole('textbox', { name: 'Value' });
    selectTab('History');
    expect(await screen.findByText('Dana Admin')).toBeDefined();
    const historyList = screen.getByRole('list', { name: 'Change history' });
    expect(within(historyList).getByText('v2')).toBeDefined();
  });
});

describe('SettingCreateDrawer', () => {
  it('creates a setting from the drawer payload', async () => {
    const calls = stubFetch({
      custom: (call) => {
        if (call.method === 'POST' && call.url === '/api/hope/admin/settings') {
          return Response.json(setting({ id: 's-new', key: 'features.harness' }));
        }
        return undefined;
      },
    });
    const onClose = vi.fn();
    renderWithProviders(<SettingCreateDrawer onClose={onClose} />);

    fireEvent.change(await screen.findByRole('textbox', { name: 'Value' }), { target: { value: 'on' } });
    selectTab('Details');
    fireEvent.change(screen.getByRole('textbox', { name: 'Name' }), { target: { value: 'Harness rollout' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Key' }), { target: { value: 'features.harness' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create setting' }));

    await waitFor(() => expect(calls.some((call) => call.method === 'POST' && call.url === '/api/hope/admin/settings')).toBe(true));
    expect(calls.find((call) => call.method === 'POST')?.body).toEqual({
      name: 'Harness rollout',
      key: 'features.harness',
      value: 'on',
      dataType: 'String',
    });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });
});
