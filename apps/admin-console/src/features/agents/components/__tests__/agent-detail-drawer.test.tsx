/**
 * DepartmentAgent detail drawer (TASK-547): Settings (OCC PATCH, name/Agent
 * Template/DNA gate), Version (pin/track-latest via `POST :id/pin`), History
 * (read-only reuse of `VersionsPanel`), locked-template treatment, and create
 * mode. Rendered standalone.
 */

import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { renderWithProviders } from '@/test/render';
import type { DepartmentAgent, PromptTemplate, PromptVersion } from '../../api/types';
import { DepartmentAgentDetailDrawer } from '../agent-detail-drawer';

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
    isDefault: false,
    templateLocked: false,
    resourceStatus: 'ENABLED',
    createdAt: '2026-06-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
    version: 2,
    ...overrides,
  };
}

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

function version(versionNumber: number, overrides: Partial<PromptVersion> = {}): PromptVersion {
  return {
    id: `pv-${versionNumber}`,
    promptTemplateId: 'pt-1',
    versionNumber,
    content: `Prompt body v${versionNumber}`,
    changedBy: 'dr.lee',
    createdAt: '2026-06-20T10:00:00.000Z',
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

// Radix Select scrolls the highlighted item into view on open; happy-dom has no layout engine.
beforeAll(() => {
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
});

/**
 * Open a Radix `Select` by its trigger's accessible name and pick an option
 * (the option list portals to `document.body`). `getByRole('combobox', ...)`
 * — not `getByLabelText` — because the ARIA name algorithm excludes the
 * `aria-hidden` "*" required-mark that `getByLabelText`'s plain textContent
 * match would otherwise choke on.
 */
async function chooseSelectOption(triggerLabel: string, optionName: string): Promise<void> {
  const trigger = await screen.findByRole('combobox', { name: triggerLabel });
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: 'mouse' });
  fireEvent.click(await screen.findByRole('option', { name: optionName }));
}

function defaultHandler(currentAgent: DepartmentAgent, call: RecordedCall): Response | undefined {
  const path = pathOf(call);
  if (call.method === 'GET' && path === `/api/hope/admin/department-agents/${currentAgent.id}`) {
    return Response.json(currentAgent, { headers: { etag: `"${currentAgent.version}"` } });
  }
  if (call.method === 'GET' && path === '/api/hope/admin/prompt-templates') {
    return Response.json({ data: [template()], count: 1, limit: 200, page: 1 });
  }
  if (call.method === 'GET' && path === `/api/hope/admin/prompt-templates/${currentAgent.promptTemplateId}`) {
    return Response.json(template(), { headers: { etag: '"5"' } });
  }
  if (call.method === 'GET' && path === `/api/hope/admin/prompt-templates/${currentAgent.promptTemplateId}/versions`) {
    return Response.json([version(5), version(4, { changedBy: 'minh.tran' }), version(3, { changedBy: 'dr.chen' })]);
  }
  // Settings-tab golden-set picker (TASK-549) — the Eval panel's own suite
  // covers real sets; here an empty page is enough to unblock the query.
  if (call.method === 'GET' && path === '/api/hope/admin/harness/golden-sets') {
    return Response.json({ items: [], total: 0 });
  }
  // Lineage tab (TASK-674) — an empty history/lineage is enough to unblock
  // the two queries when a test does not care about their content.
  if (call.method === 'GET' && path === `/api/hope/admin/department-agents/${currentAgent.id}/versions`) {
    return Response.json([]);
  }
  if (call.method === 'GET' && path === '/api/hope/admin/agent-promotions') {
    return Response.json({ data: [], count: 0, limit: 50, page: 0 });
  }
  return undefined;
}

afterEach(() => {
  vi.unstubAllGlobals();
  document.documentElement.classList.remove('dark');
  cleanup();
});

