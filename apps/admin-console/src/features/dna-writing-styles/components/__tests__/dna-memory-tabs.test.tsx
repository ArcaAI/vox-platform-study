/**
 * TASK-1034 — "DNA Writing Style Memory" screen: Reports / Memory / Ingest / Schedule tabs.
 * fetch is stubbed at the BFF boundary; contract shapes from the ticket §4b.
 */

import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { toast } from 'sonner';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '@/test/render';
import type { DnaMemorySample, DnaMemorySummaryRow, DnaSchedule } from '../../api/types';
import { DnaWritingStylesScreen } from '../dna-writing-styles-screen';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

interface RecordedCall {
  url: string;
  method: string;
  body: unknown;
}
type FetchHandler = (call: RecordedCall) => Response | undefined;

const SUMMARY: DnaMemorySummaryRow[] = [
  {
    doctorId: 'doc-1',
    username: 'dr.house',
    displayName: 'Gregory House',
    total: 7,
    unconsumed: 4,
    bySource: { EDIT: 3, SIGNOFF: 2, INGEST: 2 },
    lastSampleAt: '2026-09-30T10:00:00.000Z',
    lastReportAt: '2026-09-20T10:00:00.000Z',
    latestReportId: 'rep-1',
    dnaEnabled: true,
  },
  {
    doctorId: 'doc-2',
    username: 'dr.wilson',
    displayName: null,
    total: 1,
    unconsumed: 1,
    bySource: { EDIT: 0, SIGNOFF: 0, INGEST: 1 },
    lastSampleAt: '2026-09-29T10:00:00.000Z',
    lastReportAt: null,
    latestReportId: null,
    dnaEnabled: false,
  },
];

const SAMPLES: DnaMemorySample[] = [
  {
    id: 's-1',
    doctorId: 'doc-1',
    source: 'EDIT',
    kind: 'CASE_NOTE',
    writtenAt: '2026-09-30T10:00:00.000Z',
    sourceRef: null,
    consultationId: 'c-1',
    consumed: false,
    consumedByReportId: null,
    preview: 'Patient [NAME] reports mild headache.',
    createdAt: '2026-09-30T10:00:00.000Z',
  },
];

const SCHEDULE: DnaSchedule = {
  enabled: true,
  cron: '0 2 * * 1',
  minNewSamples: 3,
  timeZone: 'Asia/Kolkata',
  nextRunAt: '2026-10-05T20:30:00.000Z',
  lastRun: { at: '2026-09-28T20:30:00.000Z', queued: 2, skipped: { noFeedback: 5, optedOut: 1, quota: 0, belowFloor: 3 } },
};

function session() {
  const user = { id: 'u-1', username: 'g_admin', email: 'g@hope.local', roles: ['SUPER_ADMIN'] };
  return {
    user,
    isElevated: true,
    workingTenantId: 'tnt-1',
    workingTenantName: 'Sunrise',
    impersonatingUserId: null,
    impersonatingUsername: null,
    effectiveUser: { ...user, tenantId: null, departmentId: null },
    effectiveIsElevated: true,
    effectiveTenantId: 'tnt-1',
  };
}

const pathOf = (call: RecordedCall) => new URL(call.url, 'http://test.local').pathname;

function defaults(call: RecordedCall): Response | undefined {
  const path = pathOf(call);
  if (call.url.includes('/users/me/settings')) return call.method === 'GET' ? Response.json([]) : Response.json({ ok: true });
  if (path === '/api/auth/session') return Response.json(session());
  if (call.method !== 'GET') return undefined;
  if (path === '/api/hope/admin/dna-writing-styles') return Response.json({ data: [], count: 0, limit: 25, page: 1 });
  if (path === '/api/hope/admin/dna-writing-styles/dashboard') {
    return Response.json({ usersWithStyle: 0, avgVersions: 0, recentActivity: { dailyCounts: [], latest: [], total: 0, windowDays: 30 } });
  }
  if (path === '/api/hope/admin/dna-writing-styles/memory/summary') return Response.json(SUMMARY);
  if (path === '/api/hope/admin/dna-writing-styles/memory') return Response.json({ data: SAMPLES, count: 1, limit: 20, page: 1 });
  if (path === '/api/hope/admin/dna-writing-styles/schedule') return Response.json(SCHEDULE);
  return undefined;
}

function stub(custom: FetchHandler = () => undefined): RecordedCall[] {
  const calls: RecordedCall[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const call = { url: String(input), method: init?.method ?? 'GET', body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined };
      calls.push(call);
      const response = custom(call) ?? defaults(call);
      if (!response) throw new Error(`Unhandled fetch: ${call.method} ${call.url}`);
      return response;
    }),
  );
  return calls;
}

