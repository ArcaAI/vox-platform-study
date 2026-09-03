/**
 * TDD screen tests for the assignment-matrix screen ( half (a) Task 6):
 * matrix render (tenant-default row + department rows x palette columns),
 * resolved-source display (explicit / inherits-tenant / platform-default —
 * never by color alone), the NoTenant gate, and the OCC create/update/delete
 * flows through the cell-edit drawer — against a URL-branching fetch stub
 * covering the BFF session + workflow-studio routes.
 */
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { renderWithProviders } from '@/test/render';
import type { DepartmentOption, WorkflowAssignment, WorkflowDefinition, WorkflowNodeDescriptor } from '../../../api/types';
import { AssignmentMatrixScreen } from '../assignment-matrix-screen';

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

// Radix Select scrolls the highlighted item into view on open; happy-dom has no layout engine.
beforeAll(() => {
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
});

/** Open the drawer's Radix `Select` and pick an option (the listbox portals to `document.body`). */
async function chooseDefinition(optionName: string | RegExp): Promise<void> {
  const trigger = await screen.findByRole('combobox', { name: 'Workflow definition' });
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: 'mouse' });
  fireEvent.click(await screen.findByRole('option', { name: optionName }));
}

function node(overrides: Partial<WorkflowNodeDescriptor> = {}): WorkflowNodeDescriptor {
  return {
    type: 'summarize.section',
    implemented: true,
    activityName: 'summarizeSection',
    classes: [],
    paletteKey: 'summarization',
    critical: false,
    externalWrite: false,
    defaultTimeoutSeconds: 30,
    defaultMaxAttempts: 3,
    entitlementKey: null,
    configSchema: null,
    inputs: [],
    outputs: [],
    ...overrides,
  };
}

function definition(overrides: Partial<WorkflowDefinition> = {}): WorkflowDefinition {
  return {
    id: 'def-1',
    tenantId: 'tnt-1',
    slug: 'default-note',
    name: 'Default Note',
    description: null,
    paletteKey: 'consultation',
    versionNumber: 1,
    parentVersionId: null,
    status: 'PUBLISHED',
    graph: { version: 1, nodes: [], edges: [] },
    graphChecksum: 'chk-1',
    compiledConfig: null,
    compiledConfigChecksum: null,
    registryChecksum: null,
    validationReport: null,
    needsReview: false,
    validatedAt: '2026-08-01T00:00:00.000Z',
    publishedAt: '2026-08-01T00:00:00.000Z',
    deprecatedAt: null,
    isActive: true,
    resourceStatus: 'ENABLED',
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    version: 1,
    tags: [],
    ...overrides,
  };
}

function assignmentRow(overrides: Partial<WorkflowAssignment> = {}): WorkflowAssignment {
  return {
    id: 'wa-1',
    tenantId: 'tnt-1',
    scope: 'TENANT',
    scopeId: null,
    paletteKey: 'consultation',
    workflowDefinitionSlug: 'default-note',
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    version: 1,
    ...overrides,
  };
}

const DEPARTMENTS: DepartmentOption[] = [
  { id: 'dept-cardiology', name: 'Cardiology', code: 'CARD', resourceStatus: 'ENABLED' },
  { id: 'dept-radiology', name: 'Radiology', code: 'RAD', resourceStatus: 'ENABLED' },
];

const NODES = [node({ type: 'consultation.note', paletteKey: 'consultation' }), node({ type: 'summarize.section', paletteKey: 'summarization' })];

const DEFINITIONS = [
  definition({ id: 'def-1', slug: 'default-note', name: 'Default Note', paletteKey: 'consultation' }),
  definition({ id: 'def-2', slug: 'radiology-note', name: 'Radiology Note', paletteKey: 'consultation' }),
  definition({ id: 'def-3', slug: 'default-summary', name: 'Default Summary', paletteKey: 'summarization' }),
];

const SESSION = {
  user: { id: 'u-1', username: 'super_admin', email: 'admin@arca.ai', roles: ['SUPER_ADMIN'] },
  isElevated: true,
  workingTenantId: 'tnt-1' as string | null,
  workingTenantName: 'Sunrise Medical Group' as string | null,
  impersonatingUserId: null,
  impersonatingUsername: null,
  effectiveUser: { id: 'u-1', username: 'super_admin', email: 'admin@arca.ai', roles: ['SUPER_ADMIN'], tenantId: null, departmentId: null },
  effectiveIsElevated: true,
  effectiveTenantId: 'tnt-1' as string | null,
};

