/**
 * Prompt Instruction Templates screen — the tenant-admin surface
 * for the prompts behind pre-summary and summary generation.
 *
 * fetch is stubbed at the network boundary. Coverage: the working-tenant gate,
 * the Fallbacks resolution map (the pre-summary vs summary shape split, the
 * legacy per-department override warning and the assign-department write), the
 * template grid + detail slide-over (versions, activate, test-run OCC write,
 * create, error state) and the elevated-only Governance tab.
 *
 * The grid/governance cases moved here verbatim from `agents-screen.test.tsx`
 * when the `PromptTemplate` surface got its own route.
 */

import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { renderWithProviders } from '@/test/render';
import type { Department, PromptTemplate, PromptUsageAnalytics, PromptVersion } from '../../api/types';
import { PromptTemplatesScreen } from '../prompt-templates-screen';

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

function template(overrides: Partial<PromptTemplate> = {}): PromptTemplate {
  return {
    id: 'pt-1',
    tenantId: 'tnt-1',
    name: 'Cardiology Notes',
    description: 'SOAP output for cardiology consults',
    content: 'You are a clinical scribe.',
    category: 'SUMMARY',
    status: 'PUBLISHED',
    currentVersionNumber: 7,
    approvedVersionNumber: null,
    // Hand-written by the tenant: the gateway answers explicit nulls here.
    sourceTemplateId: null,
    templateLocked: false,
    departmentId: 'd-1',
    createdAt: '2026-05-01T10:00:00.000Z',
    updatedAt: '2026-07-02T10:00:00.000Z',
    resourceStatus: 'ENABLED',
    version: 7,
    ...overrides,
  };
}

/**
 * The tenant-wide pre-summary row, matching the resolver's convention:
 * TENANT_DEFAULT scope, NO department, APPROVED, tagged `pre-summary`.
 */
const PRE_SUMMARY = template({
  id: 'pt-ps',
  name: 'Clinical Pre-Summary',
  category: 'CUSTOM',
  scope: 'TENANT_DEFAULT',
  status: 'APPROVED',
  departmentId: undefined,
  tags: ['arcaai', 'clinical', 'pre-summary', 'text-v1'],
  currentVersionNumber: 5,
  approvedVersionNumber: 3,
  createdAt: '2026-04-01T10:00:00.000Z',
  version: 5,
});

/** A SYSTEM/library row — only a super admin may approve it (OD-3 split gate). */
const SYSTEM_ROW = template({
  id: 'pt-sys',
  name: 'Platform Library Prompt',
  tenantId: '00000000-0000-0000-0000-000000000000',
  category: 'SYSTEM',
});

/** A row CLONED from the SYSTEM reference set at provisioning, and locked by the platform. */
const CLONED = template({
  id: 'pt-clone',
  name: 'ArcaAI SOAP Summary',
  sourceTemplateId: 'sys-tpl-1',
  templateLocked: true,
});

const TEMPLATES: PromptTemplate[] = [
  template(),
  template({ id: 'pt-2', name: 'Discharge Summary', departmentId: undefined, currentVersionNumber: 12, version: 3 }),
  template({ id: 'pt-3', name: 'Radiology Report', departmentId: 'd-2', currentVersionNumber: 4, status: 'DRAFT', version: 2 }),
  PRE_SUMMARY,
];

const DEPARTMENTS: Department[] = [
  {
    id: 'd-1',
    code: 'CARD',
    name: 'Cardiology',
    isRootDepartment: true,
    newPatientPromptId: 'pt-1',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    version: 3,
  },
  {
    id: 'd-2',
    code: 'RADIO',
    name: 'Radiology',
    isRootDepartment: true,
    // A stale per-department pre-summary override: pre-summary resolution
    // never reads this column, so the screen must call it out.
    preSummaryPromptId: 'pt-3',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    version: 5,
  },
];

function version(templateId: string, versionNumber: number, overrides: Partial<PromptVersion> = {}): PromptVersion {
  return {
    id: `pv-${templateId}-${versionNumber}`,
    promptTemplateId: templateId,
    versionNumber,
    content: `Prompt body v${versionNumber}`,
    changedBy: 'taphuynh',
    createdAt: '2026-06-20T10:00:00.000Z',
    ...overrides,
  };
}

