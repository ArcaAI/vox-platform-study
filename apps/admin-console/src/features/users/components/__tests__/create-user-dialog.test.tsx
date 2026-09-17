/**
 * TASK-983 R6 / OD-4 — the create-user dialog must collect the membership the
 * gateway now requires.
 *
 * `User` carries no `tenantId`: a user with no role assignment (and, for a
 * human, no department) belongs to no tenant — it cannot sign in and the admin
 * who created it cannot even reopen it (404 through `assertUserInScope`). The
 * service refuses such a create with `USER_ROLE_REQUIRED` /
 * `USER_DEPARTMENT_REQUIRED`; this form must not let an admin reach that 400,
 * and must send both ids when it does submit.
 *
 * Pinned here: submit blocked until both are chosen, the request body carries
 * them, the service-account switch drops the department requirement, and
 * SUPER_ADMIN is never offered (mirrors the identity-provider default-role
 * picker).
 */

import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '@/test/render';
import { CreateUserDialog } from '../create-user-dialog';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));

const ROLES = [
  { id: 'role-doctor', name: 'DOCTOR' },
  { id: 'role-nurse', name: 'NURSE' },
  { id: 'role-service', name: 'SERVICE_ACCOUNT' },
  { id: 'role-super', name: 'SUPER_ADMIN' },
];

const DEPARTMENTS = [
  { id: 'dept-gen', code: 'GEN', name: 'General Medicine' },
  { id: 'dept-ent', code: 'ENT', name: 'ENT' },
];

/** Returns the bodies POSTed to `admin/users`. */
function stubFetch(): { creates: Record<string, unknown>[] } {
  const creates: Record<string, unknown>[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('admin/rbac/roles')) return Response.json({ data: ROLES });
      if (url.includes('admin/departments')) return Response.json(DEPARTMENTS);
      if (url.includes('admin/users')) {
        creates.push(JSON.parse(String(init?.body ?? '{}')));
        return Response.json({ id: 'user-new', username: 'task983' }, { status: 201 });
      }
      throw new Error(`Unhandled fetch: ${url}`);
    }),
  );
  return { creates };
}

async function pick(labelPattern: RegExp, optionName: string) {
  const trigger = await screen.findByLabelText(labelPattern);
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: 'mouse' });
  const option = await screen.findByRole('option', { name: optionName });
  fireEvent.click(option);
}

function fillIdentity() {
  fireEvent.change(screen.getByLabelText(/username/i), { target: { value: 'task983' } });
  fireEvent.change(screen.getByLabelText(/password/i), { target: { value: 'Password123!' } });
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

describe('CreateUserDialog — mandatory tenant membership', () => {
  it('keeps submit disabled until a role AND a department are chosen', async () => {
    stubFetch();
    renderWithProviders(<CreateUserDialog open onOpenChange={() => {}} />);

    fillIdentity();
    const submit = screen.getByRole('button', { name: /create user/i });
    expect((submit as HTMLButtonElement).disabled).toBe(true);

    await pick(/role/i, 'DOCTOR');
    expect((screen.getByRole('button', { name: /create user/i }) as HTMLButtonElement).disabled).toBe(true);

    await pick(/department/i, 'General Medicine (GEN)');
    await waitFor(() => expect((screen.getByRole('button', { name: /create user/i }) as HTMLButtonElement).disabled).toBe(false));
  });

  it('sends roleId and departmentId in the create request', async () => {
    const { creates } = stubFetch();
    renderWithProviders(<CreateUserDialog open onOpenChange={() => {}} />);

    fillIdentity();
    await pick(/role/i, 'NURSE');
    await pick(/department/i, 'ENT (ENT)');
    fireEvent.click(screen.getByRole('button', { name: /create user/i }));

    await waitFor(() => expect(creates.length).toBe(1));
    expect(creates[0]).toMatchObject({ username: 'task983', roleId: 'role-nurse', departmentId: 'dept-ent' });
  });

  it('drops the department requirement for a service account', async () => {
    const { creates } = stubFetch();
    renderWithProviders(<CreateUserDialog open onOpenChange={() => {}} />);

    fillIdentity();
    await pick(/role/i, 'SERVICE_ACCOUNT');
    fireEvent.click(screen.getByLabelText(/service account/i));

    await waitFor(() => expect((screen.getByRole('button', { name: /create user/i }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: /create user/i }));

    await waitFor(() => expect(creates.length).toBe(1));
    expect(creates[0]).toMatchObject({ isServiceAccount: true, roleId: 'role-service' });
    expect(creates[0].departmentId).toBeUndefined();
  });

  it('never offers the SUPER_ADMIN role', async () => {
    stubFetch();
    renderWithProviders(<CreateUserDialog open onOpenChange={() => {}} />);

    const trigger = await screen.findByLabelText(/role/i);
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: 'mouse' });

    await waitFor(() => expect(screen.getByRole('option', { name: 'DOCTOR' })).toBeDefined());
    const listbox = screen.getByRole('listbox');
    expect(within(listbox).queryByRole('option', { name: 'SUPER_ADMIN' })).toBeNull();
  });
});