interface RecordedCall {
  url: string;
  method: string;
  headers: Headers;
  body: unknown;
}

interface StubOptions {
  session?: typeof SESSION;
  assignments?: Record<string, WorkflowAssignment[]>;
  custom?: (call: RecordedCall) => Response | undefined;
}

function stubFetch({ session = SESSION, assignments = {}, custom }: StubOptions = {}): RecordedCall[] {
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

      if (call.url === '/api/auth/session') return Response.json(session);
      if (call.method === 'GET' && call.url === '/api/hope/admin/departments?includeDisabled=false') return Response.json(DEPARTMENTS);
      if (call.method === 'GET' && call.url === '/api/hope/admin/workflow-nodes') {
        return Response.json({ nodes: NODES, registryChecksum: 'chk-registry' });
      }
      if (call.method === 'GET' && call.url === '/api/hope/admin/workflow-definitions?page=0&limit=200') {
        return Response.json({ data: DEFINITIONS, count: DEFINITIONS.length, limit: 200, page: 0 });
      }
      if (call.method === 'GET' && call.url.startsWith('/api/hope/admin/workflow-assignments?paletteKey=')) {
        const paletteKey = new URL(call.url, 'http://localhost').searchParams.get('paletteKey') ?? '';
        return Response.json(assignments[paletteKey] ?? []);
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

describe('AssignmentMatrixScreen', () => {
  it('renders the matrix with a tenant-default row, department rows and palette columns', async () => {
    stubFetch({
      assignments: { consultation: [assignmentRow({ id: 'wa-tenant', workflowDefinitionSlug: 'default-note' })] },
    });
    renderWithProviders(<AssignmentMatrixScreen />);

    expect(screen.getByRole('heading', { level: 1, name: 'Workflow Assignments' })).toBeDefined();
    expect(await screen.findByRole('columnheader', { name: 'Consultation' })).toBeDefined();
    expect(screen.getByRole('columnheader', { name: 'Summarization' })).toBeDefined();
    expect(screen.getByRole('rowheader', { name: /Tenant default/ })).toBeDefined();
    expect(screen.getByRole('rowheader', { name: /Cardiology/ })).toBeDefined();
    expect(screen.getByRole('rowheader', { name: /Radiology/ })).toBeDefined();
  });

  it('shows an explicit tenant assignment and department inheritance with distinct, text-labeled badges', async () => {
    stubFetch({
      assignments: { consultation: [assignmentRow({ id: 'wa-tenant', workflowDefinitionSlug: 'default-note' })] },
    });
    renderWithProviders(<AssignmentMatrixScreen />);

    const tenantCell = await screen.findByRole('button', { name: /Tenant default, Consultation: default-note \(Explicit\)/ });
    expect(within(tenantCell).getByText('Explicit')).toBeDefined();

    const cardiologyCell = screen.getByRole('button', { name: /Cardiology, Consultation: default-note \(Inherits tenant\)/ });
    expect(within(cardiologyCell).getByText('Inherits tenant')).toBeDefined();

    // No tenant row for summarization -> platform default, no slug.
    const summaryCell = screen.getByRole('button', { name: /Cardiology, Summarization: platform default \(Platform default\)/ });
    expect(within(summaryCell).getByText('Platform default')).toBeDefined();
  });

  it('creates a new department override (POST, no If-Match) when none exists yet', async () => {
    const calls = stubFetch({
      assignments: { consultation: [assignmentRow({ id: 'wa-tenant', workflowDefinitionSlug: 'default-note' })] },
      custom: (call) => {
        if (call.method === 'POST' && call.url === '/api/hope/admin/workflow-assignments') {
          return Response.json(
            assignmentRow({ id: 'wa-dept', scope: 'DEPARTMENT', scopeId: 'dept-cardiology', workflowDefinitionSlug: 'radiology-note' }),
            { status: 201 },
          );
        }
        return undefined;
      },
    });
    renderWithProviders(<AssignmentMatrixScreen />);

    const cardiologyCell = await screen.findByRole('button', { name: /Cardiology, Consultation:/ });
    fireEvent.click(cardiologyCell);

    await chooseDefinition('Radiology Note (radiology-note)');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(calls.some((call) => call.method === 'POST')).toBe(true));
    const created = calls.find((call) => call.method === 'POST');
    expect(created?.headers.get('if-match')).toBeNull();
    expect(created?.body).toEqual({
      scope: 'DEPARTMENT',
      scopeId: 'dept-cardiology',
      paletteKey: 'consultation',
      workflowDefinitionSlug: 'radiology-note',
      reason: undefined,
    });
  });

  it('updates an existing explicit assignment with If-Match + expectedVersion', async () => {
    const calls = stubFetch({
      assignments: {
        consultation: [
          assignmentRow({ id: 'wa-tenant', workflowDefinitionSlug: 'default-note' }),
          assignmentRow({ id: 'wa-dept', scope: 'DEPARTMENT', scopeId: 'dept-cardiology', workflowDefinitionSlug: 'default-note', version: 3 }),
        ],
      },
      custom: (call) => {
        if (call.method === 'PATCH' && call.url === '/api/hope/admin/workflow-assignments') {
          return Response.json(
            assignmentRow({ id: 'wa-dept', scope: 'DEPARTMENT', scopeId: 'dept-cardiology', workflowDefinitionSlug: 'radiology-note', version: 4 }),
            { headers: { etag: '"4"' } },
          );
        }
        return undefined;
      },
    });
    renderWithProviders(<AssignmentMatrixScreen />);

    const cardiologyCell = await screen.findByRole('button', { name: /Cardiology, Consultation: default-note \(Explicit\)/ });
    fireEvent.click(cardiologyCell);

    await chooseDefinition('Radiology Note (radiology-note)');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(calls.some((call) => call.method === 'PATCH')).toBe(true));
    const patch = calls.find((call) => call.method === 'PATCH');
    expect(patch?.headers.get('if-match')).toBe('"3"');
    expect(patch?.body).toMatchObject({ workflowDefinitionSlug: 'radiology-note', expectedVersion: 3 });
  });

  it('clears an override (DELETE with If-Match) when Inherit is selected over an existing row', async () => {
    const calls = stubFetch({
      assignments: {
        consultation: [
          assignmentRow({ id: 'wa-tenant', workflowDefinitionSlug: 'default-note' }),
          assignmentRow({ id: 'wa-dept', scope: 'DEPARTMENT', scopeId: 'dept-cardiology', workflowDefinitionSlug: 'radiology-note', version: 2 }),
        ],
      },
      custom: (call) => {
        if (call.method === 'DELETE' && call.url.startsWith('/api/hope/admin/workflow-assignments/wa-dept')) {
          return Response.json(assignmentRow({ id: 'wa-dept', scope: 'DEPARTMENT', scopeId: 'dept-cardiology', version: 3 }));
        }
        return undefined;
      },
    });
    renderWithProviders(<AssignmentMatrixScreen />);

    const cardiologyCell = await screen.findByRole('button', { name: /Cardiology, Consultation: radiology-note \(Explicit\)/ });
    fireEvent.click(cardiologyCell);

    await chooseDefinition(/^Inherit/);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(calls.some((call) => call.method === 'DELETE')).toBe(true));
    const deleted = calls.find((call) => call.method === 'DELETE');
    expect(deleted?.url).toBe('/api/hope/admin/workflow-assignments/wa-dept');
    expect(deleted?.headers.get('if-match')).toBe('"2"');
  });

  it('gates an elevated session without a working tenant behind the NoTenant empty state', async () => {
    stubFetch({ session: { ...SESSION, workingTenantId: null, workingTenantName: null, effectiveTenantId: null } });
    renderWithProviders(<AssignmentMatrixScreen />);

    expect(await screen.findByText('Select a working tenant')).toBeDefined();
    expect(screen.getByRole('heading', { level: 1, name: 'Workflow Assignments' })).toBeDefined();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('has zero axe violations once the matrix is loaded', async () => {
    stubFetch({
      assignments: { consultation: [assignmentRow({ id: 'wa-tenant', workflowDefinitionSlug: 'default-note' })] },
    });
    const { container } = renderWithProviders(<AssignmentMatrixScreen />);
    await screen.findByRole('columnheader', { name: 'Consultation' });
    expect(await axe(container)).toHaveNoViolations();
  });
});