const VERSIONS: Record<string, PromptVersion[]> = {
  'pt-1': [
    version('pt-1', 7, { createdAt: '2026-07-02T10:00:00.000Z' }),
    version('pt-1', 6, { changedBy: 'minh.tran' }),
    version('pt-1', 5),
    version('pt-1', 4, { changedBy: 'dr.lee' }),
  ],
  'pt-2': [version('pt-2', 12, { changedBy: 'minh.tran' }), version('pt-2', 11)],
  'pt-3': [version('pt-3', 4)],
};

const ANALYTICS: PromptUsageAnalytics = {
  totalUsages: 1204,
  byDepartment: [{ departmentId: 'd-1', count: 1204 }],
  byDoctor: [{ doctorId: 'doc-1', count: 1204 }],
  byDay: [{ day: new Date().toISOString().slice(0, 10), count: 42 }],
};

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

function session(overrides: Partial<{ workingTenantId: string | null }> = {}) {
  const base = {
    user: { id: 'u-1', username: 'root', email: 'root@hope.local', roles: ['SUPER_ADMIN'] },
    isElevated: true,
    workingTenantId: 'tnt-1',
    workingTenantName: 'Sunrise Medical Group',
    impersonatingUserId: null,
    impersonatingUsername: null,
    ...overrides,
  };
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
  if (path === '/api/hope/admin/department-agents') return Response.json({ data: [], count: 0, limit: 200, page: 0 });
  if (path === '/api/hope/admin/prompt-templates') {
    return Response.json({ data: TEMPLATES, count: TEMPLATES.length, limit: 10, page: 1 });
  }
  if (path === '/api/hope/admin/prompt-templates/analytics/usage') return Response.json(ANALYTICS);
  if (path === '/api/hope/admin/prompt-templates/usage-records') {
    return Response.json({
      data: [{ id: 'ur-1', promptTemplateId: 'pt-1', promptVersionNumber: 7, createdAt: '2026-07-01T09:00:00.000Z' }],
      count: 1,
      limit: 5,
      page: 0,
    });
  }
  const detail = path.match(/^\/api\/hope\/admin\/prompt-templates\/(pt-[\w-]+)$/);
  if (detail) {
    const row = TEMPLATES.find((entry) => entry.id === detail[1]);
    return row ? Response.json(row, { headers: { etag: `"${row.version}"` } }) : undefined;
  }
  const versions = path.match(/^\/api\/hope\/admin\/prompt-templates\/(pt-[\w-]+)\/versions$/);
  if (versions) return Response.json(VERSIONS[versions[1]] ?? []);
  const usage = path.match(/^\/api\/hope\/admin\/prompt-templates\/(pt-[\w-]+)\/usage$/);
  if (usage) return Response.json({ totalUsages: usage[1] === 'pt-1' ? 1204 : 64, lastUsedAt: '2026-07-01T09:00:00.000Z' });
  const diff = path.match(/^\/api\/hope\/admin\/prompt-templates\/(pt-[\w-]+)\/versions\/(\d+)\/diff\/(\d+)$/);
  if (diff) {
    return Response.json({
      promptTemplateId: diff[1],
      fromVersion: Number(diff[2]),
      toVersion: Number(diff[3]),
      fields: [],
      changes: [
        { value: 'You are a clinical scribe.\n', count: 1 },
        { value: 'Be brief.\n', removed: true, count: 1 },
        { value: 'Be thorough and structured.\n', added: true, count: 1 },
      ],
      patch: '@@ -1,2 +1,2 @@',
      stats: { additions: 1, deletions: 1, unchanged: 1 },
    });
  }
  return undefined;
}

/** CASL rules the console mirrors for menu/tab visibility (`POST /users/me/permission-checks`). */
let permissionRules: Array<{ action: string; subject: string }> = [{ action: 'manage', subject: 'all' }];

function permissionsResponse(call: RecordedCall): Response | undefined {
  if (pathOf(call) !== '/api/hope/users/me/permission-checks') return undefined;
  return Response.json({ userId: 'u-1', tenantId: 'tnt-1', permissions: permissionRules });
}

/** Best-effort per-user grid-layout persistence (`users/me/settings`) — no saved layout in tests. */
function settingsResponse(call: RecordedCall): Response | undefined {
  if (!call.url.includes('/users/me/settings')) return undefined;
  return call.method === 'GET' ? Response.json([]) : Response.json({ ok: true });
}

function stubTemplates(custom: FetchHandler = () => undefined): RecordedCall[] {
  return stubFetch((call) => settingsResponse(call) ?? permissionsResponse(call) ?? custom(call) ?? defaultHandler(call));
}

