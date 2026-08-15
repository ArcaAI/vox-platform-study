/**
 * Frame 53 — My DNA Writing Style (playground SELF plane, matrix row 37).
 * fetch is stubbed at the network boundary (BFF session + gateway proxy
 * paths) and EventSource is stubbed globally where the generate flow mounts
 * the job stream. Covers the working-tenant gate, the impersonation GATE-403
 * panel (proactive from the session AND reactive on an API 403), the
 * my-style 404 empty state, the If-Match OCC PATCH with the 412 conflict
 * notice, set-default + version timeline, the generate -> SSE progress flow
 * and the settings toggle PUT.
 */

import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { toast } from 'sonner';
import { axe } from 'vitest-axe';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '@/test/render';
import type { DnaReport, DnaSettings, DnaVersion } from '../../api/types';
import { MyDnaStyleScreen } from '../my-dna-style-screen';

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
    doctorUsername: 'dr.house',
    styleText: 'Formal, concise clinical prose.',
    isLatest: true,
    currentVersionNumber: 3,
    createdAt: '2026-07-01T10:00:00.000Z',
    updatedAt: '2026-07-01T10:00:00.000Z',
    resourceStatus: 'ENABLED',
    version: 3,
    ...overrides,
  };
}

const MINE: DnaReport[] = [
  report(),
  report({
    id: 'rep-0',
    currentVersionNumber: 1,
    isLatest: false,
    version: 1,
    createdAt: '2026-06-02T10:00:00.000Z',
    updatedAt: '2026-06-02T10:00:00.000Z',
  }),
];

const SETTINGS: DnaSettings = { doctorToggle: true, tenantEnabled: true, effective: true, version: 2 };

const REDACTION_RULES = { rules: [{ id: 'rr-1', type: 'remove', match: 'literal', pattern: "patient's employer" }] };

const VERSIONS: DnaVersion[] = [
  { id: 'ver-3', dnaReportId: 'rep-1', versionNumber: 3, changeReason: 'manual edit', changedBy: 'u-9', createdAt: '2026-07-01T10:00:00.000Z' },
  { id: 'ver-2', dnaReportId: 'rep-1', versionNumber: 2, createdAt: '2026-06-18T10:00:00.000Z' },
];

