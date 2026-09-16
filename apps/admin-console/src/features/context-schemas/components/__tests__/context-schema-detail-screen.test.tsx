/**
 * The context-schema detail PAGE — fetch stubbed at the network boundary.
 *
 * Covers what the page promises: one primary action, the `⋯` menu behind it,
 * the "Used by" line, two deep-linkable tabs, the footer's draft summary, the
 * three publish-confirmation variants (and that each sends the right
 * acknowledgement), the not-found copy, and axe in both themes on the page AND
 * on the publish dialog.
 */

import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { renderWithProviders } from '@/test/render';
import {
  CONTEXT_PRIMITIVES,
  type ConsultationContextSchema,
  type ConsultationContextSchemaVersion,
  type ContextSchemaUsagesResponse,
} from '../../api/types';
import { ContextSchemaDetailScreen } from '../context-schema-detail-screen';

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

const push = vi.fn();
vi.mock('next/navigation', async () => {
  const actual = await vi.importActual<typeof import('next/navigation')>('next/navigation');
  return { ...actual, useRouter: () => ({ push, replace: vi.fn(), refresh: vi.fn(), back: vi.fn(), forward: vi.fn(), prefetch: vi.fn() }) };
});

// Radix Select scrolls the highlighted item into view on open; happy-dom has no layout engine.
beforeAll(() => {
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
});

/** Radix opens a dropdown on pointerdown, not click. */
function openOverflowMenu(): void {
  fireEvent.pointerDown(screen.getByRole('button', { name: 'More schema actions' }), { button: 0, ctrlKey: false, pointerType: 'mouse' });
}

/** Expand a kind's Accordion item so its `KindForm` Basics render. */
async function expandKind(keyPattern: RegExp): Promise<void> {
  fireEvent.click(await screen.findByRole('button', { name: keyPattern }));
}

function schema(overrides: Partial<ConsultationContextSchema> = {}): ConsultationContextSchema {
  return {
    id: 's-1',
    tenantId: 'tnt-1',
    slug: 'general_medicine',
    name: 'General Medicine Context',
    description: null,
    scope: 'TENANT',
    departmentId: null,
    status: 'PUBLISHED',
    pinnedVersionNumber: 1,
    isDefault: false,
    sourceTemplateSlug: null,
    templateLocked: false,
    version: 1,
    createdAt: '2026-08-01T10:00:00.000Z',
    updatedAt: '2026-08-01T10:00:00.000Z',
    ...overrides,
  };
}

function versionRow(overrides: Partial<ConsultationContextSchemaVersion> = {}): ConsultationContextSchemaVersion {
  return {
    id: 'v-1',
    schemaId: 's-1',
    versionNumber: 1,
    definition: {
      schemaVersion: '1.0',
      kinds: [
        {
          key: 'triage_notes',
          label: 'Triage Notes',
          primitive: 'STRUCTURED',
          phiClass: 'PHI',
          cardinality: 'ONE',
          lifecycle: 'PRE',
          producedBy: ['CLIENT'],
          fields: { type: 'object', properties: { severity: { type: 'string', enum: ['mild', 'severe'] } }, required: ['severity'] },
        },
      ],
      outputs: [],
    },
    checksum: 'sha256:abc',
    changeReason: 'initial publish',
    createdBy: 'u-1',
    createdAt: '2026-08-01T10:00:00.000Z',
    ...overrides,
  };
}

function usages(overrides: Partial<ContextSchemaUsagesResponse> = {}): ContextSchemaUsagesResponse {
  return {
    schemaId: 's-1',
    againstVersion: 1,
    workflows: [
      {
        definitionId: 'wd-1',
        slug: 'cardio',
        name: 'Cardiology intake',
        versionNumber: 3,
        status: 'PUBLISHED',
        isActive: true,
        binding: 'latest',
        boundVersion: null,
        verdict: 'accepts',
        problems: [],
      },
    ],
    agents: [],
    ...overrides,
  };
}

