/**
 * Frame 30 — Departments screen. fetch is stubbed at the network boundary
 * (session + gateway proxy); assertions cover the hierarchy/members render,
 * the member lead chip, the lazy children expansion, the NoTenant gate, the
 * If-Match edit save in the DetailDrawer, the prompt-config Select PATCH, the
 * type-to-confirm delete, and the empty/error states.
 */

import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '@/test/render';
import type { Department, DepartmentMember } from '../../api/types';
import { DepartmentsScreen } from '../departments-screen';
import { installFetchStub, type FetchHandler, type RecordedCall } from './fetch-stub';

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

// Viewport tier drives the desktop three-pane grid vs the compact collapse;
// pin it to desktop so these tests exercise the primary layout deterministically.
let currentTier: 'desktop' | 'tablet' | 'mobile' = 'desktop';
vi.mock('@/shared/layout/use-viewport-tier', () => ({
  useViewportTier: () => currentTier,
  TABLET_MIN_PX: 768,
  DESKTOP_MIN_PX: 1280,
}));

function department(overrides: Partial<Department> = {}): Department {
  return {
    id: 'dep-cardio',
    code: 'CARD',
    name: 'Cardiology',
    description: 'Cardiology department',
    isRootDepartment: true,
    createdAt: '2025-04-01T10:00:00.000Z',
    updatedAt: '2025-06-20T10:00:00.000Z',
    resourceStatus: 'ENABLED',
    version: 7,
    ...overrides,
  };
}

const CARDIOLOGY = department();
const RADIOLOGY = department({ id: 'dep-radio', code: 'RAD', name: 'Radiology', version: 2 });
const INTERVENTIONAL = department({
  id: 'dep-interv',
  code: 'CARD-INT',
  name: 'Interventional',
  isRootDepartment: false,
  parentDepartmentId: 'dep-cardio',
  version: 1,
});

const DEPARTMENTS: Department[] = [CARDIOLOGY, RADIOLOGY, INTERVENTIONAL];
const ROOTS: Department[] = [CARDIOLOGY, RADIOLOGY];

/** Select catalog for the prompt-config pane (GET /admin/prompt-templates). */
const PROMPT_TEMPLATES = [{ id: 'pt-1', name: 'Cardiology Notes', category: 'SUMMARY', status: 'PUBLISHED' }];

function member(overrides: Partial<DepartmentMember> = {}): DepartmentMember {
  return {
    id: 'u-1',
    projectId: null,
    username: 'elena.vasquez',
    isServiceAccount: false,
    resourceStatus: 'ENABLED',
    resourceStatusUpdatedAt: null,
    resourceStatusUpdatedBy: null,
    createdBy: null,
    updatedBy: null,
    createdAt: '2023-05-10T08:00:00.000Z',
    updatedAt: '2026-06-01T08:00:00.000Z',
    UserRoleAssignments: [
      {
        id: 'ura-1',
        projectId: null,
        userId: 'u-1',
        roleId: 'role-1',
        roleName: 'Cardiologist',
        tenantId: 'tnt-1',
        resourceStatus: 'ENABLED',
        resourceStatusUpdatedAt: null,
        resourceStatusUpdatedBy: null,
        createdBy: null,
        updatedBy: null,
        createdAt: '2023-05-10T08:00:00.000Z',
        updatedAt: '2023-05-10T08:00:00.000Z',
      },
    ],
    ...overrides,
  };
}

const MEMBERS: DepartmentMember[] = [member({ isLead: true }), member({ id: 'u-2', username: 'marcus.chen', UserRoleAssignments: [] })];

function session(overrides: Partial<{ isElevated: boolean; workingTenantId: string | null }> = {}) {
  const base = {
    user: { id: 'u-admin', username: 'root', email: 'root@hope.local', roles: ['SUPER_ADMIN'] },
    isElevated: true,
    workingTenantId: 'tnt-1',
    workingTenantName: 'Sunrise Medical Group',
    impersonatingUserId: null,
    impersonatingUsername: null,
    ...overrides,
  };
  // WorkingTenantGate now reads the effective identity; mirror the
  // (possibly overridden) operator fields since these fixtures never impersonate.
  return {
    ...base,
    effectiveUser: { ...base.user, tenantId: null, departmentId: null },
    effectiveIsElevated: base.isElevated,
    effectiveTenantId: base.workingTenantId,
  };
}

