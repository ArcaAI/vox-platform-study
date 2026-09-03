/**
 * TDD screen tests for frame 39 (Pipeline Policy, post-consultation): matrix
 * render with inherit dashes, the cascade resolve winner highlight, the
 * row-editor PUT flow under If-Match OCC (including 412), the empty/NoTenant/
 * error states — against a URL-branching fetch stub covering the session route.
 */

import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { renderWithProviders } from '@/test/render';
import type { PipelinePolicyEffective, PipelinePolicyRow } from '../../api/types';
import { PipelinePolicyScreen } from '../pipeline-policy-screen';

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

const SYSTEM_TENANT_ID = '00000000-0000-0000-0000-000000000000';

function row(overrides: Partial<PipelinePolicyRow> = {}): PipelinePolicyRow {
  return {
    id: 'pp-1',
    tenantId: 'tnt-1',
    scope: 'TENANT',
    scopeId: null,
    source: 'tenant',
    autoSummaryEnabled: true,
    autoNerEnabled: null,
    harnessEnabled: null,
    dnaStyleEnabled: null,
    updatedAt: '2026-07-01T00:00:00.000Z',
    version: 4,
    ...overrides,
  };
}

function effective(overrides: Partial<PipelinePolicyEffective> = {}): PipelinePolicyEffective {
  return {
    tenantId: 'tnt-1',
    departmentId: null,
    doctorId: null,
    autoSummaryEnabled: true,
    autoNerEnabled: true,
    harnessEnabled: true,
    dnaStyleEnabled: false,
    trace: {
      autoSummaryEnabled: 'tenant',
      autoNerEnabled: 'system-default',
      harnessEnabled: 'system-default',
      dnaStyleEnabled: 'code-default',
    },
    ...overrides,
  };
}

const SYSTEM_ROW = row({
  id: 'pp-sys',
  tenantId: SYSTEM_TENANT_ID,
  autoSummaryEnabled: true,
  autoNerEnabled: true,
  harnessEnabled: true,
  version: 2,
});

const SESSION = {
  user: { id: 'u-1', username: 'super_admin', email: 'admin@arca.ai', roles: ['SUPER_ADMIN'] },
  isElevated: true,
  workingTenantId: 'tnt-1' as string | null,
  workingTenantName: 'Sunrise Medical Group' as string | null,
  impersonatingUserId: null,
  impersonatingUsername: null,
  // WorkingTenantGate now reads the effective identity; this
  // fixture never impersonates, so it mirrors the operator fields.
  effectiveUser: { id: 'u-1', username: 'super_admin', email: 'admin@arca.ai', roles: ['SUPER_ADMIN'], tenantId: null, departmentId: null },
  effectiveIsElevated: true,
  effectiveTenantId: 'tnt-1' as string | null,
};

// A non-elevated (tenant admin) session. `harnessEnabled` and
// `autoNerEnabled` became super-admin-only server-side, so this session must
// see them read-only.
const TENANT_ADMIN_SESSION = {
  ...SESSION,
  user: { ...SESSION.user, username: 'tenant_admin', roles: ['TENANT_ADMIN'] },
  isElevated: false,
  effectiveUser: { ...SESSION.effectiveUser, username: 'tenant_admin', roles: ['TENANT_ADMIN'] },
  effectiveIsElevated: false,
};

interface RecordedCall {
  url: string;
  method: string;
  headers: Headers;
  body: unknown;
}

interface StubOptions {
  session?: typeof SESSION;
  effectivePolicy?: PipelinePolicyEffective;
  tenantRow?: PipelinePolicyRow;
  custom?: (call: RecordedCall) => Response | undefined;
}

function rowResponse(payload: PipelinePolicyRow): Response {
  return Response.json(payload, { headers: payload.version > 0 ? { etag: `"${payload.version}"` } : {} });
}

function stubFetch({ session = SESSION, effectivePolicy = effective(), tenantRow = row(), custom }: StubOptions = {}): RecordedCall[] {
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
      const url = new URL(call.url, 'http://test');
      if (call.method === 'GET' && url.pathname === '/api/hope/admin/harness/pipeline-policy') {
        return Response.json(effectivePolicy);
      }
      if (call.method === 'GET' && url.pathname === '/api/hope/admin/harness/pipeline-policy/row') {
        if (url.searchParams.get('tenantId') === SYSTEM_TENANT_ID) return rowResponse(SYSTEM_ROW);
        return rowResponse(tenantRow);
      }
      throw new Error(`Unhandled fetch: ${call.method} ${call.url}`);
    }),
  );
  return calls;
}