const REFUSING_IMPACT: ContextSchemaUsagesResponse = usages({
  againstVersion: 2,
  workflows: [
    {
      definitionId: 'wd-2',
      slug: 'ortho',
      name: 'Ortho intake',
      versionNumber: 2,
      status: 'PUBLISHED',
      isActive: true,
      binding: 'pinned',
      boundVersion: 1,
      verdict: 'refuses',
      problems: ['/referral: not declared in the bound version v1'],
    },
  ],
});

interface RecordedCall {
  url: string;
  method: string;
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

function session() {
  const base = {
    user: { id: 'u-1', username: 'root', email: 'root@hope.local', roles: ['SUPER_ADMIN'] },
    isElevated: true,
    workingTenantId: 'tnt-1',
    workingTenantName: 'Sunrise Medical Group',
    impersonatingUserId: null,
    impersonatingUsername: null,
  };
  return { ...base, effectiveUser: { ...base.user, tenantId: null, departmentId: null }, effectiveIsElevated: true, effectiveTenantId: 'tnt-1' };
}

const pathOf = (call: RecordedCall) => new URL(call.url, 'http://test.local').pathname;
const BASE = '/api/hope/admin/consultation-context-schemas/s-1';

/** Session, departments, settings passthrough, plus the three reads the page makes. */
function baseHandler(call: RecordedCall): Response | undefined {
  const path = pathOf(call);
  if (path === '/api/auth/session') return Response.json(session());
  if (path === '/api/hope/admin/departments') return Response.json([]);
  if (path.includes('/users/me/settings')) return call.method === 'GET' ? Response.json([]) : Response.json({ ok: true });
  if (path === BASE && call.method === 'GET') return Response.json(schema(), { headers: { etag: '"1"' } });
  if (path === `${BASE}/versions`) return Response.json([versionRow()]);
  if (path === `${BASE}/usages`) return Response.json(usages());
  return undefined;
}

function stubScreen(custom: FetchHandler = () => undefined): RecordedCall[] {
  return stubFetch((call) => custom(call) ?? baseHandler(call));
}

afterEach(() => {
  vi.unstubAllGlobals();
  document.documentElement.classList.remove('dark');
  push.mockReset();
  cleanup();
});

describe('ContextSchemaDetailScreen', () => {
  it('leads with the schema name, its badges, and exactly one primary action', async () => {
    stubScreen();
    renderWithProviders(<ContextSchemaDetailScreen id="s-1" />);

    expect(await screen.findByRole('heading', { level: 1, name: 'General Medicine Context' })).toBeDefined();
    expect(screen.getByText('PUBLISHED')).toBeDefined();
    expect(screen.getByText('Pinned v1')).toBeDefined();
    expect(await screen.findByRole('button', { name: 'Publish' })).toBeDefined();
    // Rename/settings and Delete are behind the overflow menu, not standing buttons.
    expect(screen.queryByRole('button', { name: /Delete schema/ })).toBeNull();
    expect(screen.getByRole('button', { name: 'More schema actions' })).toBeDefined();
  });

  it('answers "who depends on this?" in one line under the header', async () => {
    stubScreen();
    renderWithProviders(<ContextSchemaDetailScreen id="s-1" />);

    expect(await screen.findByText(/Used by 1 workflow/)).toBeDefined();
    expect(screen.getByText(/all accept v1/)).toBeDefined();
  });

  it('offers two tabs and lands on Definition, showing the published kinds', async () => {
    stubScreen();
    renderWithProviders(<ContextSchemaDetailScreen id="s-1" />);

    expect(await screen.findByRole('tab', { name: 'Definition' })).toBeDefined();
    expect(screen.getByRole('tab', { name: /Versions \(1\)/ })).toBeDefined();
    expect(screen.queryByRole('tab', { name: /Settings/ })).toBeNull();
    expect(screen.queryByRole('tab', { name: /Tester/ })).toBeNull();
    expect(await screen.findByText('triage_notes')).toBeDefined();
  });

  it('deep-links to the Versions tab via ?tab=', async () => {
    stubScreen();
    renderWithProviders(<ContextSchemaDetailScreen id="s-1" />, { searchParams: '?tab=versions' });

    expect(await screen.findByText('Pinned')).toBeDefined();
  });

  it('reports the draft in the footer and flips to unsaved changes on an edit', async () => {
    stubScreen();
    renderWithProviders(<ContextSchemaDetailScreen id="s-1" />);

    expect(await screen.findByText(/1 kind, 0 outputs · Saved/)).toBeDefined();

    fireEvent.click(await screen.findByRole('button', { name: 'Add kind' }));
    expect(await screen.findByText(/2 kinds, 0 outputs · unsaved changes/)).toBeDefined();
  });

  it('enforces the primitive allow-list with a CLOSED select — only the five platform primitives are offered, never free text', async () => {
    stubScreen();
    renderWithProviders(<ContextSchemaDetailScreen id="s-1" />);
    await expandKind(/triage_notes/);

    const trigger = await screen.findByRole('combobox', { name: /Primitive/ });
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: 'mouse' });
    const options = await screen.findAllByRole('option');
    expect(options.map((option) => option.textContent)).toEqual([...CONTEXT_PRIMITIVES]);
  });

