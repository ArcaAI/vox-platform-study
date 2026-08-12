/**
 * Context Schemas screen (TASK-666) — fetch is stubbed at the network
 * boundary. Covers the working-tenant gate, the schema catalog, the primitive
 * allow-list enforcement (closed `<Select>`), publish rejection surfacing
 * (structural `problems` and refused `breakingChanges`), deprecation
 * authoring, the sample-payload tester, version pin, and an axe scan in both
 * themes.
 */

import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { renderWithProviders } from '@/test/render';
import { CONTEXT_PRIMITIVES, type ConsultationContextSchema, type ConsultationContextSchemaVersion } from '../../api/types';
import { ContextSchemasScreen } from '../context-schemas-screen';

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

// Radix Select scrolls the highlighted item into view on open; happy-dom has no layout engine.
beforeAll(() => {
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
});

/** Expand a kind's collapsed Accordion item so its `KindForm` fields render (and become queryable). */
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
    user: { id: 'u-1', username: 'root', email: 'root@hope.local', roles: ['GLOBAL_ADMIN'] },
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

const pathOf = (call: RecordedCall) => new URL(call.url, 'http://test.local').pathname;

/** Read paths every test starts from: session, department directory, and settings passthrough. */
function baseHandler(call: RecordedCall): Response | undefined {
  const path = pathOf(call);
  if (path === '/api/auth/session') return Response.json(session());
  if (path === '/api/hope/admin/departments') return Response.json([]);
  if (path.includes('/user/me/settings')) return call.method === 'GET' ? Response.json([]) : Response.json({ ok: true });
  return undefined;
}

function stubScreen(custom: FetchHandler = () => undefined): RecordedCall[] {
  return stubFetch((call) => custom(call) ?? baseHandler(call));
}

afterEach(() => {
  vi.unstubAllGlobals();
  document.documentElement.classList.remove('dark');
  cleanup();
});

