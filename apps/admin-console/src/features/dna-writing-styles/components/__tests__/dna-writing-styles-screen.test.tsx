/**
 * Frame 33 — DNA writing styles screen. fetch is stubbed at the network
 * boundary (BFF session + gateway proxy paths) and EventSource is stubbed
 * globally where the generate flow mounts the job stream. Covers the working-
 * tenant gate, dashboard + grid rendering, the doctor detail panel with the
 * If-Match PATCH, the generate -> job progress flow and the list error state.
 */

import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { toast } from 'sonner';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '@/test/render';
import type { DnaDashboard, DnaReport, DnaVersion } from '../../api/types';
import { DnaWritingStylesScreen } from '../dna-writing-styles-screen';

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

/** Instrumented EventSource double for the job stream. */
class FakeEventSource {
  static instances: FakeEventSource[] = [];
  readonly url: string;
  readonly listeners = new Map<string, Array<(event: MessageEvent) => void>>();
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  addEventListener(name: string, listener: (event: MessageEvent) => void): void {
    const existing = this.listeners.get(name) ?? [];
    this.listeners.set(name, [...existing, listener]);
  }

  close(): void {
    this.closed = true;
  }

  open(): void {
    this.onopen?.();
  }

  emit(type: string, data: string): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener({ data } as MessageEvent);
    }
  }
}

function report(overrides: Partial<DnaReport> = {}): DnaReport {
  return {
    id: 'rep-1',
    doctorId: 'doc-1',
    styleText: 'Formal, concise clinical prose.',
    isLatest: true,
    currentVersionNumber: 3,
    createdAt: '2026-05-01T10:00:00.000Z',
    updatedAt: '2026-07-01T10:00:00.000Z',
    resourceStatus: 'ENABLED',
    version: 3,
    ...overrides,
  };
}

const REPORTS: DnaReport[] = [
  report({ doctorUsername: 'dr.house' }),
  report({ id: 'rep-2', doctorId: 'doc-2', currentVersionNumber: 1, isLatest: false, version: 1, updatedAt: '2026-06-20T10:00:00.000Z' }),
];

const DASHBOARD: DnaDashboard = {
  usersWithStyle: 17,
  avgVersions: 2.4,
  recentActivity: { dailyCounts: [], latest: [], total: 42, windowDays: 30 },
};

const VERSIONS: DnaVersion[] = [
  { id: 'ver-3', dnaReportId: 'rep-1', versionNumber: 3, changeReason: 'manual edit', changedBy: 'u-9', createdAt: '2026-07-01T10:00:00.000Z' },
  { id: 'ver-2', dnaReportId: 'rep-1', versionNumber: 2, createdAt: '2026-06-08T10:00:00.000Z' },
];