const OLD_VERSIONS: DnaVersion[] = [
  { id: 'ver-1', dnaReportId: 'rep-0', versionNumber: 1, changeReason: 'first pass', createdAt: '2026-06-02T10:00:00.000Z' },
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

/**
 * Default session: an elevated admin IMPERSONATING a doctor (doctor context
 * active, so generate + toggle are usable). Gate tests override
 * impersonatingUserId to null.
 */
function session(overrides: Partial<Record<string, unknown>> = {}) {
  const base = {
    user: { id: 'u-1', username: 'g_admin', email: 'g_admin@hope.local', roles: ['SUPER_ADMIN'], tenantId: null },
    isElevated: true,
    workingTenantId: 'tnt-1',
    workingTenantName: 'Sunrise Medical Group',
    impersonatingUserId: 'doc-1',
    impersonatingUsername: 'dr.house',
    ...overrides,
  };
  // WorkingTenantGate now reads the effective identity; mirror the
  // (possibly overridden) operator fields since these fixtures never impersonate.
  return {
    ...base,
    effectiveUser: { ...base.user, departmentId: null },
    effectiveIsElevated: base.isElevated,
    effectiveTenantId: base.workingTenantId,
  };
}

function pathnameOf(call: RecordedCall): string {
  return new URL(call.url, 'http://test.local').pathname;
}

/** Read/write paths through the proxy that every test starts from. */
function defaultHandler(call: RecordedCall): Response | undefined {
  const path = pathnameOf(call);
  if (call.method === 'POST' && path === '/api/auth/stream-ticket') {
    return Response.json({ ticket: 'tkt-1', expiresAt: Date.now() + 30_000, scope: 'dna_job:job-1' });
  }
  if (call.method === 'POST' && path === '/api/hope/dna-writing-styles/generate') {
    return Response.json({ jobId: 'job-1', status: 'queued' });
  }
  if (call.method !== 'GET') return undefined;
  if (path === '/api/auth/session') return Response.json(session());
  if (path === '/api/hope/dna-writing-styles/my-style') {
    return Response.json(report(), { headers: { etag: '"3"' } });
  }
  if (path === '/api/hope/dna-writing-styles/mine') return Response.json(MINE);
  if (path === '/api/hope/dna-writing-styles/my-style/redaction-rules') return Response.json(REDACTION_RULES);
  if (path === '/api/hope/dna-writing-styles/settings') return Response.json(SETTINGS);
  if (path === '/api/hope/dna-writing-styles/rep-1/versions') return Response.json(VERSIONS);
  if (path === '/api/hope/dna-writing-styles/rep-0/versions') return Response.json(OLD_VERSIONS);
  if (path === '/api/hope/dna-writing-styles/jobs/job-1') {
    return Response.json({ jobId: 'job-1', status: 'processing', progress: 10 });
  }
  return undefined;
}

function stubDna(custom: FetchHandler = () => undefined): RecordedCall[] {
  return stubFetch((call) => custom(call) ?? defaultHandler(call));
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

describe('MyDnaStyleScreen', () => {
  it('asks an elevated session without a working tenant to pick one (no data queries fired)', async () => {
    const calls = stubDna((call) => {
      if (pathnameOf(call) === '/api/auth/session') return Response.json(session({ workingTenantId: null }));
      return undefined;
    });
    renderWithProviders(<MyDnaStyleScreen />);

    expect(await screen.findByText('Select a working tenant')).toBeDefined();
    expect(screen.getByRole('heading', { level: 1, name: 'My DNA Writing Style' })).toBeDefined();
    expect(calls.every((call) => !call.url.includes('/dna-writing-styles'))).toBe(true);
  });

  it('keeps the layout skeleton while the session is in flight', () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>(() => {})),
    );
    const { container } = renderWithProviders(<MyDnaStyleScreen />);

    expect(container.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(0);
  });

  it('renders my style, the report list with the version timeline and the DNA chip (doctor context active)', async () => {
    stubDna();
    renderWithProviders(<MyDnaStyleScreen />);

    // My-style card: style text + history counter + default + DNA chip.
    expect(await screen.findByText('Formal, concise clinical prose.')).toBeDefined();
    expect(screen.getAllByText('v3').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('Default').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('DNA ON')).toBeDefined();

    // Report list from GET /mine: both rows, set-default only on the non-default.
    expect(await screen.findByText('rep-0')).toBeDefined();
    expect(screen.getAllByText('rep-1').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByRole('button', { name: 'Set rep-0 as default' })).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Set rep-1 as default' })).toBeNull();

    // Version history auto-follows the my-style report, newest first.
    const timeline = await screen.findByRole('list', { name: 'Version history' });
    const items = within(timeline).getAllByRole('listitem');
    expect(items[0].textContent).toContain('v3');
    expect(items[0].textContent).toContain('manual edit');
    expect(items[1].textContent).toContain('v2');

    // Doctor context is active (impersonation), so no gate panel and the
    // generate action is enabled.
    expect(screen.queryByText('Impersonation gate')).toBeNull();
    expect(screen.getByText(/acting as dr\.house/i)).toBeDefined();
    const generate = screen.getByRole('button', { name: 'Generate my style' }) as HTMLButtonElement;
    expect(generate.disabled).toBe(false);
  });

  it('renders the designed empty state when my-style is 404 (not an error)', async () => {
    stubDna((call) => {
      const path = pathnameOf(call);
      if (call.method === 'GET' && path === '/api/hope/dna-writing-styles/my-style') {
        return Response.json({ message: 'No DNA writing style found for current user', statusCode: 404 }, { status: 404 });
      }
      if (call.method === 'GET' && path === '/api/hope/dna-writing-styles/mine') return Response.json([]);
      return undefined;
    });
    renderWithProviders(<MyDnaStyleScreen />);

    expect(await screen.findByText('No DNA style yet')).toBeDefined();
    // Designed state: no error card, no toast.
    expect(screen.queryByRole('alert')).toBeNull();
    expect(toast.error).not.toHaveBeenCalled();
    // The empty-state CTA generates (doctor context active in this session).
    const ctas = screen.getAllByRole('button', { name: 'Generate my style' }) as HTMLButtonElement[];
    expect(ctas.some((button) => !button.disabled)).toBe(true);
  });

  it('shows the GATE 403 panel proactively for a non-impersonating admin and disables the gated actions', async () => {
    stubDna((call) => {
      if (pathnameOf(call) === '/api/auth/session') {
        return Response.json(session({ impersonatingUserId: null, impersonatingUsername: null }));
      }
      return undefined;
    });
    renderWithProviders(<MyDnaStyleScreen />);

    // The gate panel is a designed state with its 403 indicator + warning.
    expect(await screen.findByText('Impersonation gate')).toBeDefined();
    expect(screen.getByText('GATE 403')).toBeDefined();
    expect(screen.getByText(/generate & dna toggle return 403 unless acting as a doctor/i)).toBeDefined();

    // Impersonation starts on the Users admin screen.
    const link = screen.getByRole('link', { name: /act as a doctor/i }) as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('/users');

    // Read surfaces stay live while the mutations are gated.
    expect(await screen.findByText('Formal, concise clinical prose.')).toBeDefined();
    const generate = screen.getByRole('button', { name: 'Generate my style' }) as HTMLButtonElement;
    expect(generate.disabled).toBe(true);
    await waitFor(() => expect((screen.getByRole('switch', { name: 'Use my DNA style' }) as HTMLButtonElement).disabled).toBe(true));
  });

  it('drops into the gate state reactively when generate answers 403 (no error toast)', async () => {
    stubDna((call) => {
      if (call.method === 'POST' && pathnameOf(call) === '/api/hope/dna-writing-styles/generate') {
        return Response.json({ message: 'Impersonate a doctor to generate a style.', statusCode: 403 }, { status: 403 });
      }
      return undefined;
    });
    renderWithProviders(<MyDnaStyleScreen />);

    const generate = (await screen.findByRole('button', { name: 'Generate my style' })) as HTMLButtonElement;
    await waitFor(() => expect(generate.disabled).toBe(false));
    fireEvent.click(generate);

    // The designed gate state renders instead of a failure toast.
    expect(await screen.findByText('Impersonation gate')).toBeDefined();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('edits my style through the If-Match OCC PATCH', async () => {
    const calls = stubDna((call) => {
      if (call.method === 'PATCH' && pathnameOf(call) === '/api/hope/dna-writing-styles/rep-1') {
        return Response.json(report({ version: 4 }), { headers: { etag: '"4"' } });
      }
      return undefined;
    });
    renderWithProviders(<MyDnaStyleScreen />);

    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByLabelText('Style text'), { target: { value: 'Adjusted clinical prose.' } });
    fireEvent.change(screen.getByLabelText('Edit reason'), { target: { value: 'tone fix' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save style' }));

    await waitFor(() => {
      const patch = calls.find((call) => call.method === 'PATCH');
      expect(patch?.url).toBe('/api/hope/dna-writing-styles/rep-1');
      expect(patch?.headers.get('if-match')).toBe('"3"');
      expect(patch?.body).toEqual({ styleText: 'Adjusted clinical prose.', changeReason: 'tone fix', expectedVersion: 3 });
    });
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Style updated'));
  });

  it('surfaces a 412 version drift as a non-destructive conflict notice with a reload affordance', async () => {
    const calls = stubDna((call) => {
      if (call.method === 'PATCH' && pathnameOf(call) === '/api/hope/dna-writing-styles/rep-1') {
        return Response.json({ message: 'Version mismatch', statusCode: 412 }, { status: 412 });
      }
      return undefined;
    });
    renderWithProviders(<MyDnaStyleScreen />);

    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByLabelText('Style text'), { target: { value: 'Draft to keep.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save style' }));

    expect(await screen.findByText(/412 precondition failed/i)).toBeDefined();
    // Non-destructive: the draft stays in the editor.
    expect((screen.getByLabelText('Style text') as HTMLTextAreaElement).value).toBe('Draft to keep.');

    const myStyleReads = () => calls.filter((call) => call.method === 'GET' && pathnameOf(call) === '/api/hope/dna-writing-styles/my-style').length;
    const readsBefore = myStyleReads();
    fireEvent.click(screen.getByRole('button', { name: 'Reload latest' }));
    await waitFor(() => expect(myStyleReads()).toBeGreaterThan(readsBefore));
  });

  it('sets another report as default and follows a row selection into its version timeline', async () => {
    const calls = stubDna((call) => {
      if (call.method === 'PATCH' && pathnameOf(call) === '/api/hope/dna-writing-styles/rep-0/default') {
        return Response.json(report({ id: 'rep-0', isLatest: true, currentVersionNumber: 1, version: 2 }));
      }
      return undefined;
    });
    renderWithProviders(<MyDnaStyleScreen />);

    // Selecting a row re-targets the timeline (GET rep-0/versions).
    fireEvent.click(await screen.findByRole('button', { name: 'Show versions of rep-0' }));
    const timeline = await screen.findByRole('list', { name: 'Version history' });
    await waitFor(() => expect(within(timeline).getAllByRole('listitem')[0].textContent).toContain('first pass'));

    fireEvent.click(screen.getByRole('button', { name: 'Set rep-0 as default' }));
    await waitFor(() =>
      expect(calls.some((call) => call.method === 'PATCH' && pathnameOf(call) === '/api/hope/dna-writing-styles/rep-0/default')).toBe(true),
    );
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Default report updated'));
  });

  it('generates from text samples: POST -> SSE progress -> terminal result refreshes my-style', async () => {
    const calls = stubDna();
    renderWithProviders(<MyDnaStyleScreen />);

    const samples = await screen.findByLabelText('Text samples');
    fireEvent.change(samples, { target: { value: 'Sample one.\n\nSample two.' } });
    const generate = screen.getByRole('button', { name: 'Generate my style' }) as HTMLButtonElement;
    await waitFor(() => expect(generate.disabled).toBe(false));
    fireEvent.click(generate);

    // Blank-line-separated blocks become individual textSamples.
    await waitFor(() => {
      const post = calls.find((call) => call.method === 'POST' && pathnameOf(call) === '/api/hope/dna-writing-styles/generate');
      expect(post?.body).toEqual({ textSamples: ['Sample one.', 'Sample two.'] });
    });

    // The progress strip mounts, driven by the ticket-authenticated stream.
    expect(await screen.findByRole('progressbar')).toBeDefined();
    expect(screen.getByText('job-1')).toBeDefined();
    await waitFor(() => expect(FakeEventSource.instances.length).toBe(1));
    const mint = calls.find((call) => call.url === '/api/auth/stream-ticket');
    expect(mint?.body).toEqual({ scope: 'dna_job:job-1' });
    expect(FakeEventSource.instances[0].url).toContain('/api/v1/dna-writing-styles/jobs/job-1/stream?ticket=');

    const source = FakeEventSource.instances[0];
    act(() => {
      source.open();
      source.emit('status', JSON.stringify({ jobId: 'job-1', status: 'processing', progress: 40 }));
    });
    expect(await screen.findByText(/40%/)).toBeDefined();

    const myStyleReads = () => calls.filter((call) => call.method === 'GET' && pathnameOf(call) === '/api/hope/dna-writing-styles/my-style').length;
    const readsBefore = myStyleReads();

    act(() => source.emit('result', JSON.stringify({ reportId: 'rep-9' })));

    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('DNA style generated'));
    expect(await screen.findByText('Done')).toBeDefined();
    expect(screen.getByText(/100%/)).toBeDefined();
    // Terminal result closes the single-use stream and refreshes the reads.
    expect(source.closed).toBe(true);
    await waitFor(() => expect(myStyleReads()).toBeGreaterThan(readsBefore));
  });

  // ─── redaction rules editor ───────────────────────────────

  it('renders the doctor’s existing redaction rule from GET /my-style/redaction-rules', async () => {
    stubDna();
    renderWithProviders(<MyDnaStyleScreen />);

    expect(await screen.findByRole('heading', { name: 'Redaction rules' })).toBeDefined();
    // Rule seeded ⇒ the enable switch is on and the pattern is shown.
    const toggle = (await screen.findByRole('switch', { name: 'Enable redaction rules' })) as HTMLButtonElement;
    await waitFor(() => expect(toggle.getAttribute('data-state')).toBe('checked'));
    expect((screen.getByLabelText('Pattern') as HTMLInputElement).value).toBe("patient's employer");
  });

  it('adds a rule and saves it via the report PATCH redactionRules field (If-Match OCC)', async () => {
    const calls = stubDna((call) => {
      if (call.method === 'GET' && pathnameOf(call) === '/api/hope/dna-writing-styles/my-style/redaction-rules') {
        // Start from an empty set so the editor exposes the "Add rule" CTA.
        return Response.json({ rules: [] });
      }
      if (call.method === 'PATCH' && pathnameOf(call) === '/api/hope/dna-writing-styles/rep-1') {
        return Response.json(report({ version: 4 }), { headers: { etag: '"4"' } });
      }
      return undefined;
    });
    renderWithProviders(<MyDnaStyleScreen />);

    // Empty set ⇒ toggle off; turn redaction on, then add + fill a rule.
    const toggle = (await screen.findByRole('switch', { name: 'Enable redaction rules' })) as HTMLButtonElement;
    await waitFor(() => expect(toggle.getAttribute('data-state')).toBe('unchecked'));
    fireEvent.click(toggle);

    fireEvent.click(await screen.findByRole('button', { name: 'Add rule' }));
    fireEvent.change(screen.getByLabelText('Pattern'), { target: { value: 'employer' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save rules' }));

    await waitFor(() => {
      const patch = calls.find((call) => call.method === 'PATCH' && pathnameOf(call) === '/api/hope/dna-writing-styles/rep-1');
      expect(patch?.headers.get('if-match')).toBe('"3"');
      const body = patch?.body as { redactionRules?: { rules?: Array<Record<string, unknown>> }; expectedVersion?: number };
      expect(body.expectedVersion).toBe(3);
      expect(body.redactionRules?.rules?.[0]).toMatchObject({ type: 'remove', match: 'literal', pattern: 'employer' });
    });
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Redaction rules saved'));
  });

  it('has no axe violations (light theme) with the redaction editor mounted', async () => {
    stubDna();
    const { container } = renderWithProviders(<MyDnaStyleScreen />);
    await screen.findByRole('heading', { name: 'Redaction rules' });
    await screen.findByLabelText('Pattern');
    expect(await axe(container)).toHaveNoViolations();
  });

  it('has no axe violations (dark theme) with the redaction editor mounted', async () => {
    document.documentElement.classList.add('dark');
    try {
      stubDna();
      const { container } = renderWithProviders(<MyDnaStyleScreen />);
      await screen.findByRole('heading', { name: 'Redaction rules' });
      await screen.findByLabelText('Pattern');
      expect(await axe(container)).toHaveNoViolations();
    } finally {
      document.documentElement.classList.remove('dark');
    }
  });

  it('binds the DNA switch to doctorToggle and PUTs the settings with the OCC version', async () => {
    const calls = stubDna((call) => {
      if (call.method === 'PUT' && pathnameOf(call) === '/api/hope/dna-writing-styles/settings') {
        return Response.json({ doctorToggle: false, tenantEnabled: true, effective: false, version: 3 });
      }
      return undefined;
    });
    renderWithProviders(<MyDnaStyleScreen />);

    const toggle = (await screen.findByRole('switch', { name: 'Use my DNA style' })) as HTMLButtonElement;
    await waitFor(() => expect(toggle.getAttribute('data-state')).toBe('checked'));
    fireEvent.click(toggle);

    await waitFor(() => {
      const put = calls.find((call) => call.method === 'PUT');
      expect(put?.url).toBe('/api/hope/dna-writing-styles/settings');
      // OCC: a DOCTOR row exists (version 2) so the PUT carries BOTH the
      // If-Match header and the body expectedVersion.
      expect(put?.headers.get('if-match')).toBe('"2"');
      expect(put?.body).toEqual({ enabled: false, expectedVersion: 2 });
    });
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('DNA settings updated'));
  });
});