  it('confirms an all-accept publish with the effect stated, and no acknowledgement to tick', async () => {
    const calls = stubScreen((call) => {
      if (pathOf(call) === `${BASE}/publish` && call.method === 'POST') return Response.json(schema({ pinnedVersionNumber: 2 }));
      return undefined;
    });
    renderWithProviders(<ContextSchemaDetailScreen id="s-1" />);

    await screen.findByText('triage_notes');
    fireEvent.click(screen.getByRole('button', { name: 'Publish' }));

    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText('Publish version 2?')).toBeDefined();
    expect(within(dialog).getByText(/1 workflow follows the latest version and will accept it\. None will refuse it\./)).toBeDefined();
    expect(within(dialog).queryByRole('checkbox')).toBeNull();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Publish' }));
    await waitFor(() => expect(calls.some((call) => pathOf(call) === `${BASE}/publish`)).toBe(true));
    const body = calls.find((call) => pathOf(call) === `${BASE}/publish`)?.body as Record<string, unknown>;
    expect(body.acknowledgeImpact).toBeUndefined();
    expect(body.allowBreakingChange).toBeUndefined();
  });

  it('re-states the SAME dialog when the server refuses on impact, and republishes with acknowledgeImpact', async () => {
    let acknowledged = false;
    const calls = stubScreen((call) => {
      if (pathOf(call) === `${BASE}/publish` && call.method === 'POST') {
        const body = call.body as { acknowledgeImpact?: boolean };
        if (body.acknowledgeImpact === true) {
          acknowledged = true;
          return Response.json(schema({ pinnedVersionNumber: 2 }));
        }
        return Response.json(
          {
            statusCode: 400,
            message: 'Publishing this version would make 1 workflow refuse new consultations.',
            code: 'SCHEMA_IMPACT_UNACKNOWLEDGED',
            impact: REFUSING_IMPACT,
          },
          { status: 400 },
        );
      }
      return undefined;
    });
    renderWithProviders(<ContextSchemaDetailScreen id="s-1" />);

    await screen.findByText('triage_notes');
    fireEvent.click(screen.getByRole('button', { name: 'Publish' }));
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Publish' }));

    // Same dialog, now naming the consumer and gating on the checkbox.
    const checkbox = await within(dialog).findByRole('checkbox', {
      name: 'I understand this 1 workflow will refuse new consultations until it is republished.',
    });
    expect(within(dialog).getByText(/Ortho intake — pinned v1/)).toBeDefined();
    expect(within(dialog).getByRole('button', { name: 'Publish' }).hasAttribute('disabled')).toBe(true);

    fireEvent.click(checkbox);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Publish' }));

    await waitFor(() => expect(acknowledged).toBe(true));
    expect(calls.filter((call) => pathOf(call) === `${BASE}/publish`)).toHaveLength(2);
  });

  it('refuses a breaking publish, names the break, and republishes with allowBreakingChange after "Publish anyway"', async () => {
    let allowed = false;
    stubScreen((call) => {
      if (pathOf(call) === `${BASE}/publish` && call.method === 'POST') {
        const body = call.body as { allowBreakingChange?: boolean };
        if (body.allowBreakingChange === true) {
          allowed = true;
          return Response.json(schema({ pinnedVersionNumber: 2 }));
        }
        return Response.json(
          {
            statusCode: 400,
            message: 'This definition breaks clients built against the current version.',
            breakingChanges: ['kind `triage_notes` removed'],
          },
          { status: 400 },
        );
      }
      return undefined;
    });
    renderWithProviders(<ContextSchemaDetailScreen id="s-1" />);

    await screen.findByText('triage_notes');
    fireEvent.click(screen.getByRole('button', { name: 'Publish' }));
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Publish' }));

    expect(await within(dialog).findByText('This change breaks apps already using version 1')).toBeDefined();
    expect(within(dialog).getByText('kind `triage_notes` removed')).toBeDefined();

    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'I understand existing integrations will stop working until they are updated.' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Publish anyway' }));

    await waitFor(() => expect(allowed).toBe(true));
  });

  it('closes the dialog and points at the field when the definition is structurally invalid', async () => {
    stubScreen((call) => {
      if (pathOf(call) === `${BASE}/publish` && call.method === 'POST') {
        return Response.json(
          {
            statusCode: 400,
            message: 'The context schema definition is not publishable.',
            problems: ['definition.kinds[0].primitive `WEIRD` is not one of STREAM_AUDIO | TEXT | DOCUMENT | IMAGE | STRUCTURED'],
          },
          { status: 400 },
        );
      }
      return undefined;
    });
    renderWithProviders(<ContextSchemaDetailScreen id="s-1" />);

    await screen.findByText('triage_notes');
    fireEvent.click(screen.getByRole('button', { name: 'Publish' }));
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Publish' }));

    expect(await screen.findByText('The definition is not publishable')).toBeDefined();
    expect(screen.getByText(/definition\.kinds\[0\]\.primitive `WEIRD`/)).toBeDefined();
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
  });

  it('opens Rename & settings from the overflow menu with the four editable fields and a save', async () => {
    stubScreen();
    renderWithProviders(<ContextSchemaDetailScreen id="s-1" />);

    await screen.findByText('triage_notes');
    openOverflowMenu();
    fireEvent.click(await screen.findByRole('menuitem', { name: /Rename & settings/ }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByLabelText(/^Name/)).toBeDefined();
    expect(within(dialog).getByLabelText('Description')).toBeDefined();
    expect(within(dialog).getByLabelText('Status')).toBeDefined();
    expect(within(dialog).getByRole('switch', { name: 'Department default' })).toBeDefined();
    expect(within(dialog).getByRole('button', { name: 'Save changes' })).toBeDefined();
    // Slug and scope are read-only meta, not disabled inputs an admin can tab into.
    expect(within(dialog).queryByLabelText('Slug')).toBeNull();
  });

  it('deletes behind type-to-confirm and returns to the catalog', async () => {
    const calls = stubScreen((call) => {
      if (pathOf(call) === BASE && call.method === 'DELETE') return Response.json(schema());
      return undefined;
    });
    renderWithProviders(<ContextSchemaDetailScreen id="s-1" />);

    await screen.findByText('triage_notes');
    openOverflowMenu();
    fireEvent.click(await screen.findByRole('menuitem', { name: /Delete schema/ }));

    const dialog = await screen.findByRole('alertdialog');
    const confirm = within(dialog).getByRole('button', { name: 'Delete schema' });
    expect(confirm.hasAttribute('disabled')).toBe(true);

    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: 'General Medicine Context' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete schema' }));

    await waitFor(() => expect(calls.some((call) => call.method === 'DELETE')).toBe(true));
    await waitFor(() => expect(push).toHaveBeenCalledWith('/context-schemas'));
  });

  it('pins an older version from the Versions tab', async () => {
    const calls = stubScreen((call) => {
      const path = pathOf(call);
      if (path === BASE && call.method === 'GET') return Response.json(schema({ pinnedVersionNumber: 2 }), { headers: { etag: '"2"' } });
      if (path === `${BASE}/versions`) return Response.json([versionRow(), versionRow({ id: 'v-2', versionNumber: 2 })]);
      if (path === `${BASE}/pin` && call.method === 'POST') return Response.json(schema({ pinnedVersionNumber: 1 }));
      return undefined;
    });
    renderWithProviders(<ContextSchemaDetailScreen id="s-1" />, { searchParams: '?tab=versions' });

    fireEvent.click(await screen.findByRole('button', { name: 'Pin' }));

    await waitFor(() => expect(calls.some((call) => call.method === 'POST' && pathOf(call).endsWith('/pin'))).toBe(true));
    expect(calls.find((call) => call.method === 'POST' && pathOf(call).endsWith('/pin'))?.body).toEqual({ versionNumber: 1 });
  });

  it('says a missing or out-of-scope schema is the same thing (404-over-403)', async () => {
    stubScreen((call) => {
      if (pathOf(call) === BASE && call.method === 'GET') return Response.json({ statusCode: 404, message: 'Not found' }, { status: 404 });
      return undefined;
    });
    renderWithProviders(<ContextSchemaDetailScreen id="s-1" />);

    expect(await screen.findByText('This context schema does not exist or is outside your access scope.')).toBeDefined();
    expect(screen.getByRole('link', { name: /Back to context schemas/ })).toBeDefined();
  });

  it('validates a sample payload against the kind it sits beside', async () => {
    stubScreen();
    renderWithProviders(<ContextSchemaDetailScreen id="s-1" />);
    await expandKind(/triage_notes/);

    fireEvent.click(await screen.findByRole('button', { name: /Try a sample payload/ }));
    fireEvent.change(await screen.findByLabelText('Sample payload'), { target: { value: '{"severity":"catastrophic"}' } });
    fireEvent.click(screen.getByRole('button', { name: 'Validate' }));

    expect(await screen.findByText(/Payload does not conform/)).toBeDefined();
    expect(screen.getByText(/must be one of the declared enum values/)).toBeDefined();
  });

  it('has no axe violations on the page or the publish dialog, in both themes', async () => {
    for (const theme of ['light', 'dark'] as const) {
      if (theme === 'dark') document.documentElement.classList.add('dark');
      stubScreen((call) => {
        if (pathOf(call) === `${BASE}/publish` && call.method === 'POST') {
          return Response.json(
            { statusCode: 400, message: 'refused', code: 'SCHEMA_IMPACT_UNACKNOWLEDGED', impact: REFUSING_IMPACT },
            { status: 400 },
          );
        }
        return undefined;
      });
      const { container } = renderWithProviders(<ContextSchemaDetailScreen id="s-1" />);
      await screen.findByText('triage_notes');
      await expandKind(/triage_notes/);
      expect(await axe(container)).toHaveNoViolations();

      // Variant 1 — all accept.
      fireEvent.click(screen.getByRole('button', { name: 'Publish' }));
      const dialog = await screen.findByRole('alertdialog');
      expect(await axe(dialog)).toHaveNoViolations();

      // Variant 2 — some refuse, with the acknowledgement rendered.
      fireEvent.click(within(dialog).getByRole('button', { name: 'Publish' }));
      await within(dialog).findByRole('checkbox');
      expect(await axe(dialog)).toHaveNoViolations();

      cleanup();
      vi.unstubAllGlobals();
      document.documentElement.classList.remove('dark');
    }
  });
});