const pathOf = (call: RecordedCall) => new URL(call.url, 'http://test.local').pathname;

/** The default list plus the cloned row, with its detail read. */
function stubWithClone(custom: FetchHandler = () => undefined): RecordedCall[] {
  return stubTemplates((call) => {
    const path = pathOf(call);
    if (call.method === 'GET' && path === '/api/hope/admin/prompt-templates') {
      return Response.json({ data: [...TEMPLATES, CLONED], count: TEMPLATES.length + 1, limit: 10, page: 1 });
    }
    if (call.method === 'GET' && path === `/api/hope/admin/prompt-templates/${CLONED.id}`) {
      return Response.json(CLONED, { headers: { etag: `"${CLONED.version}"` } });
    }
    return custom(call);
  });
}

/** Open the detail drawer for a row and wait for its detail read to land. */
async function openRow(name: string) {
  fireEvent.click(await screen.findByText(name));
  return screen.findByRole('dialog');
}

afterEach(() => {
  vi.unstubAllGlobals();
  permissionRules = [{ action: 'manage', subject: 'all' }];
  cleanup();
});

/** A tenant admin: not elevated, but holding `manage:PromptTemplate` for its own tenant. */
function tenantAdminHandler(call: RecordedCall): Response | undefined {
  if (pathOf(call) !== '/api/auth/session') return undefined;
  const base = session();
  return Response.json({
    ...base,
    user: { ...base.user, roles: ['TENANT_ADMIN'] },
    isElevated: false,
    effectiveIsElevated: false,
  });
}

