/**
 * TASK-950 (D-4/D-12b) — Staff ID on the user profile tab: renders the
 * loaded value, submits it trimmed, explicitly clears a previously-set value
 * with `staffId: null` (never omitting it, unlike an untouched field), and
 * surfaces a 409 `STAFF_ID_TAKEN` duplicate as both a toast and an inline
 * field error — plus an axe scan in both themes. fetch is stubbed at the
 * network boundary, matching `user-detail-screen.test.tsx`.
 */

import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { renderWithProviders } from '@/test/render';
import type { UserProfile } from '../../api/types';
import { UserProfileTab } from '../user-profile-tab';

const toastSuccess = vi.hoisted(() => vi.fn());
const toastError = vi.hoisted(() => vi.fn());

vi.mock('sonner', () => ({
  toast: { success: toastSuccess, error: toastError },
}));

function profile(overrides: Partial<UserProfile> = {}): UserProfile {
  return {
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
    staffId: 'DR-100',
    userId: 'u-1',
    ...overrides,
  };
}

interface RecordedCall {
  url: string;
  method: string;
  body: unknown;
}

function stubFetch(handler: (call: RecordedCall) => Response | undefined): RecordedCall[] {
  const calls: RecordedCall[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const call: RecordedCall = {
        url: String(input),
        method: init?.method ?? 'GET',
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      };
      calls.push(call);
      const response = handler(call);
      if (!response) throw new Error(`Unhandled fetch: ${call.method} ${call.url}`);
      return response;
    }),
  );
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  document.documentElement.classList.remove('dark');
  cleanup();
});

describe('UserProfileTab — Staff ID (TASK-950)', () => {
  it('renders the loaded staffId', async () => {
    stubFetch((call) => {
      if (call.method === 'GET' && call.url === '/api/hope/admin/users/u-1/profile') return Response.json(profile());
      return undefined;
    });
    renderWithProviders(<UserProfileTab id="u-1" />);

    expect(((await screen.findByLabelText('Staff ID')) as HTMLInputElement).value).toBe('DR-100');
  });

  it('submits staffId trimmed', async () => {
    const calls = stubFetch((call) => {
      if (call.method === 'GET' && call.url === '/api/hope/admin/users/u-1/profile') return Response.json(profile({ staffId: null }));
      if (call.method === 'PATCH' && call.url === '/api/hope/admin/users/u-1/profile') return Response.json(profile({ staffId: 'DR-200' }));
      return undefined;
    });
    renderWithProviders(<UserProfileTab id="u-1" />);

    fireEvent.change(await screen.findByLabelText('Staff ID'), { target: { value: '  DR-200  ' } });
    fireEvent.click(screen.getByRole('button', { name: /save profile/i }));

    await waitFor(() => {
      const patch = calls.find((call) => call.method === 'PATCH');
      expect(patch?.body).toEqual({ firstName: 'Mia', lastName: 'Okafor', email: 'mia@sunrise.example', phone: '+1 555 0100', staffId: 'DR-200' });
    });
  });

  it('submits staffId: null when a previously-set value is cleared', async () => {
    const calls = stubFetch((call) => {
      if (call.method === 'GET' && call.url === '/api/hope/admin/users/u-1/profile') return Response.json(profile({ staffId: 'DR-100' }));
      if (call.method === 'PATCH' && call.url === '/api/hope/admin/users/u-1/profile') return Response.json(profile({ staffId: null }));
      return undefined;
    });
    renderWithProviders(<UserProfileTab id="u-1" />);

    fireEvent.change(await screen.findByLabelText('Staff ID'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: /save profile/i }));

    await waitFor(() => {
      const patch = calls.find((call) => call.method === 'PATCH');
      expect(patch?.body).toEqual({ firstName: 'Mia', lastName: 'Okafor', email: 'mia@sunrise.example', phone: '+1 555 0100', staffId: null });
    });
  });

  it('omits staffId from the body when it was never set and is left empty', async () => {
    const calls = stubFetch((call) => {
      if (call.method === 'GET' && call.url === '/api/hope/admin/users/u-1/profile') return new Response(null, { status: 204 });
      if (call.method === 'PATCH' && call.url === '/api/hope/admin/users/u-1/profile') return Response.json(profile({ staffId: null, phone: '555' }));
      return undefined;
    });
    renderWithProviders(<UserProfileTab id="u-1" />);

    fireEvent.change(await screen.findByLabelText(/phone/i), { target: { value: '555' } });
    fireEvent.click(screen.getByRole('button', { name: /save profile/i }));

    await waitFor(() => {
      const patch = calls.find((call) => call.method === 'PATCH');
      expect(patch?.body).toEqual({ phone: '555' });
    });
  });

  it('shows a toast and marks the field invalid on a 409 STAFF_ID_TAKEN', async () => {
    stubFetch((call) => {
      if (call.method === 'GET' && call.url === '/api/hope/admin/users/u-1/profile') return Response.json(profile({ staffId: null }));
      if (call.method === 'PATCH' && call.url === '/api/hope/admin/users/u-1/profile') {
        return Response.json({ message: 'Staff ID already taken in this tenant', code: 'STAFF_ID_TAKEN' }, { status: 409 });
      }
      return undefined;
    });
    renderWithProviders(<UserProfileTab id="u-1" />);

    const input = await screen.findByLabelText('Staff ID');
    fireEvent.change(input, { target: { value: 'DR-999' } });
    fireEvent.click(screen.getByRole('button', { name: /save profile/i }));

    await waitFor(() => expect(toastError).toHaveBeenCalledWith('That Staff ID is already used by another user in this tenant'));
    expect(await screen.findByText('That Staff ID is already used by another user in this tenant')).toBeDefined();
    expect(input.getAttribute('aria-invalid')).toBe('true');
  });

  it('clears the inline error once the admin edits the field again', async () => {
    stubFetch((call) => {
      if (call.method === 'GET' && call.url === '/api/hope/admin/users/u-1/profile') return Response.json(profile({ staffId: null }));
      if (call.method === 'PATCH' && call.url === '/api/hope/admin/users/u-1/profile') {
        return Response.json({ message: 'taken', code: 'STAFF_ID_TAKEN' }, { status: 409 });
      }
      return undefined;
    });
    renderWithProviders(<UserProfileTab id="u-1" />);

    const input = await screen.findByLabelText('Staff ID');
    fireEvent.change(input, { target: { value: 'DR-999' } });
    fireEvent.click(screen.getByRole('button', { name: /save profile/i }));
    await screen.findByText('That Staff ID is already used by another user in this tenant');

    fireEvent.change(input, { target: { value: 'DR-999-b' } });
    expect(screen.queryByText('That Staff ID is already used by another user in this tenant')).toBeNull();
  });

  it('has no axe violations on the profile form with the Staff ID field, in both themes', async () => {
    stubFetch((call) => {
      if (call.method === 'GET' && call.url === '/api/hope/admin/users/u-1/profile') return Response.json(profile());
      return undefined;
    });
    const light = renderWithProviders(<UserProfileTab id="u-1" />);
    await screen.findByLabelText('Staff ID');
    expect(await axe(light.container)).toHaveNoViolations();
    cleanup();

    document.documentElement.classList.add('dark');
    stubFetch((call) => {
      if (call.method === 'GET' && call.url === '/api/hope/admin/users/u-1/profile') return Response.json(profile());
      return undefined;
    });
    const dark = renderWithProviders(<UserProfileTab id="u-1" />);
    await screen.findByLabelText('Staff ID');
    expect(await axe(dark.container)).toHaveNoViolations();
  });
});