class NoopEventSource {
  addEventListener() {}
  close() {}
}

beforeEach(() => vi.stubGlobal('EventSource', NoopEventSource));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('DNA Writing Style Memory — tabs', () => {
  it('renames the page and shows the four line tabs, Reports first', async () => {
    stub();
    renderWithProviders(<DnaWritingStylesScreen />);
    expect(await screen.findByRole('heading', { level: 1, name: 'DNA Writing Style Memory' })).toBeDefined();
    const tabs = (await screen.findAllByRole('tab')).map((tab) => tab.textContent);
    expect(tabs).toEqual(['Reports', 'Memory', 'Ingest', 'Schedule']);
    expect(screen.getByRole('tab', { name: 'Reports' }).getAttribute('aria-selected')).toBe('true');
  });

  it('switches to Memory by clicking the tab', async () => {
    stub();
    renderWithProviders(<DnaWritingStylesScreen />);
    const tab = await screen.findByRole('tab', { name: 'Memory' });
    fireEvent.mouseDown(tab);
    expect(await screen.findByText('Gregory House')).toBeDefined();
  });
});

describe('Memory tab', () => {
  it('renders the per-clinician summary with source counts and the DNA badge', async () => {
    stub();
    renderWithProviders(<DnaWritingStylesScreen />, { searchParams: '?tab=memory' });
    expect(await screen.findByText('Gregory House')).toBeDefined();
    expect(screen.getByText('dr.wilson')).toBeDefined();
    expect(screen.getByText('EDIT 3 · SIGNOFF 2 · INGEST 2')).toBeDefined();
    expect(screen.getByText('DNA on')).toBeDefined();
    expect(screen.getByText('DNA off')).toBeDefined();
  });

  it('shows an empty state when no clinician has memory', async () => {
    stub((call) => (pathOf(call) === '/api/hope/admin/dna-writing-styles/memory/summary' ? Response.json([]) : undefined));
    renderWithProviders(<DnaWritingStylesScreen />, { searchParams: '?tab=memory' });
    expect(await screen.findByText('No writing-style memory yet')).toBeDefined();
  });

  it('shows an error state when the summary fails', async () => {
    stub((call) =>
      pathOf(call) === '/api/hope/admin/dna-writing-styles/memory/summary' ? Response.json({ message: 'boom' }, { status: 500 }) : undefined,
    );
    renderWithProviders(<DnaWritingStylesScreen />, { searchParams: '?tab=memory' });
    expect(await screen.findByRole('button', { name: /retry/i })).toBeDefined();
  });

  it('opens a clinician drawer with redacted previews and soft-deletes a sample after confirming', async () => {
    const calls = stub((call) =>
      call.method === 'DELETE' && pathOf(call) === '/api/hope/admin/dna-writing-styles/memory/s-1' ? new Response(null, { status: 204 }) : undefined,
    );
    renderWithProviders(<DnaWritingStylesScreen />, { searchParams: '?tab=memory' });
    fireEvent.click(await screen.findByText('Gregory House'));

    const drawer = await screen.findByRole('dialog');
    expect(await within(drawer).findByText('Patient [NAME] reports mild headache.')).toBeDefined();
    expect(calls.some((call) => call.url.includes('/memory?doctorId=doc-1'))).toBe(true);

    fireEvent.click(within(drawer).getByRole('button', { name: /delete sample s-1/i }));
    const confirm = await screen.findByRole('alertdialog');
    fireEvent.click(within(confirm).getByRole('button', { name: /delete sample/i }));

    await waitFor(() => expect(calls.some((call) => call.method === 'DELETE')).toBe(true));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Memory sample deleted'));
  });
});

