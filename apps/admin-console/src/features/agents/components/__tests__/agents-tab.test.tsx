/**
 * Agents tab (TASK-547) — department-grouped `DepartmentAgent` catalog over
 * `admin/department-agents`. Rendered standalone (no `WorkingTenantGate`
 * wrapper — that's applied one level up by `AgentsScreen`).
 */

import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { renderWithProviders } from '@/test/render';
import type { Department, DepartmentAgent, PromptTemplate } from '../../api/types';
import { AgentsTab } from '../agents-tab';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

function agent(overrides: Partial<DepartmentAgent> = {}): DepartmentAgent {
  return {
    id: 'da-1',
    departmentId: 'd-1',
    name: 'Cardiology SOAP',
    slug: 'cardiology-soap',
    promptTemplateId: 'pt-1',
    pinnedVersionNumber: null,
    dnaStylePolicy: 'INHERIT',
    isDefault: true,
    templateLocked: false,
    resourceStatus: 'ENABLED',
    createdAt: '2026-06-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
    version: 2,
    ...overrides,
  };
}

const DEPARTMENTS: Department[] = [
  {
    id: 'd-1',
    code: 'CARD',
    name: 'Cardiology',
    isRootDepartment: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    version: 3,
  },
  {
    id: 'd-2',
    code: 'RADIO',
    name: 'Radiology',
    isRootDepartment: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    version: 5,
  },
];

function template(overrides: Partial<PromptTemplate> = {}): PromptTemplate {
  return {
    id: 'pt-1',
    name: 'Cardiology Notes',
    content: 'You are a clinical scribe.',
    category: 'SUMMARY',
    status: 'APPROVED',
    currentVersionNumber: 5,
    departmentId: 'd-1',
    createdAt: '2026-05-01T10:00:00.000Z',
    updatedAt: '2026-07-02T10:00:00.000Z',
    version: 5,
    ...overrides,
  };
}

interface RecordedCall {
  url: string;
  method: string;
  body: unknown;
  headers: Record<string, string>;
}

type FetchHandler = (call: RecordedCall) => Response | undefined;

function stubFetch(handler: FetchHandler): RecordedCall[] {
  const calls: RecordedCall[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const call: RecordedCall = {
        url: String(input),
        method: init?.method ?? 'GET',
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
        headers: Object.fromEntries(new Headers(init?.headers).entries()),
      };
      calls.push(call);
      const response = handler(call);
      if (!response) throw new Error(`Unhandled fetch: ${call.method} ${call.url}`);
      return response;
    }),
  );
  return calls;
}

const pathOf = (call: RecordedCall) => new URL(call.url, 'http://test.local').pathname;

function defaultHandler(agents: DepartmentAgent[], call: RecordedCall): Response | undefined {
  const path = pathOf(call);
  if (call.method === 'GET' && path === '/api/hope/admin/department-agents') {
    return Response.json({ data: agents, count: agents.length, limit: 200, page: 0 });
  }
  if (call.method === 'GET' && path === '/api/hope/admin/departments') return Response.json(DEPARTMENTS);
  if (call.method === 'GET' && path === '/api/hope/admin/prompt-templates') {
    return Response.json({ data: [template()], count: 1, limit: 200, page: 1 });
  }
  return undefined;
}

afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
});

describe('AgentsTab', () => {
  it('renders department-grouped agents with the version-tracking state', async () => {
    stubFetch((call) => defaultHandler([agent()], call));
    renderWithProviders(<AgentsTab />);

    expect(await screen.findByText('CARD')).toBeDefined();
    expect(screen.getByText('Cardiology SOAP')).toBeDefined();
    expect(screen.getByText('Default')).toBeDefined();
    expect(screen.getByText('Tracking latest approved (v5)')).toBeDefined();
  });

  it('shows the Agent Catalog empty state when there are no agents yet', async () => {
    stubFetch((call) => defaultHandler([], call));
    renderWithProviders(<AgentsTab />);

    expect(await screen.findByText('No agents yet')).toBeDefined();
    expect(screen.getByRole('button', { name: 'New agent' })).toBeDefined();
  });

  it('shows read-only "cloned from library" treatment on a locked row', async () => {
    stubFetch((call) => defaultHandler([agent({ templateLocked: true, isDefault: false })], call));
    renderWithProviders(<AgentsTab />);

    expect(await screen.findByText('Cloned from library')).toBeDefined();
  });

  it('opens the detail drawer on row click and shows the pinned-version state', async () => {
    stubFetch((call) => {
      const detail = pathOf(call).match(/^\/api\/hope\/admin\/department-agents\/(da-\d)$/);
      if (call.method === 'GET' && detail) {
        return Response.json(agent({ pinnedVersionNumber: 3, isDefault: false }), { headers: { etag: '"2"' } });
      }
      return defaultHandler([agent({ pinnedVersionNumber: 3, isDefault: false })], call);
    });
    // Land on the Version tab directly via the URL (the same pattern the
    // Agent Templates drawer's own test suite uses) — the pin state only
    // renders once that tab's content mounts.
    renderWithProviders(<AgentsTab />, { searchParams: '?agent=da-1&catab=version' });

    const drawer = await screen.findByRole('dialog');
    expect(await within(drawer).findByText(/Pinned to v3/)).toBeDefined();
  });

  it('flips the Default badge to exactly one agent per department after a set-default action', async () => {
    const other = agent({ id: 'da-2', name: 'Cardiology Discharge', slug: 'cardiology-discharge', isDefault: false });
    const calls = stubFetch((call) => {
      const path = pathOf(call);
      if (call.method === 'POST' && path === '/api/hope/admin/department-agents/da-2/set-default') {
        return Response.json({ ...other, isDefault: true });
      }
      const detail = path.match(/^\/api\/hope\/admin\/department-agents\/(da-\d)$/);
      if (call.method === 'GET' && detail) {
        const row = [agent(), other].find((entry) => entry.id === detail[1]);
        return row ? Response.json(row, { headers: { etag: `"${row.version}"` } }) : undefined;
      }
      return defaultHandler([agent(), other], call);
    });
    renderWithProviders(<AgentsTab />);

    await screen.findByText('Cardiology SOAP');
    fireEvent.click(screen.getByText('Cardiology Discharge'));
    const drawer = await screen.findByRole('dialog');
    fireEvent.click(await within(drawer).findByRole('button', { name: 'Set default' }));

    await waitFor(() =>
      expect(calls.some((call) => call.method === 'POST' && pathOf(call) === '/api/hope/admin/department-agents/da-2/set-default')).toBe(true),
    );
    // Optimistic update: exactly one Default badge remains in the CARD group.
    await waitFor(() => {
      const cardGroup = screen.getByText('CARD').closest('div');
      expect(cardGroup ? within(cardGroup).getAllByText('Default') : []).toHaveLength(1);
    });
  });

  it('has no axe violations', async () => {
    stubFetch((call) => defaultHandler([agent(), agent({ id: 'da-2', departmentId: 'd-2', name: 'Radiology Report', isDefault: false })], call));
    const { container } = renderWithProviders(<AgentsTab />);

    await screen.findByText('Cardiology SOAP');
    expect(await axe(container)).toHaveNoViolations();
  });
});