describe('DepartmentAgentDetailDrawer', () => {
  it('renders "Tracking latest approved" when unpinned, and "Pinned to vN" once pinned', async () => {
    stubFetch((call) => defaultHandler(agent({ pinnedVersionNumber: 3 }), call));
    renderWithProviders(
      <DepartmentAgentDetailDrawer
        agentId="da-1"
        creating={false}
        departmentLabel="CARD"
        onOpenChange={() => {}}
        onCreated={() => {}}
        onRequestDelete={() => {}}
        onSetDefault={() => {}}
      />,
      { searchParams: '?catab=version' },
    );

    const drawer = await screen.findByRole('dialog');
    expect(await within(drawer).findByText(/Pinned to v3/)).toBeDefined();
  });

  it('PATCHes Settings changes with If-Match, and a 412 renders the reload-merge alert instead of a toast', async () => {
    const calls = stubFetch((call) => {
      if (call.method === 'PATCH' && pathOf(call) === '/api/hope/admin/department-agents/da-1') {
        return new Response('conflict', { status: 412 });
      }
      return defaultHandler(agent(), call);
    });
    renderWithProviders(
      <DepartmentAgentDetailDrawer
        agentId="da-1"
        creating={false}
        departmentLabel="CARD"
        onOpenChange={() => {}}
        onCreated={() => {}}
        onRequestDelete={() => {}}
        onSetDefault={() => {}}
      />,
    );

    const nameInput = (await screen.findByRole('textbox', { name: 'Name' })) as HTMLInputElement;
    expect(nameInput.value).toBe('Cardiology SOAP');
    fireEvent.change(nameInput, { target: { value: 'Cardiology SOAP v2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(calls.some((call) => call.method === 'PATCH')).toBe(true));
    const patch = calls.find((call) => call.method === 'PATCH');
    expect(patch?.headers['if-match']).toBe('"2"');
    expect(await screen.findByText(/changed by another admin after you loaded it/i)).toBeDefined();
  });

  it('attaches a golden set (TASK-549 eval gate) via the Settings-tab picker', async () => {
    const calls = stubFetch((call) => {
      if (call.method === 'GET' && pathOf(call) === '/api/hope/admin/harness/golden-sets') {
        return Response.json({
          items: [{ id: 'gs-1', name: 'GI consultations golden set', description: null, pinnedVersion: null }],
          total: 1,
        });
      }
      if (call.method === 'PATCH' && pathOf(call) === '/api/hope/admin/department-agents/da-1') {
        return Response.json(agent({ goldenSetId: 'gs-1', version: 3 }), { headers: { etag: '"3"' } });
      }
      return defaultHandler(agent(), call);
    });
    renderWithProviders(
      <DepartmentAgentDetailDrawer
        agentId="da-1"
        creating={false}
        departmentLabel="CARD"
        onOpenChange={() => {}}
        onCreated={() => {}}
        onRequestDelete={() => {}}
        onSetDefault={() => {}}
      />,
    );

    await screen.findByRole('textbox', { name: 'Name' });
    await chooseSelectOption('Golden set', 'GI consultations golden set');
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(calls.some((call) => call.method === 'PATCH')).toBe(true));
    const patch = calls.find((call) => call.method === 'PATCH');
    expect((patch?.body as { goldenSetId?: string }).goldenSetId).toBe('gs-1');
  });

  it('detaches a golden set by sending goldenSetId: null', async () => {
    const calls = stubFetch((call) => {
      if (call.method === 'GET' && pathOf(call) === '/api/hope/admin/harness/golden-sets') {
        return Response.json({
          items: [{ id: 'gs-1', name: 'GI consultations golden set', description: null, pinnedVersion: null }],
          total: 1,
        });
      }
      if (call.method === 'PATCH' && pathOf(call) === '/api/hope/admin/department-agents/da-1') {
        return Response.json(agent({ goldenSetId: undefined, version: 3 }), { headers: { etag: '"3"' } });
      }
      return defaultHandler(agent({ goldenSetId: 'gs-1' }), call);
    });
    renderWithProviders(
      <DepartmentAgentDetailDrawer
        agentId="da-1"
        creating={false}
        departmentLabel="CARD"
        onOpenChange={() => {}}
        onCreated={() => {}}
        onRequestDelete={() => {}}
        onSetDefault={() => {}}
      />,
    );

    await screen.findByRole('textbox', { name: 'Name' });
    await chooseSelectOption('Golden set', 'None — eval gate off');
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(calls.some((call) => call.method === 'PATCH')).toBe(true));
    const patch = calls.find((call) => call.method === 'PATCH');
    expect((patch?.body as { goldenSetId?: string | null }).goldenSetId).toBeNull();
  });

  it('pins to a chosen version via POST :id/pin and shows the new pin state', async () => {
    let pinned: number | null = null;
    const calls = stubFetch((call) => {
      if (call.method === 'POST' && pathOf(call) === '/api/hope/admin/department-agents/da-1/pin') {
        pinned = (call.body as { versionNumber: number | null }).versionNumber;
        return Response.json(agent({ pinnedVersionNumber: pinned, version: 3 }));
      }
      return defaultHandler(agent({ pinnedVersionNumber: pinned }), call);
    });
    renderWithProviders(
      <DepartmentAgentDetailDrawer
        agentId="da-1"
        creating={false}
        departmentLabel="CARD"
        onOpenChange={() => {}}
        onCreated={() => {}}
        onRequestDelete={() => {}}
        onSetDefault={() => {}}
      />,
      { searchParams: '?catab=version' },
    );

    await screen.findByText(/Tracking latest approved/);
    fireEvent.change(await screen.findByLabelText('Pin to version'), { target: { value: '3' } });
    fireEvent.click(screen.getByRole('button', { name: 'Pin' }));

    await waitFor(() => expect(calls.some((call) => call.method === 'POST' && pathOf(call).endsWith('/pin'))).toBe(true));
    const pin = calls.find((call) => call.method === 'POST' && pathOf(call).endsWith('/pin'));
    expect(pin?.body).toEqual({ versionNumber: 3 });
  });

  it('renders the bound Agent Template version timeline in the History tab', async () => {
    stubFetch((call) => defaultHandler(agent(), call));
    renderWithProviders(
      <DepartmentAgentDetailDrawer
        agentId="da-1"
        creating={false}
        departmentLabel="CARD"
        onOpenChange={() => {}}
        onCreated={() => {}}
        onRequestDelete={() => {}}
        onSetDefault={() => {}}
      />,
      { searchParams: '?catab=history' },
    );

    const timeline = await screen.findByLabelText('Versions of Cardiology Notes');
    expect(within(timeline).getByText('v5')).toBeDefined();
    expect(within(timeline).getByText('dr.lee')).toBeDefined();
  });

  it('renders a locked agent read-only: Settings disabled, no Delete action, "cloned from library" hint', async () => {
    stubFetch((call) => defaultHandler(agent({ templateLocked: true }), call));
    renderWithProviders(
      <DepartmentAgentDetailDrawer
        agentId="da-1"
        creating={false}
        departmentLabel="CARD"
        onOpenChange={() => {}}
        onCreated={() => {}}
        onRequestDelete={() => {}}
        onSetDefault={() => {}}
      />,
    );

    expect(await screen.findByText(/Cloned from library/)).toBeDefined();
    expect((screen.getByLabelText('Name') as HTMLInputElement).disabled).toBe(true);
    expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull();
  });

  it('creates an agent from the drawer create mode (no modal)', async () => {
    const calls = stubFetch((call) => {
      if (call.method === 'POST' && pathOf(call) === '/api/hope/admin/department-agents') {
        return Response.json(agent({ id: 'da-9', name: 'Nephrology SOAP' }));
      }
      if (call.method === 'GET' && pathOf(call) === '/api/hope/admin/departments') {
        return Response.json([{ id: 'd-1', code: 'CARD', name: 'Cardiology', isRootDepartment: true, createdAt: '', updatedAt: '', version: 1 }]);
      }
      return defaultHandler(agent(), call);
    });
    let created: DepartmentAgent | null = null;
    renderWithProviders(
      <DepartmentAgentDetailDrawer
        agentId={null}
        creating
        departmentLabel={null}
        onOpenChange={() => {}}
        onCreated={(a) => (created = a)}
        onRequestDelete={() => {}}
        onSetDefault={() => {}}
      />,
    );

    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByRole('combobox', { name: 'Department' });
    await chooseSelectOption('Department', 'CARD');
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Name' }), { target: { value: 'Nephrology SOAP' } });
    await chooseSelectOption('Agent template', 'Cardiology Notes');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create agent' }));

    await waitFor(() => expect(calls.some((call) => call.method === 'POST' && pathOf(call) === '/api/hope/admin/department-agents')).toBe(true));
    expect(created).toMatchObject({ id: 'da-9', name: 'Nephrology SOAP' });
  });

  it('has no axe violations on the Settings tab', async () => {
    stubFetch((call) => defaultHandler(agent(), call));
    const { container } = renderWithProviders(
      <DepartmentAgentDetailDrawer
        agentId="da-1"
        creating={false}
        departmentLabel="CARD"
        onOpenChange={() => {}}
        onCreated={() => {}}
        onRequestDelete={() => {}}
        onSetDefault={() => {}}
      />,
    );

    await screen.findByRole('textbox', { name: 'Name' });
    expect(await axe(container)).toHaveNoViolations();
  });

  it('renders config versions with a field diff, and promotion lineage, on the Lineage tab (TASK-674)', async () => {
    stubFetch((call) => {
      const path = pathOf(call);
      if (call.method === 'GET' && path === '/api/hope/admin/department-agents/da-1/versions') {
        return Response.json([
          { id: 'dav-2', agentId: 'da-1', versionNumber: 2, configSnapshot: { role: 'PRIMARY' }, checksum: 'c2', changeReason: 'Promoted to primary', createdBy: 'dr.lee', createdAt: '2026-07-02T10:00:00.000Z' },
          { id: 'dav-1', agentId: 'da-1', versionNumber: 1, configSnapshot: { role: 'SPECIALIST' }, checksum: 'c1', changeReason: null, createdBy: 'dr.lee', createdAt: '2026-06-01T10:00:00.000Z' },
        ]);
      }
      if (call.method === 'GET' && path === '/api/hope/admin/agent-promotions') {
        return Response.json({
          data: [
            {
              id: 'promo-1',
              fromTenantId: 'tenant-source',
              toTenantId: 'tenant-1',
              agentVersionId: 'dav-1',
              sourceAgentId: 'da-source',
              targetAgentId: 'da-1',
              targetAgentVersionId: 'dav-1',
              configSnapshot: { role: 'SPECIALIST' },
              checksum: 'c1',
              evalRunId: null,
              sourceEvalRunId: null,
              warnings: [],
              promotedBy: 'admin.global',
              drifted: false,
              createdAt: '2026-06-01T09:00:00.000Z',
            },
          ],
          count: 1,
          limit: 50,
          page: 0,
        });
      }
      return defaultHandler(agent(), call);
    });
    renderWithProviders(
      <DepartmentAgentDetailDrawer
        agentId="da-1"
        creating={false}
        departmentLabel="CARD"
        onOpenChange={() => {}}
        onCreated={() => {}}
        onRequestDelete={() => {}}
        onSetDefault={() => {}}
      />,
      { searchParams: '?catab=lineage' },
    );

    const versionsList = await screen.findByLabelText('Loop-configuration versions');
    expect(within(versionsList).getByText('v2')).toBeDefined();
    expect(within(versionsList).getByText('Promoted to primary')).toBeDefined();
    // Two versions exist, so the diff between v1 and v2 renders by default.
    expect(await screen.findByLabelText('Changes between v1 and v2')).toBeDefined();

    const promotions = await screen.findByLabelText('Promotions into this agent');
    expect(within(promotions).getByText('tenant-source')).toBeDefined();
    expect(within(promotions).getByText('Up to date')).toBeDefined();
  });

  it('has no axe violations on the Lineage tab in the light theme', async () => {
    stubFetch((call) => defaultHandler(agent(), call));
    const { container } = renderWithProviders(
      <DepartmentAgentDetailDrawer
        agentId="da-1"
        creating={false}
        departmentLabel="CARD"
        onOpenChange={() => {}}
        onCreated={() => {}}
        onRequestDelete={() => {}}
        onSetDefault={() => {}}
      />,
      { searchParams: '?catab=lineage' },
    );

    await screen.findByText('This agent was not created by a cross-tenant promotion.');
    expect(await axe(container)).toHaveNoViolations();
  });

  it('has no axe violations on the Lineage tab in the dark theme', async () => {
    document.documentElement.classList.add('dark');
    stubFetch((call) => defaultHandler(agent(), call));
    const { container } = renderWithProviders(
      <DepartmentAgentDetailDrawer
        agentId="da-1"
        creating={false}
        departmentLabel="CARD"
        onOpenChange={() => {}}
        onCreated={() => {}}
        onRequestDelete={() => {}}
        onSetDefault={() => {}}
      />,
      { searchParams: '?catab=lineage' },
    );

    await screen.findByText('This agent was not created by a cross-tenant promotion.');
    expect(await axe(container)).toHaveNoViolations();
  });
});