function matrix(): HTMLElement {
  return screen.getByRole('table', { name: 'Pipeline policy scope rows' });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('PipelinePolicyScreen', () => {
  it('renders the cascade matrix with pins, inherit resolution and the resolve card', async () => {
    stubFetch();
    renderWithProviders(<PipelinePolicyScreen />);

    expect(screen.getByRole('heading', { level: 1, name: 'Pipeline Policy (Post-Consultation)' })).toBeDefined();
    const table = await waitFor(() => matrix());
    // F-23 / item 7: the screen must not read as a live-lane control.
    expect(screen.getByText('Post-consultation only')).toBeDefined();
    expect(screen.getByText(/do not affect live transcription/)).toBeDefined();
    const tenantRow = within(table).getByText('tenant').closest('tr') as HTMLElement;
    // Pinned at tenant: auto-sum on; inherited (show effective default On):
    // auto-NER resolves down from the SYSTEM pin.
    expect(within(tenantRow).getByText('on')).toBeDefined();
    expect(within(tenantRow).getAllByText(/\u00b7 inh/)).toHaveLength(2);
    // The SYSTEM row loads once the session reports the elevated flag.
    await waitFor(() => {
      const systemRow = within(matrix()).getByText('system').closest('tr') as HTMLElement;
      expect(within(systemRow).getByText('harness')).toBeDefined();
    });

    // Resolve card (default key auto-summary): tenant pin wins over system.
    const card = screen.getByLabelText('Cascade resolve for auto-summary');
    expect(within(card).getByText(/\u2190 wins/)).toBeDefined();
    expect(within(card).getByText(/EFFECTIVE on/)).toBeDefined();
    expect(screen.getByText(/= inherit from parent scope/)).toBeDefined();
  });

  it('has no axe violations with the status banner and the loaded matrix', async () => {
    stubFetch();
    const { container } = renderWithProviders(<PipelinePolicyScreen />);

    await waitFor(() => matrix());
    expect(screen.getByText('Post-consultation only')).toBeDefined();
    expect(await axe(container)).toHaveNoViolations();
  });

  it('marks the SYSTEM tier as the winner for a key without a tenant pin', async () => {
    stubFetch();
    renderWithProviders(<PipelinePolicyScreen />, { searchParams: '?key=routing' });

    const card = await screen.findByLabelText('Cascade resolve for routing');
    const winner = within(card)
      .getByText(/\u2190 wins/)
      .closest('p') as HTMLElement;
    expect(winner.textContent).toContain('system');
    expect(within(card).getByText(/EFFECTIVE harness/)).toBeDefined();
  });

  it('opens the scope editor from a real button, so the matrix is operable by keyboard', async () => {
    stubFetch();
    renderWithProviders(<PipelinePolicyScreen />);
    const table = await waitFor(() => matrix());

    // The row-wide onClick is a pointer affordance only; the scope cell must
    // carry a focusable control or the editor is mouse-only (WCAG 2.1.1).
    const scopeButton = within(table).getByRole('button', { name: 'tenant' });
    expect(scopeButton.tagName).toBe('BUTTON');
    expect(scopeButton.getAttribute('aria-pressed')).toBe('false');

    scopeButton.focus();
    expect(document.activeElement).toBe(scopeButton);
    fireEvent.click(scopeButton);

    expect(await screen.findByRole('radiogroup', { name: 'Auto-NER' })).toBeDefined();
    expect(within(matrix()).getByRole('button', { name: 'tenant' }).getAttribute('aria-pressed')).toBe('true');
    // The editor repeats the post-consultation scope at the point of action.
    expect(screen.getByText(/Post-consultation pipeline only/)).toBeDefined();
  });

  it('has no axe violations with the scope editor open (post-consultation note included)', async () => {
    stubFetch();
    const { container } = renderWithProviders(<PipelinePolicyScreen />);
    const table = await waitFor(() => matrix());

    fireEvent.click(within(table).getByText('tenant'));
    await screen.findByRole('radiogroup', { name: 'Auto-NER' });

    expect(await axe(container)).toHaveNoViolations();
  });

  it('PUTs a sparse row update with If-Match and expectedVersion from the read ETag', async () => {
    const calls = stubFetch({
      custom: (call) => {
        if (call.method === 'PUT') {
          return rowResponse(row({ autoNerEnabled: false, version: 5 }));
        }
        return undefined;
      },
    });
    renderWithProviders(<PipelinePolicyScreen />);
    const table = await waitFor(() => matrix());

    fireEvent.click(within(table).getByText('tenant'));
    const nerGroup = await screen.findByRole('radiogroup', { name: 'Auto-NER' });
    fireEvent.click(within(nerGroup).getByText('off'));
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'pause NER tenant-wide' } });
    expect(screen.getByText('Unsaved changes')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: /Save row · PUT/ }));

    await waitFor(() => expect(calls.some((call) => call.method === 'PUT')).toBe(true));
    const put = calls.find((call) => call.method === 'PUT');
    const url = new URL(put?.url ?? '', 'http://test');
    expect(url.pathname).toBe('/api/hope/admin/harness/pipeline-policy/row');
    expect(url.searchParams.get('scope')).toBe('TENANT');
    expect(put?.headers.get('if-match')).toBe('"4"');
    expect(put?.body).toEqual({ autoNerEnabled: false, reason: 'pause NER tenant-wide', expectedVersion: 4 });
  });

  it('recomputes the effective preview from the draft before saving', async () => {
    stubFetch();
    renderWithProviders(<PipelinePolicyScreen />);
    const table = await waitFor(() => matrix());

    fireEvent.click(within(table).getByText('tenant'));
    const preview = await screen.findByLabelText('Preview for tenant');
    expect(within(preview).getByText('on (tenant)')).toBeDefined();

    const summaryGroup = screen.getByRole('radiogroup', { name: 'Auto-summary' });
    fireEvent.click(within(summaryGroup).getByText('off'));
    expect(within(preview).getByText('off (tenant)')).toBeDefined();

    // Clearing the pin falls back to the SYSTEM tier value (auto-NER
    // resolves from system too, so scope the assertion to the line).
    fireEvent.click(within(summaryGroup).getByText(/Inherit/));
    const summaryLine = within(preview).getByText('auto-summary').closest('div') as HTMLElement;
    expect(summaryLine.textContent).toContain('on (system)');
  });

  it('shows the OCC conflict alert and keeps drafts when the PUT returns 412', async () => {
    stubFetch({
      custom: (call) => {
        if (call.method === 'PUT') return Response.json({ message: 'Precondition Failed' }, { status: 412 });
        return undefined;
      },
    });
    renderWithProviders(<PipelinePolicyScreen />);
    const table = await waitFor(() => matrix());

    fireEvent.click(within(table).getByText('tenant'));
    const nerGroup = await screen.findByRole('radiogroup', { name: 'Auto-NER' });
    fireEvent.click(within(nerGroup).getByText('off'));
    fireEvent.click(screen.getByRole('button', { name: /Save row · PUT/ }));

    expect(await screen.findByText(/412 Precondition Failed/)).toBeDefined();
    expect(screen.getByRole('button', { name: 'Reload latest' })).toBeDefined();
    // The draft pin is kept for the reload-merge.
    expect(within(nerGroup).getByText('off').getAttribute('data-state')).toBe('on');
  });

  it('disables the routing pin at DOCTOR scope (registered max scope DEPARTMENT)', async () => {
    stubFetch({
      custom: (call) => {
        const url = new URL(call.url, 'http://test');
        if (url.pathname.endsWith('/row') && url.searchParams.get('scope') === 'DOCTOR') {
          return rowResponse(row({ id: null, scope: 'DOCTOR', scopeId: 'dr-lee', source: 'code-default', autoSummaryEnabled: null, version: 0 }));
        }
        return undefined;
      },
    });
    renderWithProviders(<PipelinePolicyScreen />, { searchParams: '?doctor=dr-lee' });
    const table = await waitFor(() => matrix());

    fireEvent.click(within(table).getByText('doctor dr-lee'));
    const routingGroup = await screen.findByRole('radiogroup', { name: 'Harness routing' });
    expect((within(routingGroup).getByText('harness') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/max scope DEPARTMENT/)).toBeDefined();
  });

  /**
   * The two governed toggles are super-admin-only in
   * `PipelinePolicyService.upsertRow` (descriptor `globalOnly`). A tenant
   * admin sees them, and their pinned values, but cannot edit them.
   */
  describe('E3-L2 locked pipeline toggles', () => {
    it.each([
      ['Harness routing', 'harness'],
      ['Auto-NER', 'off'],
    ])('disables the %s pin for a non-elevated session', async (label, option) => {
      stubFetch({ session: TENANT_ADMIN_SESSION });
      renderWithProviders(<PipelinePolicyScreen />);
      const table = await waitFor(() => matrix());

      fireEvent.click(within(table).getByText('tenant'));
      const group = await screen.findByRole('radiogroup', { name: label });
      expect((within(group).getByText(option) as HTMLButtonElement).disabled).toBe(true);
    });

    it('explains why, and leaves auto-summary editable for the same session', async () => {
      stubFetch({ session: TENANT_ADMIN_SESSION });
      renderWithProviders(<PipelinePolicyScreen />);
      const table = await waitFor(() => matrix());

      fireEvent.click(within(table).getByText('tenant'));
      const summary = await screen.findByRole('radiogroup', { name: 'Auto-summary' });
      expect((within(summary).getByText('off') as HTMLButtonElement).disabled).toBe(false);
      expect(screen.getAllByText('Super Admins only')).toHaveLength(2);
    });

    it('keeps both pins editable for an elevated session', async () => {
      stubFetch();
      renderWithProviders(<PipelinePolicyScreen />);
      const table = await waitFor(() => matrix());

      fireEvent.click(within(table).getByText('tenant'));
      const routing = await screen.findByRole('radiogroup', { name: 'Harness routing' });
      expect((within(routing).getByText('harness') as HTMLButtonElement).disabled).toBe(false);
      expect(screen.queryByText('Super Admins only')).toBeNull();
    });
  });

  it('shows the empty state with the add-scope-row CTA when nothing is pinned anywhere', async () => {
    stubFetch({
      tenantRow: row({ id: null, source: 'code-default', autoSummaryEnabled: null, version: 0 }),
      effectivePolicy: effective({
        autoSummaryEnabled: true,
        trace: {
          autoSummaryEnabled: 'system-default',
          autoNerEnabled: 'system-default',
          harnessEnabled: 'system-default',
          dnaStyleEnabled: 'code-default',
        },
      }),
    });
    renderWithProviders(<PipelinePolicyScreen />);

    expect(await screen.findByText('No scope overrides yet')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Add scope row' }));
    // The CTA opens the TENANT row editor over the matrix.
    expect(await screen.findByRole('radiogroup', { name: 'Auto-summary' })).toBeDefined();
    expect(matrix()).toBeDefined();
  });

  it('gates an elevated session without a working tenant behind the NoTenant empty state', async () => {
    stubFetch({ session: { ...SESSION, workingTenantId: null, workingTenantName: null, effectiveTenantId: null } });
    renderWithProviders(<PipelinePolicyScreen />);

    expect(await screen.findByText('Select a working tenant')).toBeDefined();
    expect(screen.getByRole('heading', { level: 1, name: 'Pipeline Policy (Post-Consultation)' })).toBeDefined();
    expect(screen.queryByRole('table', { name: 'Pipeline policy scope rows' })).toBeNull();
  });

  it('surfaces a block error with retry when the cascade read fails', async () => {
    let attempts = 0;
    stubFetch({
      custom: (call) => {
        const url = new URL(call.url, 'http://test');
        if (call.method === 'GET' && url.pathname === '/api/hope/admin/harness/pipeline-policy') {
          attempts += 1;
          if (attempts === 1) return Response.json({ message: 'pipeline-policy unavailable' }, { status: 503 });
        }
        return undefined;
      },
    });
    renderWithProviders(<PipelinePolicyScreen />);

    // The screen's own "post-consultation only" status banner is a second,
    // always-mounted role=alert region — narrow to the error-block copy.
    expect(await screen.findByText('pipeline-policy unavailable')).toBeDefined();
    expect(screen.getAllByRole('alert').length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    await waitFor(() => expect(matrix()).toBeDefined());
  });
});