describe('Ingest tab', () => {
  it('parses a CSV, previews it and submits with clinicianUserId + generate, then shows stored/duplicates', async () => {
    const calls = stub((call) => {
      const path = pathOf(call);
      if (call.method === 'POST' && path === '/api/hope/dna-writing-styles/ingest') {
        return Response.json(
          { jobId: 'ij-1', status: 'PENDING', clinicianUserId: 'doc-1', acceptedItems: 2, stored: 1, duplicates: 1 },
          { status: 202 },
        );
      }
      if (path === '/api/hope/dna-writing-styles/ingest/jobs/ij-1') return Response.json({ jobId: 'ij-1', status: 'completed', progress: 100 });
      return undefined;
    });
    renderWithProviders(<DnaWritingStylesScreen />, { searchParams: '?tab=ingest' });

    const picker = (await screen.findByLabelText(/clinician/i)) as HTMLSelectElement;
    await screen.findByRole('option', { name: /Gregory House/ });
    fireEvent.change(picker, { target: { value: 'doc-1' } });

    const csv = 'text,writtenAt\n"First, note",2026-09-01T09:30:00.000Z\nSecond,2026-09-02T09:30:00.000Z\n';
    fireEvent.change(screen.getByLabelText(/files/i), { target: { files: [new File([csv], 'notes.csv')] } });
    expect(await screen.findByText('First, note')).toBeDefined();
    expect(screen.getByRole('heading', { name: /Preview · 2 samples/ })).toBeDefined();

    fireEvent.click(screen.getByRole('switch', { name: /generate report now/i }));
    fireEvent.click(screen.getByRole('button', { name: /ingest 2 samples/i }));

    expect(await screen.findByText(/1 stored/)).toBeDefined();
    expect(screen.getByText(/1 duplicate/)).toBeDefined();
    const post = calls.find((call) => call.method === 'POST');
    expect(post?.body).toEqual({
      clinicianUserId: 'doc-1',
      generate: false,
      items: [
        { text: 'First, note', writtenAt: '2026-09-01T09:30:00.000Z' },
        { text: 'Second', writtenAt: '2026-09-02T09:30:00.000Z' },
      ],
    });
  });

  it('blocks submit and lists row errors for invalid rows', async () => {
    stub();
    renderWithProviders(<DnaWritingStylesScreen />, { searchParams: '?tab=ingest' });
    const picker = (await screen.findByLabelText(/clinician/i)) as HTMLSelectElement;
    await screen.findByRole('option', { name: /Gregory House/ });
    fireEvent.change(picker, { target: { value: 'doc-1' } });
    fireEvent.change(screen.getByLabelText(/files/i), {
      target: { files: [new File([JSON.stringify([{ text: 'x', writtenAt: 'yesterday' }])], 'bad.json')] },
    });
    expect(await screen.findByText(/ISO-8601/)).toBeDefined();
    expect((screen.getByRole('button', { name: /ingest 1 sample/i }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('Schedule tab', () => {
  it('shows the schedule with a readable cron hint, zone, next run and last-run breakdown', async () => {
    stub();
    renderWithProviders(<DnaWritingStylesScreen />, { searchParams: '?tab=schedule' });
    expect(await screen.findByDisplayValue('0 2 * * 1')).toBeDefined();
    expect(screen.getByText('Every Monday at 02:00')).toBeDefined();
    expect(screen.getByText('Asia/Kolkata')).toBeDefined();
    expect(screen.getByText(/2 queued/)).toBeDefined();
    expect(screen.getByText(/no feedback 5/i)).toBeDefined();
    expect(screen.getByText(/below floor 3/i)).toBeDefined();
  });

  it('saves the form with PUT', async () => {
    const calls = stub((call) => (call.method === 'PUT' ? Response.json({ ...SCHEDULE, minNewSamples: 5 }) : undefined));
    renderWithProviders(<DnaWritingStylesScreen />, { searchParams: '?tab=schedule' });
    const min = (await screen.findByLabelText(/minimum new samples/i)) as HTMLInputElement;
    fireEvent.change(min, { target: { value: '5' } });
    fireEvent.click(screen.getByRole('button', { name: /save schedule/i }));
    await waitFor(() => expect(calls.find((call) => call.method === 'PUT')?.body).toEqual({ enabled: true, cron: '0 2 * * 1', minNewSamples: 5 }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Schedule saved'));
  });

  it('"Run now" confirms, posts and toasts the result', async () => {
    const calls = stub((call) =>
      call.method === 'POST' && pathOf(call) === '/api/hope/admin/dna-writing-styles/schedule/run'
        ? Response.json({ queued: 3, skipped: { noFeedback: 2, optedOut: 0, quota: 0, belowFloor: 1 }, jobs: [] })
        : undefined,
    );
    renderWithProviders(<DnaWritingStylesScreen />, { searchParams: '?tab=schedule' });
    fireEvent.click(await screen.findByRole('button', { name: /run now/i }));
    const confirm = await screen.findByRole('alertdialog');
    fireEvent.click(within(confirm).getByRole('button', { name: /run now/i }));
    await waitFor(() => expect(calls.some((call) => call.method === 'POST')).toBe(true));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Regeneration run: 3 queued, 3 skipped'));
  });
});