/** Read paths through the proxy that every test starts from. */
function defaultHandler(call: RecordedCall): Response | undefined {
  if (call.method !== 'GET') return undefined;
  const path = new URL(call.url, 'http://test.local').pathname;
  if (path === '/api/auth/session') return Response.json(session());
  if (path === '/api/hope/admin/departments') return Response.json(DEPARTMENTS);
  if (path === '/api/hope/admin/departments/roots') return Response.json(ROOTS);
  if (path === '/api/hope/admin/departments/dep-cardio/children') return Response.json([INTERVENTIONAL]);
  if (path === '/api/hope/admin/departments/dep-cardio/users') {
    return Response.json({ data: MEMBERS, count: 2, limit: 25, page: 0 });
  }
  if (path === '/api/hope/admin/departments/dep-cardio') {
    return Response.json(CARDIOLOGY, { headers: { etag: '"7"' } });
  }
  if (path === '/api/hope/admin/prompt-templates') {
    return Response.json({ data: PROMPT_TEMPLATES, count: 1, limit: 100, page: 1 });
  }
  return undefined;
}

function stubDepartments(custom: FetchHandler = () => undefined): RecordedCall[] {
  return installFetchStub((call) => custom(call) ?? defaultHandler(call));
}

function pathOf(call: RecordedCall): string {
  return new URL(call.url, 'http://test.local').pathname;
}

/** Opens the create/edit DetailDrawer for the selected department (the Edit affordance). */
async function openEditDrawer() {
  fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
  return screen.findByRole('dialog');
}

afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
  currentTier = 'desktop';
});