describe('PromptTemplatesScreen', () => {
  it('asks an elevated session without a working tenant to pick one (no data queries fired)', async () => {
    const calls = stubTemplates((call) => {
      if (pathOf(call) === '/api/auth/session') return Response.json(session({ workingTenantId: null }));
      return undefined;
    });
    renderWithProviders(<PromptTemplatesScreen />);

    expect(await screen.findByText('Select a working tenant')).toBeDefined();
    expect(calls.every((call) => !call.url.includes('/admin/prompt-templates'))).toBe(true);
  });

  /**
   * The reason this screen exists: pre-summary is tenant-wide with no
   * department or visit-type axis, while summary is a department x visit-type
   * matrix. If that distinction stops being visible, that class of bug
   * becomes invisible again.
   */
  describe('Fallbacks tab (the resolution map)', () => {
    it('lands on Fallbacks and names the tenant-wide pre-summary template', async () => {
      stubTemplates();
      renderWithProviders(<PromptTemplatesScreen />);

      expect(await screen.findByRole('heading', { level: 1, name: 'Prompt Instruction Templates' })).toBeDefined();
      expect(await screen.findByRole('tab', { name: 'Fallbacks', selected: true })).toBeDefined();
      expect(await screen.findByText('Clinical Pre-Summary')).toBeDefined();
      // The shape statement itself, not just the template name.
      expect(screen.getByText(/no department axis/i)).toBeDefined();
      expect(screen.getByText(/no visit-type axis/i)).toBeDefined();
    });

    it('renders the summary matrix on both axes with the visit types as columns', async () => {
      stubTemplates();
      renderWithProviders(<PromptTemplatesScreen />);

      // The matrix carries a programmatic name (it was an unnamed <table>).
      expect(await screen.findByRole('table', { name: 'Summary instructions by department and visit type' })).toBeDefined();
      expect(await screen.findByRole('columnheader', { name: /Summary — New referral/ })).toBeDefined();
      expect(screen.getByRole('columnheader', { name: /Summary — Re-visit/ })).toBeDefined();
      expect(screen.getByRole('cell', { name: 'CARD' })).toBeDefined();
      expect(screen.getByRole('cell', { name: 'RADIO' })).toBeDefined();
      // A department with no template in a slot says what happens instead.
      expect(screen.getAllByText(/falls through to the department-agnostic fallback/i).length).toBeGreaterThan(0);
      // …and the pre-summary column states it is not a per-department axis.
      expect(screen.getAllByText(/n\/a — tenant-wide/i).length).toBeGreaterThan(0);
    });

    it('flags a department that still carries a legacy per-department pre-summary override', async () => {
      stubTemplates();
      renderWithProviders(<PromptTemplatesScreen />);

      expect(await screen.findByText(/1 department still carr(y|ies) a per-department pre-summary/i)).toBeDefined();
      expect(screen.getByText('legacy override')).toBeDefined();
    });

    it('assigns a summary slot through assign-department carrying the DEPARTMENT row version', async () => {
      const calls = stubTemplates((call) => {
        if (call.method === 'POST' && pathOf(call) === '/api/hope/admin/prompt-templates/assign-department') {
          return Response.json(DEPARTMENTS[0]);
        }
        return undefined;
      });
      renderWithProviders(<PromptTemplatesScreen />);

      fireEvent.click(await screen.findByRole('button', { name: 'Change Re-visit template for CARD' }));
      const dialog = await screen.findByRole('dialog');
      fireEvent.change(within(dialog).getByLabelText('Template'), { target: { value: 'pt-2' } });
      fireEvent.click(within(dialog).getByRole('button', { name: 'Save slot' }));

      await waitFor(() => {
        const post = calls.find((call) => call.method === 'POST' && pathOf(call) === '/api/hope/admin/prompt-templates/assign-department');
        // expectedVersion is the DEPARTMENT row's version (3), NOT the template's.
        expect(post?.body).toMatchObject({ departmentId: 'd-1', revisitPromptId: 'pt-2', expectedVersion: 3 });
      });
    });
  });

  // WCAG 2.2 AA gate (rule 11 §11 / rule 12 gate 3). Both tabs are scanned:
  // the Fallbacks map is a data table plus alerts, the grid is a different
  // structure entirely, and a violation in either fails the screen.
  it('has no axe violations on the Fallbacks tab', async () => {
    stubTemplates();
    const { container } = renderWithProviders(<PromptTemplatesScreen />);
    await screen.findByText('Clinical Pre-Summary');
    expect(await axe(container)).toHaveNoViolations();
  });

  it('has no axe violations on the Templates tab', async () => {
    stubTemplates();
    const { container } = renderWithProviders(<PromptTemplatesScreen />, { searchParams: '?tab=templates' });
    await screen.findByText('Cardiology Notes');
    expect(await axe(container)).toHaveNoViolations();
  });

  it('renders the fill-height template grid with scope, department, type and usage columns', async () => {
    stubTemplates();
    renderWithProviders(<PromptTemplatesScreen />, { searchParams: '?tab=templates' });

    expect(await screen.findByText('Cardiology Notes')).toBeDefined();
    expect(screen.getByText('Discharge Summary')).toBeDefined();
    expect(screen.getByText('Radiology Report')).toBeDefined();
    expect(screen.getByText(/4 templates/)).toBeDefined();
    expect(screen.getByText('CARD')).toBeDefined();
    expect(screen.getByText('Tenant default')).toBeDefined();
    expect(screen.getAllByText('Summary').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('v12')).toBeDefined();
    expect(await screen.findAllByText('1,204')).toBeDefined();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  /**
   * Resolution serves the snapshot pinned at approval, not the mutable content
   * row — so "approved at v3, edited to v5" has to be legible, or an admin
   * cannot tell what is actually running.
   */
  it('shows the approved version the template is pinned to, distinct from the draft version', async () => {
    stubTemplates();
    renderWithProviders(<PromptTemplatesScreen />, { searchParams: '?tab=templates' });

    expect(await screen.findByText(/serving v3 · editing v5/)).toBeDefined();
    // A never-approved row says so rather than showing a version.
    expect(screen.getAllByText('not approved').length).toBeGreaterThan(0);
  });

  it('opens the detail slide-over on the clicked row (Overview tab seeds the edit form)', async () => {
    stubTemplates();
    renderWithProviders(<PromptTemplatesScreen />, { searchParams: '?tab=templates' });

    await openRow('Discharge Summary');
    expect(((await screen.findByRole('textbox', { name: 'Name' })) as HTMLInputElement).value).toBe('Discharge Summary');
  });

  it('lists versions in the drawer Versions tab', async () => {
    // Land on the Versions tab directly — Radix tab activation is unreliable
    // under fireEvent.click in jsdom, so selection + tab come from the URL.
    const calls = stubTemplates();
    renderWithProviders(<PromptTemplatesScreen />, { searchParams: '?template=pt-2&atab=versions' });

    const timeline = await screen.findByLabelText('Versions of Discharge Summary');
    expect(within(timeline).getByText('v12')).toBeDefined();
    expect(within(timeline).getByText('minh.tran')).toBeDefined();
    await waitFor(() => expect(calls.some((call) => pathOf(call) === '/api/hope/admin/prompt-templates/pt-2/versions')).toBe(true));
  });

  it('swaps the drawer content when a different row is selected (one detail surface)', async () => {
    stubTemplates();
    renderWithProviders(<PromptTemplatesScreen />, { searchParams: '?tab=templates' });

    await openRow('Discharge Summary');
    expect(((await screen.findByRole('textbox', { name: 'Name' })) as HTMLInputElement).value).toBe('Discharge Summary');

    fireEvent.click(screen.getByText('Radiology Report'));
    await waitFor(() => expect((screen.getByRole('textbox', { name: 'Name' }) as HTMLInputElement).value).toBe('Radiology Report'));
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
  });

  it('activates an older version from the Versions tab behind a confirm dialog', async () => {
    const calls = stubTemplates((call) => {
      if (call.method === 'POST' && pathOf(call) === '/api/hope/admin/prompt-templates/pt-1/versions/6/activate') {
        return Response.json({ ...TEMPLATES[0], currentVersionNumber: 8, version: 8 });
      }
      return undefined;
    });
    renderWithProviders(<PromptTemplatesScreen />, { searchParams: '?template=pt-1&atab=versions' });

    fireEvent.click(await screen.findByRole('button', { name: 'Activate v6' }));
    const confirm = await screen.findByRole('alertdialog');
    expect(within(confirm).getByText(/activate version 6/i)).toBeDefined();
    fireEvent.click(within(confirm).getByRole('button', { name: 'Activate v6' }));

    await waitFor(() =>
      expect(calls.some((call) => call.method === 'POST' && pathOf(call) === '/api/hope/admin/prompt-templates/pt-1/versions/6/activate')).toBe(true),
    );
  });

  /**
   * BUG-018: POST :id/test is now a non-writing ACK — no If-Match, no
   * expectedVersion. A dry run (the panel default) comes back as
   * `mode: 'dry-run'` with the assembled prompt and opens no stream.
   */
  it('runs a prompt test from the Test-run tab as an ack and renders the assembled prompt', async () => {
    const calls = stubTemplates((call) => {
      if (call.method === 'POST' && pathOf(call) === '/api/hope/admin/prompt-templates/pt-1/test') {
        return Response.json({
          mode: 'dry-run',
          provider: 'azure',
          model: 'gpt-4o',
          assembledPrompt: 'S: Chest pain. O: Stable. A: Angina. P: Follow-up.',
        });
      }
      return undefined;
    });
    renderWithProviders(<PromptTemplatesScreen />, { searchParams: '?template=pt-1&atab=test' });

    fireEvent.change(await screen.findByLabelText('Sample input'), { target: { value: 'Patient reports chest pain.' } });
    const runButton = screen.getByRole('button', { name: /run test/i }) as HTMLButtonElement;
    await waitFor(() => expect(runButton.disabled).toBe(false));
    fireEvent.click(runButton);

    expect(await screen.findByText(/A: Angina/)).toBeDefined();
    const post = calls.find((call) => call.method === 'POST' && pathOf(call) === '/api/hope/admin/prompt-templates/pt-1/test');
    expect(post?.headers['if-match']).toBeUndefined();
    expect(post?.body).toEqual({ sampleInput: 'Patient reports chest pain.', dryRun: true });
  });

  it('creates a template from the drawer create mode (no modal)', async () => {
    const calls = stubTemplates((call) => {
      if (call.method === 'POST' && pathOf(call) === '/api/hope/admin/prompt-templates') {
        return Response.json(template({ id: 'pt-9', name: 'Nephrology Notes' }));
      }
      return undefined;
    });
    renderWithProviders(<PromptTemplatesScreen />, { searchParams: '?tab=templates' });

    fireEvent.click(await screen.findByRole('button', { name: 'New template' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(await within(dialog).findByRole('textbox', { name: 'Name' }), { target: { value: 'Nephrology Notes' } });
    fireEvent.change(within(dialog).getByRole('textbox', { name: /Prompt content/ }), { target: { value: 'You are a scribe.' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create template' }));

    await waitFor(() => {
      const post = calls.find((call) => call.method === 'POST' && pathOf(call) === '/api/hope/admin/prompt-templates');
      expect(post?.body).toMatchObject({ name: 'Nephrology Notes', content: 'You are a scribe.' });
    });
  });

  /**
   * TASK-890 J2 — the edit form used to POST the row's CURRENT status back on
   * every save. `PATCH :id` accepts only DRAFT|PUBLISHED (approval is its own
   * route), so saving ANY edit to an APPROVED template 400'd — and 41 of the
   * 45 seeded templates are APPROVED, which made the cloned SYSTEM prompts
   * uneditable from the console. An unchanged status must not travel.
   */
  it('saves an APPROVED template without sending the un-settable APPROVED status', async () => {
    const calls = stubTemplates((call) => {
      if (call.method === 'PATCH' && pathOf(call) === '/api/hope/admin/prompt-templates/pt-ps') {
        return Response.json({ ...PRE_SUMMARY, version: PRE_SUMMARY.version + 1 });
      }
      return undefined;
    });
    renderWithProviders(<PromptTemplatesScreen />, { searchParams: '?tab=templates&template=pt-ps' });

    const dialog = await screen.findByRole('dialog');
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Save changes' }));

    await waitFor(() => {
      const patch = calls.find((call) => call.method === 'PATCH' && pathOf(call) === '/api/hope/admin/prompt-templates/pt-ps');
      expect(patch).toBeDefined();
      expect(patch?.body).not.toHaveProperty('status');
    });
  });

  it('shows the approval status of the open template in the drawer header (not a flat "Published")', async () => {
    stubTemplates();
    renderWithProviders(<PromptTemplatesScreen />, { searchParams: '?tab=templates&template=pt-ps' });

    const dialog = await screen.findByRole('dialog');
    expect((await within(dialog).findAllByText('Approved')).length).toBeGreaterThan(0);
    // The header badges only — the edit form's Status select legitimately
    // carries a "Published" option.
    const badges = [...dialog.querySelectorAll('[data-slot="badge"]')].map((badge) => badge.textContent);
    expect(badges.some((label) => label === 'Published')).toBe(false);
    expect(badges.some((label) => label?.includes('serving v3'))).toBe(true);
  });

  /**
   * TASK-890 J2-9 — `?create=1` is the link the shared prompt picker's empty
   * state emits ("create one"), and the same deep link `/agents` already
   * honours. It landed on the Fallbacks tab with no drawer at all.
   */
  it('opens the create drawer on the ?create=1 deep link', async () => {
    stubTemplates();
    renderWithProviders(<PromptTemplatesScreen />, { searchParams: '?create=1' });

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('New prompt template')).toBeDefined();
  });

  /**
   * TASK-890 J2-5 — reference-set provenance. Every tenant's prompt library is
   * CLONED from the SYSTEM reference set, and 17/17 ARCAAI rows are stamped and
   * locked; without the badge a platform clone is indistinguishable from a
   * prompt the tenant wrote, which is also why a refused edit looks arbitrary.
   */
  describe('reference-set provenance', () => {
    it('badges a cloned row "Platform origin" in the grid and the others "Tenant"', async () => {
      stubWithClone();
      renderWithProviders(<PromptTemplatesScreen />, { searchParams: '?tab=templates' });

      expect(await screen.findByText(/Platform origin/)).toBeDefined();
      expect(screen.getAllByText('Tenant').length).toBe(TEMPLATES.length);
    });

    it('says the clone is locked in the drawer header', async () => {
      stubWithClone();
      renderWithProviders(<PromptTemplatesScreen />, { searchParams: '?tab=templates&template=pt-clone' });

      const dialog = await screen.findByRole('dialog');
      expect(await within(dialog).findByText(/Platform origin · locked/)).toBeDefined();
    });
  });

  /**
   * TASK-890 J2 — the owner is deprecating the `departmentId` scope in favour
   * of department TAGS, and `PromptTemplate.tags` has been carried end to end
   * (column, create/update DTOs, response) with no console surface at all.
   */
  describe('tags', () => {
    it('lists a template’s tags in the grid', async () => {
      stubTemplates();
      renderWithProviders(<PromptTemplatesScreen />, { searchParams: '?tab=templates' });

      expect(await screen.findByText('pre-summary')).toBeDefined();
    });

    it('edits the tag set from the drawer and PATCHes it', async () => {
      const calls = stubTemplates((call) => {
        if (call.method === 'PATCH' && pathOf(call) === '/api/hope/admin/prompt-templates/pt-ps') {
          return Response.json({ ...PRE_SUMMARY, version: PRE_SUMMARY.version + 1 });
        }
        return undefined;
      });
      renderWithProviders(<PromptTemplatesScreen />, { searchParams: '?tab=templates&template=pt-ps' });

      const dialog = await screen.findByRole('dialog');
      const tagBox = await within(dialog).findByRole('textbox', { name: 'Tags' });
      fireEvent.change(tagBox, { target: { value: 'dept:cardiology' } });
      fireEvent.keyDown(tagBox, { key: 'Enter' });
      fireEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }));

      await waitFor(() => {
        const patch = calls.find((call) => call.method === 'PATCH' && pathOf(call) === '/api/hope/admin/prompt-templates/pt-ps');
        expect(patch?.body).toMatchObject({ tags: [...(PRE_SUMMARY.tags ?? []), 'dept:cardiology'] });
      });
    });

    it('removes a tag from the set before saving', async () => {
      const calls = stubTemplates((call) => {
        if (call.method === 'PATCH' && pathOf(call) === '/api/hope/admin/prompt-templates/pt-ps') {
          return Response.json({ ...PRE_SUMMARY, version: PRE_SUMMARY.version + 1 });
        }
        return undefined;
      });
      renderWithProviders(<PromptTemplatesScreen />, { searchParams: '?tab=templates&template=pt-ps' });

      const dialog = await screen.findByRole('dialog');
      fireEvent.click(await within(dialog).findByRole('button', { name: 'Remove tag arcaai' }));
      fireEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }));

      await waitFor(() => {
        const patch = calls.find((call) => call.method === 'PATCH' && pathOf(call) === '/api/hope/admin/prompt-templates/pt-ps');
        expect(patch?.body).toMatchObject({ tags: ['clinical', 'pre-summary', 'text-v1'] });
      });
    });

    it('creates a template carrying its tags', async () => {
      const calls = stubTemplates((call) => {
        if (call.method === 'POST' && pathOf(call) === '/api/hope/admin/prompt-templates') {
          return Response.json(template({ id: 'pt-9', name: 'Nephrology Notes' }));
        }
        return undefined;
      });
      renderWithProviders(<PromptTemplatesScreen />, { searchParams: '?tab=templates' });

      fireEvent.click(await screen.findByRole('button', { name: 'New template' }));
      const dialog = await screen.findByRole('dialog');
      fireEvent.change(await within(dialog).findByRole('textbox', { name: 'Name' }), { target: { value: 'Nephrology Notes' } });
      fireEvent.change(within(dialog).getByRole('textbox', { name: /Prompt content/ }), { target: { value: 'You are a scribe.' } });
      const tagBox = within(dialog).getByRole('textbox', { name: 'Tags' });
      fireEvent.change(tagBox, { target: { value: 'dept:nephrology' } });
      fireEvent.keyDown(tagBox, { key: 'Enter' });
      fireEvent.click(within(dialog).getByRole('button', { name: 'Create template' }));

      await waitFor(() => {
        const post = calls.find((call) => call.method === 'POST' && pathOf(call) === '/api/hope/admin/prompt-templates');
        expect(post?.body).toMatchObject({ name: 'Nephrology Notes', tags: ['dept:nephrology'] });
      });
    });
  });

  it('renders the block error state and retries the templates request', async () => {
    const calls = stubTemplates((call) => {
      if (call.method === 'GET' && pathOf(call) === '/api/hope/admin/prompt-templates') {
        return Response.json({ message: 'Service unavailable' }, { status: 503 });
      }
      return undefined;
    });
    renderWithProviders(<PromptTemplatesScreen />, { searchParams: '?tab=templates' });

    expect(await screen.findByRole('alert')).toBeDefined();
    expect(screen.getByText(/service unavailable/i)).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    await waitFor(() => expect(calls.filter((call) => pathOf(call) === '/api/hope/admin/prompt-templates').length).toBe(2));
  });

  /**
   * TASK-890 J2-6 — the console mirrors the server's OD-3 SPLIT gate: a
   * TENANT-OWNED template needs `manage:PromptTemplate` (which every tenant
   * admin holds), while the SYSTEM/library rows stay SUPER_ADMIN-only. Gating
   * the whole tab on elevation hid approval from the tenant admins the server
   * explicitly allows — verified against the live gateway, where
   * `POST :id/approve` as arcaai_admin returns 200 and pins the version.
   */
  describe('Governance tab', () => {
    it('is hidden for a session without manage:PromptTemplate', async () => {
      permissionRules = [{ action: 'read', subject: 'PromptTemplate' }];
      stubTemplates(tenantAdminHandler);
      renderWithProviders(<PromptTemplatesScreen />);

      await screen.findByRole('tab', { name: 'Fallbacks' });
      expect(screen.getByRole('tab', { name: 'Templates' })).toBeDefined();
      expect(screen.queryByRole('tab', { name: 'Governance' })).toBeNull();
    });

    it('is visible to a TENANT admin holding manage:PromptTemplate', async () => {
      permissionRules = [{ action: 'manage', subject: 'PromptTemplate' }];
      stubTemplates(tenantAdminHandler);
      renderWithProviders(<PromptTemplatesScreen />, { searchParams: '?tab=governance' });

      expect(await screen.findByRole('tab', { name: 'Governance' })).toBeDefined();
      expect(await screen.findByRole('heading', { name: /prompt governance/i })).toBeDefined();
    });

    it('lets that tenant admin approve a TENANT-OWNED template', async () => {
      permissionRules = [{ action: 'manage', subject: 'PromptTemplate' }];
      const calls = stubTemplates((call) => {
        if (call.method === 'POST' && pathOf(call).endsWith('/approve')) {
          return Response.json({ ...TEMPLATES[0], status: 'APPROVED', version: TEMPLATES[0].version + 1 });
        }
        return tenantAdminHandler(call);
      });
      renderWithProviders(<PromptTemplatesScreen />, { searchParams: '?tab=governance' });

      await screen.findByRole('tab', { name: 'Governance' });
      fireEvent.click(await screen.findByText(TEMPLATES[0].name));
      fireEvent.click(await screen.findByRole('button', { name: 'Approve for clinical use' }, { timeout: 3000 }));

      await waitFor(() => expect(calls.some((call) => call.method === 'POST' && pathOf(call).endsWith('/approve'))).toBe(true));
    });

    it('refuses SYSTEM/library approval for that same tenant admin (super-admin only)', async () => {
      permissionRules = [{ action: 'manage', subject: 'PromptTemplate' }];
      stubTemplates((call) => {
        const path = pathOf(call);
        if (call.method === 'GET' && path === '/api/hope/admin/prompt-templates') {
          return Response.json({ data: [SYSTEM_ROW], count: 1, limit: 10, page: 1 });
        }
        if (call.method === 'GET' && path === `/api/hope/admin/prompt-templates/${SYSTEM_ROW.id}`) {
          return Response.json(SYSTEM_ROW, { headers: { etag: `"${SYSTEM_ROW.version}"` } });
        }
        return tenantAdminHandler(call);
      });
      renderWithProviders(<PromptTemplatesScreen />, { searchParams: '?tab=governance' });

      await screen.findByRole('tab', { name: 'Governance' });
      fireEvent.click(await screen.findByText(SYSTEM_ROW.name));
      const approve = await screen.findByRole('button', { name: 'Approve for clinical use' }, { timeout: 3000 });
      expect(approve.hasAttribute('disabled')).toBe(true);
      expect(screen.getByText(/only a super administrator/i)).toBeDefined();
    });

    it('is visible for an elevated session and opens on the redirect target ?tab=governance', async () => {
      stubTemplates();
      // `/prompt-studio` redirects to exactly this URL, so the tab must be
      // URL-addressable — asserting via searchParams tests that contract.
      renderWithProviders(<PromptTemplatesScreen />, { searchParams: '?tab=governance' });

      expect(await screen.findByRole('tab', { name: 'Governance' })).toBeDefined();
      expect(await screen.findByRole('heading', { name: /prompt governance/i })).toBeDefined();
    });

    it('approves a template as an OCC write carrying If-Match', async () => {
      const calls = stubTemplates((call) => {
        if (call.method === 'POST' && pathOf(call).endsWith('/approve')) {
          return Response.json({ ...TEMPLATES[0], status: 'APPROVED', version: TEMPLATES[0].version + 1 });
        }
        return undefined;
      });
      renderWithProviders(<PromptTemplatesScreen />, { searchParams: '?tab=governance' });

      fireEvent.click(await screen.findByText(TEMPLATES[0].name));
      fireEvent.click(await screen.findByRole('button', { name: 'Approve for clinical use' }));

      await waitFor(() => expect(calls.some((call) => call.method === 'POST' && pathOf(call).endsWith('/approve'))).toBe(true));
      const approve = calls.find((call) => call.method === 'POST' && pathOf(call).endsWith('/approve'));
      expect(approve?.headers['if-match']).toBe(`"${TEMPLATES[0].version}"`);
      expect((approve?.body as { expectedVersion: number }).expectedVersion).toBe(TEMPLATES[0].version);
    });
  });
});