interface RecordedCall {
  url: string;
  method: string;
  headers: Headers;
  body: unknown;
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
        headers: new Headers(init?.headers),
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

function session(overrides: Partial<{ isElevated: boolean; workingTenantId: string | null }> = {}) {
  const base = {
    user: { id: 'u-1', username: 'g_admin', email: 'g_admin@hope.local', roles: ['SUPER_ADMIN'] },
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

function pathnameOf(call: RecordedCall): string {
  return new URL(call.url, 'http://test.local').pathname;
}

/** Read paths through the proxy that every test starts from. */
function defaultHandler(call: RecordedCall): Response | undefined {
  const path = pathnameOf(call);
  if (call.method === 'POST' && path === '/api/auth/stream-ticket') {
    return Response.json({ ticket: 'tkt-1', expiresAt: Date.now() + 30_000, scope: 'dna_job:job-1' });
  }
  if (call.method === 'POST' && path === '/api/hope/admin/dna-writing-styles/generate/doc-1') {
    return Response.json({ jobId: 'job-1', status: 'PENDING' });
  }
  if (call.method !== 'GET') return undefined;
  if (path === '/api/auth/session') return Response.json(session());
  if (path === '/api/hope/admin/dna-writing-styles') {
    return Response.json({ data: REPORTS, count: REPORTS.length, limit: 25, page: 1 });
  }
  if (path === '/api/hope/admin/dna-writing-styles/dashboard') return Response.json(DASHBOARD);
  if (path === '/api/hope/admin/dna-writing-styles/doctor/doc-1') {
    return Response.json(report(), { headers: { etag: '"3"' } });
  }
  if (path === '/api/hope/admin/dna-writing-styles/rep-1/versions') return Response.json(VERSIONS);
  if (path === '/api/hope/admin/dna-writing-styles/jobs/job-1') {
    return Response.json({ jobId: 'job-1', status: 'processing', progress: 10 });
  }
  return undefined;
}

/** Best-effort per-user grid-layout persistence (`users/me/settings`) — no saved layout in tests. */
function settingsResponse(call: RecordedCall): Response | undefined {
  if (!call.url.includes('/users/me/settings')) return undefined;
  return call.method === 'GET' ? Response.json([]) : Response.json({ ok: true });
}

function stubDna(custom: FetchHandler = () => undefined): RecordedCall[] {
  return stubFetch((call) => settingsResponse(call) ?? custom(call) ?? defaultHandler(call));
}

beforeEach(() => {
  FakeEventSource.instances = [];
  vi.stubGlobal('EventSource', FakeEventSource);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('DnaWritingStylesScreen', () => {
  it('asks an elevated session without a working tenant to pick one (no data queries fired)', async () => {
    const calls = stubDna((call) => {
      if (pathnameOf(call) === '/api/auth/session') return Response.json(session({ workingTenantId: null }));
      return undefined;
    });
    renderWithProviders(<DnaWritingStylesScreen />);

    expect(await screen.findByText('Select a working tenant')).toBeDefined();
    expect(screen.getByRole('heading', { level: 1, name: 'DNA Writing Styles' })).toBeDefined();
    expect(calls.every((call) => !call.url.includes('/dna-writing-styles'))).toBe(true);
  });

  it('renders the dashboard roll-up, the report grid and the endpoint meta', async () => {
    stubDna();
    renderWithProviders(<DnaWritingStylesScreen />);

    // Grid rows: the human-readable doctor username is the primary label,
    // while the raw id stays present as secondary metadata.
    expect(await screen.findByText('dr.house')).toBeDefined();
    expect(screen.getAllByText('doc-1').length).toBeGreaterThanOrEqual(1);
    // A row without a resolved username falls back to the raw id.
    expect(screen.getByText('doc-2')).toBeDefined();
    expect(screen.getByText('v3')).toBeDefined();
    expect(screen.getByText('Latest')).toBeDefined();
    expect(screen.getAllByText('Active').length).toBe(2);

    // Dashboard stats from GET /dashboard.
    expect(screen.getByText('Doctors covered')).toBeDefined();
    expect(screen.getByText('17')).toBeDefined();
    expect(screen.getByText('2.4')).toBeDefined();
    expect(screen.getByText(/Usage \u00b7 30d/)).toBeDefined();
    expect(screen.getByText('42')).toBeDefined();

    // Header meta + generate/SSE hint lines.
    expect(screen.getByText(/2 reports/)).toBeDefined();
    expect(screen.getByText(/17 doctors covered/)).toBeDefined();
    expect(screen.getByText('GET /admin/dna-writing-styles')).toBeDefined();
    expect(screen.getByText('Generate: POST /generate/:doctorId')).toBeDefined();
    expect(screen.getByText('SSE: GET /jobs/:jobId/stream')).toBeDefined();

    // Redesign: the header generate action is always available — it opens the
    // dialog with the doctor id prefilled from the selected row (or typed for a
    // brand-new doctor). No selection gate anymore.
    const generateButtons = screen.getAllByRole('button', { name: /generate report/i }) as HTMLButtonElement[];
    expect(generateButtons[0].disabled).toBe(false);
  });

  it('keeps the layout skeleton while the session is in flight', () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>(() => {})),
    );
    const { container } = renderWithProviders(<DnaWritingStylesScreen />);

    expect(container.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(0);
  });

  it('shows the "No DNA reports yet" empty state with a working generate CTA', async () => {
    stubDna((call) => {
      if (call.method === 'GET' && pathnameOf(call) === '/api/hope/admin/dna-writing-styles') {
        return Response.json({ data: [], count: 0, limit: 25, page: 1 });
      }
      return undefined;
    });
    renderWithProviders(<DnaWritingStylesScreen />);

    expect(await screen.findByText('No DNA reports yet')).toBeDefined();
    const cta = (screen.getAllByRole('button', { name: /generate report/i }) as HTMLButtonElement[]).find((button) => !button.disabled);
    expect(cta).toBeDefined();

    fireEvent.click(cta as HTMLButtonElement);
    const dialog = await screen.findByRole('dialog');
    const submit = within(dialog).getByRole('button', { name: /^generate$/i }) as HTMLButtonElement;
    // No doctor selected -> the id must be typed before submitting.
    expect((within(dialog).getByLabelText(/doctor id/i) as HTMLInputElement).value).toBe('');
    expect(submit.disabled).toBe(true);
  });

  it('renders the block error state and retries the list request', async () => {
    const calls = stubDna((call) => {
      if (call.method === 'GET' && pathnameOf(call) === '/api/hope/admin/dna-writing-styles') {
        return Response.json({ message: 'DNA API unavailable' }, { status: 503 });
      }
      return undefined;
    });
    renderWithProviders(<DnaWritingStylesScreen />);

    expect(await screen.findByText(/dna api unavailable/i)).toBeDefined();

    fireEvent.click(screen.getAllByRole('button', { name: /retry/i })[0]);
    await waitFor(() =>
      expect(calls.filter((call) => call.method === 'GET' && pathnameOf(call) === '/api/hope/admin/dna-writing-styles').length).toBe(2),
    );
  });

  it('opens the doctor detail slide-over on row click with the latest report and version timeline', async () => {
    stubDna();
    renderWithProviders(<DnaWritingStylesScreen />);

    fireEvent.click(await screen.findByText('doc-1'));

    // The console-wide detail surface (a Sheet → dialog) opens on selection.
    const dialog = await screen.findByRole('dialog');
    // GET doctor/:doctorId detail lands in the slide-over.
    expect(await within(dialog).findByText('rep-1')).toBeDefined();
    expect(within(dialog).getByText('Report ID')).toBeDefined();
    expect(within(dialog).getByText('Formal, concise clinical prose.')).toBeDefined();

    // GET :reportId/versions timeline, newest first.
    const timeline = await within(dialog).findByRole('list', { name: 'Version timeline' });
    const items = within(timeline).getAllByRole('listitem');
    expect(items[0].textContent).toContain('v3');
    expect(items[0].textContent).toContain('manual edit');
    expect(items[1].textContent).toContain('v2');
    expect(items[1].textContent).toContain('auto-generate');

    // PHI posture caption (frame 33).
    expect(within(dialog).getByText(/doctor reads stay tenant-pinned even for super admins/i)).toBeDefined();
  });

  it('edits the report through the If-Match OCC PATCH', async () => {
    const calls = stubDna((call) => {
      if (call.method === 'PATCH' && pathnameOf(call) === '/api/hope/admin/dna-writing-styles/rep-1') {
        return Response.json(report({ version: 4 }), { headers: { etag: '"4"' } });
      }
      return undefined;
    });
    renderWithProviders(<DnaWritingStylesScreen />, { searchParams: '?selected=doc-1' });

    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    expect(within(screen.getByRole('dialog')).getAllByText('Style text')).toHaveLength(1);
    fireEvent.change(screen.getByLabelText('Style text'), { target: { value: 'Adjusted clinical prose.' } });
    fireEvent.change(screen.getByLabelText('Change reason'), { target: { value: 'tone fix' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      const patch = calls.find((call) => call.method === 'PATCH');
      expect(patch?.url).toBe('/api/hope/admin/dna-writing-styles/rep-1');
      expect(patch?.headers.get('if-match')).toBe('"3"');
      expect(patch?.body).toEqual({ styleText: 'Adjusted clinical prose.', changeReason: 'tone fix', expectedVersion: 3 });
    });
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Report updated'));
  });

  it('generates a report: POST -> job progress strip -> completion toast + grid refresh', async () => {
    const calls = stubDna();
    // Drive generation from the header entry with no row selected, so the
    // dashboard roll-up (and its progress strip) is not behind the modal
    // detail slide-over. The doctor id is typed into the dialog.
    renderWithProviders(<DnaWritingStylesScreen />);

    const generateButton = (await screen.findAllByRole('button', { name: /generate report/i }))[0] as HTMLButtonElement;
    await waitFor(() => expect(generateButton.disabled).toBe(false));
    fireEvent.click(generateButton);

    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText(/doctor id/i), { target: { value: 'doc-1' } });
    fireEvent.click(within(dialog).getByRole('button', { name: /^generate$/i }));

    await waitFor(() =>
      expect(calls.some((call) => call.method === 'POST' && pathnameOf(call) === '/api/hope/admin/dna-writing-styles/generate/doc-1')).toBe(true),
    );

    // The progress strip mounts, driven by the SSE stream + status poll.
    expect(await screen.findByRole('progressbar')).toBeDefined();
    expect(screen.getByText('job-1')).toBeDefined();

    // Ticket-authenticated stream: scope dna_job:<id>, folded live events.
    await waitFor(() => expect(FakeEventSource.instances.length).toBe(1));
    const mint = calls.find((call) => call.url === '/api/auth/stream-ticket');
    expect(mint?.body).toEqual({ scope: 'dna_job:job-1' });

    const source = FakeEventSource.instances[0];
    act(() => {
      source.open();
      source.emit('status', JSON.stringify({ jobId: 'job-1', status: 'processing', progress: 40 }));
    });
    expect(await screen.findByText(/40%/)).toBeDefined();

    const listCallCount = () => calls.filter((call) => call.method === 'GET' && pathnameOf(call) === '/api/hope/admin/dna-writing-styles').length;
    const listCallsBefore = listCallCount();

    act(() => source.emit('result', JSON.stringify({ reportId: 'rep-9' })));

    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('DNA report generated'));
    expect(await screen.findByText('Done')).toBeDefined();
    expect(screen.getByText(/100%/)).toBeDefined();
    // Terminal result closes the single-use stream and refreshes the grid.
    expect(source.closed).toBe(true);
    await waitFor(() => expect(listCallCount()).toBeGreaterThan(listCallsBefore));
  });
});