describe('DepartmentsScreen', () => {
  it('asks an elevated session without a working tenant to pick one (no gateway queries fired)', async () => {
    const calls = stubDepartments((call) => {
      if (pathOf(call) === '/api/auth/session') return Response.json(session({ workingTenantId: null }));
      return undefined;
    });
    renderWithProviders(<DepartmentsScreen />);

    expect(await screen.findByText('Select a working tenant')).toBeDefined();
    expect(calls.every((call) => !call.url.includes('/api/hope/'))).toBe(true);
  });

  it('renders the hierarchy roots and the selected department members from stubbed data', async () => {
    stubDepartments();
    renderWithProviders(<DepartmentsScreen />);

    expect(await screen.findByRole('heading', { level: 1, name: 'Departments' })).toBeDefined();
    expect(await screen.findByText(/3 departments/)).toBeDefined();

    const tree = await screen.findByRole('list', { name: 'Department hierarchy' });
    expect(within(tree).getByText('Cardiology')).toBeDefined();
    expect(within(tree).getByText('Radiology')).toBeDefined();

    // Cardiology (first root) is selected by default -> members grid.
    const grid = await screen.findByRole('grid', { name: 'Members of Cardiology' });
    expect(await within(grid).findByText('elena.vasquez')).toBeDefined();
    expect(within(grid).getByText('marcus.chen')).toBeDefined();
    expect(within(grid).getByText('Cardiologist')).toBeDefined();
    // The department lead is chipped next to the username.
    expect(within(grid).getByText('Lead')).toBeDefined();
  });

  it('expands a root lazily through GET :id/children', async () => {
    const calls = stubDepartments();
    renderWithProviders(<DepartmentsScreen />);

    const tree = await screen.findByRole('list', { name: 'Department hierarchy' });
    expect(calls.some((call) => pathOf(call) === '/api/hope/admin/departments/dep-cardio/children')).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: 'Expand Cardiology' }));

    expect(await within(tree).findByText('Interventional')).toBeDefined();
    expect(calls.some((call) => pathOf(call) === '/api/hope/admin/departments/dep-cardio/children')).toBe(true);
    // The sibling stays collapsed — one children read per expanded node.
    expect(calls.some((call) => pathOf(call) === '/api/hope/admin/departments/dep-radio/children')).toBe(false);
  });

  it('saves the edit form with If-Match and the body expectedVersion (OCC contract)', async () => {
    const calls = stubDepartments((call) => {
      if (call.method === 'PATCH' && pathOf(call) === '/api/hope/admin/departments/dep-cardio') {
        return Response.json({ ...CARDIOLOGY, name: 'Cardiology & Vascular', version: 8 }, { headers: { etag: '"8"' } });
      }
      return undefined;
    });
    renderWithProviders(<DepartmentsScreen />);

    await openEditDrawer();
    const nameInput = await screen.findByRole('textbox', { name: 'Name' });
    const saveButton = screen.getByRole('button', { name: 'Save changes' }) as HTMLButtonElement;
    expect(saveButton.disabled).toBe(true);

    fireEvent.change(nameInput, { target: { value: 'Cardiology & Vascular' } });
    expect(saveButton.disabled).toBe(false);
    fireEvent.click(saveButton);

    await waitFor(() => {
      const patch = calls.find((call) => call.method === 'PATCH' && pathOf(call) === '/api/hope/admin/departments/dep-cardio');
      expect(patch).toBeDefined();
      expect(patch?.headers.get('if-match')).toBe('"7"');
      expect(patch?.body).toEqual({ name: 'Cardiology & Vascular', expectedVersion: 7 });
    });
  });

  it('saves the prompt config through its own OCC PATCH route via the Select', async () => {
    const calls = stubDepartments((call) => {
      if (call.method === 'PATCH' && pathOf(call) === '/api/hope/admin/departments/dep-cardio/prompt-config') {
        return Response.json({ ...CARDIOLOGY, preSummaryPromptId: 'pt-1', version: 8 }, { headers: { etag: '"8"' } });
      }
      return undefined;
    });
    renderWithProviders(<DepartmentsScreen />);

    // Radix Select renders a hidden native <select> (inside the form) carrying
    // an <option> per item — drive it once the template catalog has loaded.
    const preSummarySelect = await waitFor(() => {
      const el = document.querySelector('select[name="preSummaryPromptId"]') as HTMLSelectElement | null;
      if (!el || !el.querySelector('option[value="pt-1"]')) throw new Error('prompt-template options not loaded yet');
      return el;
    });
    fireEvent.change(preSummarySelect, { target: { value: 'pt-1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save prompt config' }));

    await waitFor(() => {
      const patch = calls.find((call) => call.method === 'PATCH' && pathOf(call) === '/api/hope/admin/departments/dep-cardio/prompt-config');
      expect(patch).toBeDefined();
      expect(patch?.headers.get('if-match')).toBe('"7"');
      expect(patch?.body).toEqual({ preSummaryPromptId: 'pt-1', expectedVersion: 7 });
    });
  });

  it('surfaces a 412 drift through the OCC conflict alert instead of a toast', async () => {
    stubDepartments((call) => {
      if (call.method === 'PATCH' && pathOf(call) === '/api/hope/admin/departments/dep-cardio') {
        return Response.json({ statusCode: 412, message: 'Version drift', error: 'Precondition Failed' }, { status: 412 });
      }
      return undefined;
    });
    renderWithProviders(<DepartmentsScreen />);

    await openEditDrawer();
    fireEvent.change(await screen.findByRole('textbox', { name: 'Name' }), { target: { value: 'Renamed' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(await screen.findByText(/412 Precondition Failed/)).toBeDefined();
    expect(screen.getByRole('button', { name: 'Reload latest' })).toBeDefined();
  });

  it('deletes the selected department only after typing its code to confirm', async () => {
    const calls = stubDepartments((call) => {
      if (call.method === 'DELETE' && pathOf(call) === '/api/hope/admin/departments/dep-cardio') return Response.json(CARDIOLOGY);
      return undefined;
    });
    renderWithProviders(<DepartmentsScreen />);

    const drawer = await openEditDrawer();
    fireEvent.click(within(drawer).getByRole('button', { name: 'Delete' }));

    const dialog = await screen.findByRole('alertdialog');
    const confirm = within(dialog).getByRole('button', { name: 'Delete department' }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);

    fireEvent.change(within(dialog).getByLabelText(/to confirm/i), { target: { value: 'CARD' } });
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);

    await waitFor(() =>
      expect(calls.some((call) => call.method === 'DELETE' && pathOf(call) === '/api/hope/admin/departments/dep-cardio')).toBe(true),
    );
  });

  it('offers delete directly from a hierarchy row, without hunting through the prompt-config pane', async () => {
    const calls = stubDepartments((call) => {
      if (call.method === 'DELETE' && pathOf(call) === '/api/hope/admin/departments/dep-radio') return Response.json(RADIOLOGY);
      if (call.method === 'GET' && pathOf(call) === '/api/hope/admin/departments/dep-radio') {
        return Response.json(RADIOLOGY, { headers: { etag: '"2"' } });
      }
      if (call.method === 'GET' && pathOf(call) === '/api/hope/admin/departments/dep-radio/users') {
        return Response.json({ data: [], count: 0, limit: 25, page: 0 });
      }
      return undefined;
    });
    renderWithProviders(<DepartmentsScreen />);

    // The row's own action menu is the discoverable path: a user looking to
    // delete a department must not have to know that the only Delete lives
    // behind the "Edit" button of the Prompt config pane.
    // Radix opens the menu on pointerdown, not click (matches openRowMenu in
    // the api-keys suite).
    fireEvent.pointerDown(await screen.findByRole('button', { name: 'Open actions for Radiology' }), {
      button: 0,
      ctrlKey: false,
      pointerType: 'mouse',
    });
    fireEvent.click(await screen.findByRole('menuitem', { name: /Delete/ }));

    const dialog = await screen.findByRole('alertdialog');
    const confirm = within(dialog).getByRole('button', { name: 'Delete department' }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);

    fireEvent.change(within(dialog).getByLabelText(/to confirm/i), { target: { value: 'RAD' } });
    fireEvent.click(confirm);

    await waitFor(() =>
      expect(calls.some((call) => call.method === 'DELETE' && pathOf(call) === '/api/hope/admin/departments/dep-radio')).toBe(true),
    );
  });

  it('shows the neutral empty state with the create CTA when no departments exist', async () => {
    stubDepartments((call) => {
      const path = pathOf(call);
      if (path === '/api/hope/admin/departments' || path === '/api/hope/admin/departments/roots') return Response.json([]);
      return undefined;
    });
    renderWithProviders(<DepartmentsScreen />);

    expect(await screen.findByText('No departments yet')).toBeDefined();
    expect(screen.getAllByRole('button', { name: 'New department' }).length).toBeGreaterThanOrEqual(2);
  });

  it('collapses the tree into a toggleable drawer on compact tiers while members stay reachable', async () => {
    currentTier = 'mobile';
    stubDepartments();
    renderWithProviders(<DepartmentsScreen />);

    // Members for the auto-selected department stack in the body...
    expect(await screen.findByRole('grid', { name: 'Members of Cardiology' })).toBeDefined();
    // ...and the tree is behind the "Departments" toggle (not inline).
    expect(screen.queryByRole('list', { name: 'Department hierarchy' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Departments' }));
    const drawer = await screen.findByRole('dialog');
    expect(within(drawer).getByRole('list', { name: 'Department hierarchy' })).toBeDefined();
  });

  it('renders the block error state and retries the departments list', async () => {
    const calls = stubDepartments((call) => {
      if (pathOf(call) === '/api/hope/admin/departments') {
        return Response.json({ statusCode: 503, message: 'Service unavailable' }, { status: 503 });
      }
      return undefined;
    });
    renderWithProviders(<DepartmentsScreen />);

    expect(await screen.findByRole('alert')).toBeDefined();
    expect(screen.getByText(/service unavailable/i)).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    await waitFor(() => expect(calls.filter((call) => pathOf(call) === '/api/hope/admin/departments').length).toBe(2));
  });
});