describe('ContextSchemasScreen', () => {
  it('asks an elevated session without a working tenant to pick one (no data queries fired)', async () => {
    const calls = stubScreen((call) => {
      if (pathOf(call) === '/api/auth/session') return Response.json(session({ workingTenantId: null }));
      return undefined;
    });
    renderWithProviders(<ContextSchemasScreen />);

    expect(await screen.findByText('Select a working tenant')).toBeDefined();
    expect(calls.every((call) => !call.url.includes('/admin/consultation-context-schemas'))).toBe(true);
  });

  it('lands on the Context Schemas catalog with an empty state when there are none', async () => {
    stubScreen((call) => {
      if (pathOf(call) === '/api/hope/admin/consultation-context-schemas') return Response.json([]);
      return undefined;
    });
    renderWithProviders(<ContextSchemasScreen />);

    expect(await screen.findByRole('heading', { level: 1, name: 'Context Schemas' })).toBeDefined();
    expect(await screen.findByText('No context schemas yet')).toBeDefined();
  });

  it('lists a schema and opens its detail drawer on the Definition tab by default', async () => {
    stubScreen((call) => {
      const path = pathOf(call);
      if (path === '/api/hope/admin/consultation-context-schemas') return Response.json([schema()]);
      if (path === '/api/hope/admin/consultation-context-schemas/s-1') return Response.json(schema(), { headers: { etag: '"1"' } });
      if (path === '/api/hope/admin/consultation-context-schemas/s-1/versions') return Response.json([versionRow()]);
      return undefined;
    });
    renderWithProviders(<ContextSchemasScreen />);

    fireEvent.click(await screen.findByText('General Medicine Context'));

    const drawer = await screen.findByRole('dialog');
    expect(await within(drawer).findByRole('tab', { name: /Definition/ })).toBeDefined();
    // Definition tab is the default landing tab and shows the seeded kind
    // (collapsed by default — its trigger text carries the key).
    expect(await within(drawer).findByText('triage_notes')).toBeDefined();
  });

  it('enforces the primitive allow-list with a CLOSED select — only the five platform primitives are offered, never free text', async () => {
    stubScreen((call) => {
      const path = pathOf(call);
      if (path === '/api/hope/admin/consultation-context-schemas') return Response.json([schema()]);
      if (path === '/api/hope/admin/consultation-context-schemas/s-1') return Response.json(schema(), { headers: { etag: '"1"' } });
      if (path === '/api/hope/admin/consultation-context-schemas/s-1/versions') return Response.json([versionRow()]);
      return undefined;
    });
    renderWithProviders(<ContextSchemasScreen />);

    fireEvent.click(await screen.findByText('General Medicine Context'));
    await expandKind(/triage_notes/);

    const trigger = await screen.findByRole('combobox', { name: /Primitive/ });
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: 'mouse' });
    const options = await screen.findAllByRole('option');
    expect(options.map((option) => option.textContent)).toEqual([...CONTEXT_PRIMITIVES]);
  });

  it('surfaces the server-reported structural `problems` on a not-publishable definition, not a generic error', async () => {
    stubScreen((call) => {
      const path = pathOf(call);
      if (path === '/api/hope/admin/consultation-context-schemas') return Response.json([schema()]);
      if (path === '/api/hope/admin/consultation-context-schemas/s-1') return Response.json(schema(), { headers: { etag: '"1"' } });
      if (path === '/api/hope/admin/consultation-context-schemas/s-1/versions') return Response.json([versionRow()]);
      if (path === '/api/hope/admin/consultation-context-schemas/s-1/publish' && call.method === 'POST') {
        return Response.json(
          {
            statusCode: 400,
            message: 'The context schema definition is not publishable.',
            problems: ["definition.kinds[0].primitive `WEIRD` is not one of STREAM_AUDIO | TEXT | DOCUMENT | IMAGE | STRUCTURED"],
          },
          { status: 400 },
        );
      }
      return undefined;
    });
    renderWithProviders(<ContextSchemasScreen />);

    fireEvent.click(await screen.findByText('General Medicine Context'));
    await screen.findByText('triage_notes');
    fireEvent.click(await screen.findByRole('button', { name: 'Publish' }));

    expect(await screen.findByText('The definition is not publishable')).toBeDefined();
    expect(await screen.findByText(/definition\.kinds\[0\]\.primitive `WEIRD`/)).toBeDefined();
  });

  it('refuses a breaking publish, lists the breaks, and republishes with allowBreakingChange after "Publish anyway"', async () => {
    let allowedBreakingChange = false;
    stubScreen((call) => {
      const path = pathOf(call);
      if (path === '/api/hope/admin/consultation-context-schemas') return Response.json([schema()]);
      if (path === '/api/hope/admin/consultation-context-schemas/s-1') return Response.json(schema(), { headers: { etag: '"1"' } });
      if (path === '/api/hope/admin/consultation-context-schemas/s-1/versions') return Response.json([versionRow()]);
      if (path === '/api/hope/admin/consultation-context-schemas/s-1/publish' && call.method === 'POST') {
        const body = call.body as { allowBreakingChange?: boolean };
        if (body.allowBreakingChange === true) {
          allowedBreakingChange = true;
          return Response.json(schema({ pinnedVersionNumber: 2 }));
        }
        return Response.json(
          {
            statusCode: 400,
            message: 'This definition breaks clients built against the current version — kind `triage_notes` removed.',
            breakingChanges: ['kind `triage_notes` removed'],
          },
          { status: 400 },
        );
      }
      return undefined;
    });
    renderWithProviders(<ContextSchemasScreen />);

    fireEvent.click(await screen.findByText('General Medicine Context'));
    await screen.findByText('triage_notes');
    fireEvent.click(await screen.findByRole('button', { name: 'Publish' }));

    expect(await screen.findByText('This change breaks clients built against the current version')).toBeDefined();
    expect(await screen.findByText('kind `triage_notes` removed')).toBeDefined();

    fireEvent.click(await screen.findByRole('button', { name: 'Publish anyway' }));

    await waitFor(() => expect(allowedBreakingChange).toBe(true));
  });

  it('authors a deprecation window on a kind (since/migrateBy/message)', async () => {
    stubScreen((call) => {
      const path = pathOf(call);
      if (path === '/api/hope/admin/consultation-context-schemas') return Response.json([schema()]);
      if (path === '/api/hope/admin/consultation-context-schemas/s-1') return Response.json(schema(), { headers: { etag: '"1"' } });
      if (path === '/api/hope/admin/consultation-context-schemas/s-1/versions') return Response.json([versionRow()]);
      return undefined;
    });
    renderWithProviders(<ContextSchemasScreen />);

    fireEvent.click(await screen.findByText('General Medicine Context'));
    await expandKind(/triage_notes/);

    fireEvent.click(screen.getByRole('switch', { name: /Mark this kind deprecated/ }));

    expect(await screen.findByLabelText(/Deprecated since/)).toBeDefined();
    expect(screen.getByLabelText('Migrate by')).toBeDefined();
  });

  it('validates a sample payload against the STRUCTURED kind in the current draft (Tester tab)', async () => {
    stubScreen((call) => {
      const path = pathOf(call);
      if (path === '/api/hope/admin/consultation-context-schemas') return Response.json([schema()]);
      if (path === '/api/hope/admin/consultation-context-schemas/s-1') return Response.json(schema(), { headers: { etag: '"1"' } });
      if (path === '/api/hope/admin/consultation-context-schemas/s-1/versions') return Response.json([versionRow()]);
      return undefined;
    });
    // Land directly on the Tester tab via the URL (the house pattern for
    // Radix-tab-dependent content — see `agent-detail-drawer.test.tsx`).
    renderWithProviders(<ContextSchemasScreen />, { searchParams: '?schema=s-1&cstab=tester' });

    const editor = await screen.findByLabelText('Sample payload');
    fireEvent.change(editor, { target: { value: '{"severity":"catastrophic"}' } });
    fireEvent.click(screen.getByRole('button', { name: 'Validate' }));

    expect(await screen.findByText(/Payload does not conform/)).toBeDefined();
    expect(screen.getByText(/must be one of the declared enum values/)).toBeDefined();
  });

  it('pins the schema to an older version from the Versions tab', async () => {
    const calls = stubScreen((call) => {
      const path = pathOf(call);
      if (path === '/api/hope/admin/consultation-context-schemas') return Response.json([schema({ pinnedVersionNumber: 2 })]);
      if (path === '/api/hope/admin/consultation-context-schemas/s-1') {
        return Response.json(schema({ pinnedVersionNumber: 2 }), { headers: { etag: '"2"' } });
      }
      if (path === '/api/hope/admin/consultation-context-schemas/s-1/versions') {
        return Response.json([versionRow(), versionRow({ id: 'v-2', versionNumber: 2 })]);
      }
      if (path === '/api/hope/admin/consultation-context-schemas/s-1/pin' && call.method === 'POST') {
        return Response.json(schema({ pinnedVersionNumber: 1 }));
      }
      return undefined;
    });
    renderWithProviders(<ContextSchemasScreen />, { searchParams: '?schema=s-1&cstab=versions' });

    fireEvent.click(await screen.findByRole('button', { name: 'Pin' }));

    await waitFor(() => expect(calls.some((call) => call.method === 'POST' && pathOf(call).endsWith('/pin'))).toBe(true));
    const pinCall = calls.find((call) => call.method === 'POST' && pathOf(call).endsWith('/pin'));
    expect(pinCall?.body).toEqual({ versionNumber: 1 });
  });

  it('shows the server-computed versionSkew on a non-pinned version, and none on the pinned one (TASK-674)', async () => {
    stubScreen((call) => {
      const path = pathOf(call);
      if (path === '/api/hope/admin/consultation-context-schemas') return Response.json([schema({ pinnedVersionNumber: 2 })]);
      if (path === '/api/hope/admin/consultation-context-schemas/s-1') {
        return Response.json(schema({ pinnedVersionNumber: 2 }), { headers: { etag: '"2"' } });
      }
      if (path === '/api/hope/admin/consultation-context-schemas/s-1/versions') {
        return Response.json([versionRow({ id: 'v-2', versionNumber: 2 }), versionRow({ id: 'v-1', versionNumber: 1, versionSkew: 'BREAKING' })]);
      }
      return undefined;
    });
    renderWithProviders(<ContextSchemasScreen />, { searchParams: '?schema=s-1&cstab=versions' });

    expect(await screen.findByText('Pinned')).toBeDefined();
    expect(await screen.findByText('Breaking drift')).toBeDefined();
  });

  it('has no axe violations on the Versions tab with a versionSkew badge, in both themes (TASK-674)', async () => {
    function stubVersionsTab() {
      return stubScreen((call) => {
        const path = pathOf(call);
        if (path === '/api/hope/admin/consultation-context-schemas') return Response.json([schema({ pinnedVersionNumber: 2 })]);
        if (path === '/api/hope/admin/consultation-context-schemas/s-1') {
          return Response.json(schema({ pinnedVersionNumber: 2 }), { headers: { etag: '"2"' } });
        }
        if (path === '/api/hope/admin/consultation-context-schemas/s-1/versions') {
          return Response.json([versionRow({ id: 'v-2', versionNumber: 2 }), versionRow({ id: 'v-1', versionNumber: 1, versionSkew: 'ADDITIVE' })]);
        }
        return undefined;
      });
    }

    // The drawer is portaled outside `container` and, while open, the rest of
    // the page goes `aria-hidden` — scan the dialog itself, matching the
    // catalog+drawer axe tests below.
    stubVersionsTab();
    renderWithProviders(<ContextSchemasScreen />, { searchParams: '?schema=s-1&cstab=versions' });
    expect(await screen.findByText(/Additive drift/)).toBeDefined();
    expect(await axe(await screen.findByRole('dialog'))).toHaveNoViolations();
    cleanup();

    document.documentElement.classList.add('dark');
    stubVersionsTab();
    renderWithProviders(<ContextSchemasScreen />, { searchParams: '?schema=s-1&cstab=versions' });
    expect(await screen.findByText(/Additive drift/)).toBeDefined();
    expect(await axe(await screen.findByRole('dialog'))).toHaveNoViolations();
  });

  it('has no axe violations in the light theme (catalog, then the drawer with a kind expanded)', async () => {
    stubScreen((call) => {
      const path = pathOf(call);
      if (path === '/api/hope/admin/consultation-context-schemas') return Response.json([schema()]);
      if (path === '/api/hope/admin/consultation-context-schemas/s-1') return Response.json(schema(), { headers: { etag: '"1"' } });
      if (path === '/api/hope/admin/consultation-context-schemas/s-1/versions') return Response.json([versionRow()]);
      return undefined;
    });
    const { container } = renderWithProviders(<ContextSchemasScreen />);
    await screen.findByText('General Medicine Context');
    expect(await axe(container)).toHaveNoViolations();

    fireEvent.click(screen.getByText('General Medicine Context'));
    await expandKind(/triage_notes/);
    // The drawer is portaled outside `container` — scan the dialog itself
    // (Radix's own focus-guard siblings and the now-inert background are
    // its concern, not ours; see `discovery-drawer.test.tsx`).
    const dialog = await screen.findByRole('dialog');
    expect(await axe(dialog)).toHaveNoViolations();
  });

  it('has no axe violations in the dark theme (catalog, then the drawer with a kind expanded)', async () => {
    document.documentElement.classList.add('dark');
    stubScreen((call) => {
      const path = pathOf(call);
      if (path === '/api/hope/admin/consultation-context-schemas') return Response.json([schema()]);
      if (path === '/api/hope/admin/consultation-context-schemas/s-1') return Response.json(schema(), { headers: { etag: '"1"' } });
      if (path === '/api/hope/admin/consultation-context-schemas/s-1/versions') return Response.json([versionRow()]);
      return undefined;
    });
    const { container } = renderWithProviders(<ContextSchemasScreen />);
    await screen.findByText('General Medicine Context');
    expect(await axe(container)).toHaveNoViolations();

    fireEvent.click(screen.getByText('General Medicine Context'));
    await expandKind(/triage_notes/);
    const dialog = await screen.findByRole('dialog');
    expect(await axe(dialog)).toHaveNoViolations();
  });
});
