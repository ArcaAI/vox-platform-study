/**
 * TASK-1036 E4b (review R-C) — the management screen's confirmations and keyboard reach:
 * bulk Publish / Unpublish / multi-file Export ask first with their consequences, the workflow
 * name is a real link, and the bulk run dialog's results are keyboard-scrollable with a stated
 * reason for the close control being unavailable while the run is in flight.
 */
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { renderWithProviders } from '@/test/render';
import { WorkflowManagementScreen } from '../workflow-management-screen';
import { DISCHARGE_VERSIONS, LINEAGES, TRIAGE_VERSIONS, session, type RecordedCall } from './fixtures';

const push = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push, replace: vi.fn() }), usePathname: () => '/workflow-studio' }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

/** `hold` makes writes (POST) wait on a gate so the run stays in flight. */
function stubFetch(hold?: Promise<void>): RecordedCall[] {
  const calls: RecordedCall[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const call: RecordedCall = { url: String(input), method: init?.method ?? 'GET', body: undefined };
      calls.push(call);
      const path = new URL(call.url, 'http://test.local').pathname;
      const base = '/api/hope/admin/workflow-definitions';
      if (path === '/api/auth/session') return Response.json(session());
      if (call.url.includes('/users/me/settings')) return call.method === 'GET' ? Response.json([]) : Response.json({ ok: true });
      if (call.method === 'GET') {
        if (path === `${base}/lineages`) return Response.json({ count: LINEAGES.length, page: 1, limit: 25, data: LINEAGES });
        if (path === `${base}/tags`) return Response.json([]);
        if (path === `${base}/d-v2/versions`) return Response.json(DISCHARGE_VERSIONS);
        if (path === `${base}/t-v1/versions`) return Response.json(TRIAGE_VERSIONS);
        if (path.endsWith('/export')) return Response.json({ kind: 'workflow', payload: {} });
        return Response.json({ count: 0, page: 1, limit: 100, data: [] });
      }
      if (hold) await hold;
      return Response.json({ id: 'x' });
    }),
  );
  return calls;
}

const writes = (calls: RecordedCall[]) => calls.filter((c) => c.method === 'POST' || c.method === 'DELETE');

async function selectRows(...indexes: number[]) {
  await screen.findByText('Discharge summary');
  const boxes = screen.getAllByRole('checkbox', { name: 'Select row' });
  indexes.forEach((i) => fireEvent.click(boxes[i]));
  return screen.findByRole('toolbar', { name: 'Bulk actions' });
}

beforeEach(() => push.mockClear());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('bulk Publish / Unpublish ask first', () => {
  it('Publish lists what happens per workflow, writes nothing until confirmed, and Cancel writes nothing', async () => {
    const calls = stubFetch();
    renderWithProviders(<WorkflowManagementScreen />);
    const bar = await selectRows(0, 1);
    fireEvent.click(within(bar).getByRole('button', { name: /^publish/i }));

    const confirm = await screen.findByRole('alertdialog');
    expect(within(confirm).getByText(/publish v3/i)).toBeTruthy();
    expect(within(confirm).getByText(/v2 stops serving/i)).toBeTruthy();
    expect(within(confirm).getByText(/ward triage.*skipped/i)).toBeTruthy();
    expect(writes(calls)).toHaveLength(0);

    fireEvent.click(within(confirm).getByRole('button', { name: /cancel/i }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(writes(calls)).toHaveLength(0);
    expect(screen.queryByRole('dialog', { name: /publish/i })).toBeNull();
  });

  it('Publish runs only after the confirm button', async () => {
    const calls = stubFetch();
    renderWithProviders(<WorkflowManagementScreen />);
    const bar = await selectRows(0);
    fireEvent.click(within(bar).getByRole('button', { name: /^publish/i }));
    const confirm = await screen.findByRole('alertdialog');
    fireEvent.click(within(confirm).getByRole('button', { name: /^publish/i }));
    await waitFor(() => expect(writes(calls).map((c) => new URL(c.url, 'http://x').pathname)).toEqual(['/api/hope/admin/workflow-definitions/d-v3/publish']));
  });

  it('Unpublish says the slug will serve nothing and that it cannot be undone, and waits for confirmation', async () => {
    const calls = stubFetch();
    renderWithProviders(<WorkflowManagementScreen />);
    const bar = await selectRows(0);
    fireEvent.click(within(bar).getByRole('button', { name: /unpublish/i }));
    const confirm = await screen.findByRole('alertdialog');
    expect(confirm.textContent).toMatch(/serve nothing/i);
    expect(confirm.textContent).toMatch(/cannot be undone|not reversible/i);
    expect(writes(calls)).toHaveLength(0);
    fireEvent.click(within(confirm).getByRole('button', { name: /^unpublish/i }));
    await waitFor(() => expect(writes(calls)).toHaveLength(1));
  });

  it('Export of several workflows warns that several files will download before starting', async () => {
    const calls = stubFetch();
    renderWithProviders(<WorkflowManagementScreen />);
    const bar = await selectRows(0, 1);
    fireEvent.click(within(bar).getByRole('button', { name: /export/i }));
    const confirm = await screen.findByRole('alertdialog');
    expect(confirm.textContent).toMatch(/2 files/i);
    expect(calls.some((c) => c.url.endsWith('/export'))).toBe(false);
  });
});

describe('workflow name is a link', () => {
  it('is a real link to the studio on the active version, else the newest draft; axe clean', async () => {
    stubFetch();
    const { container } = renderWithProviders(<WorkflowManagementScreen />);
    const link = await screen.findByRole('link', { name: 'Discharge summary' });
    expect(link.getAttribute('href')).toBe('/workflow-studio/d-v2');
    expect(screen.getByRole('link', { name: 'Ward triage' }).getAttribute('href')).toBe('/workflow-studio/t-v1');
    expect(await axe(container)).toHaveNoViolations();
  });

  it('a workflow with nothing to open offers its versions through a button, not a dead link', async () => {
    stubFetch();
    renderWithProviders(<WorkflowManagementScreen />);
    await screen.findByText('Discharge summary');
    expect(screen.queryByRole('link', { name: 'Old flow' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Old flow' })).toBeTruthy();
  });
});

describe('bulk run dialog while in flight', () => {
  it('makes the results list focusable and names why Close is unavailable', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    stubFetch(gate);
    renderWithProviders(<WorkflowManagementScreen />);
    const bar = await selectRows(0);
    fireEvent.click(within(bar).getByRole('button', { name: /unpublish/i }));
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: /^unpublish/i }));

    const results = await screen.findByRole('dialog', { name: /unpublish/i });
    const list = within(results).getByRole('list', { name: 'Per-workflow results' });
    expect(list.getAttribute('tabindex')).toBe('0');
    const close = within(results).getByText('Working…').closest('button') as HTMLButtonElement;
    expect(close.disabled).toBe(true);
    expect(results.textContent).toMatch(/close is unavailable while the run is in progress/i);
    release();
    await waitFor(() => expect((within(results).getByText('Close').closest('button') as HTMLButtonElement).disabled).toBe(false));
  });
});
