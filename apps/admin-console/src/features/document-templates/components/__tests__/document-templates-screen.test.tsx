/**
 * Document Templates screen (TASK-810 task 14). `fetch` is stubbed at the
 * network boundary — no MSW, matching the house idiom.
 *
 * Covers the working-tenant gate, the catalog, the EMPTY/fallback reading that
 * an unconfigured tenant must get (generation fails open to the platform SOAP
 * shape, so "nothing configured" is a normal state and never an error), the
 * form allow-list enforced by a closed `<Select>`, section REORDERING (order is
 * contract, not formatting), publish-rejection surfacing in both shapes, the
 * version pin, and an axe scan in both themes.
 */

import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { renderWithProviders } from '@/test/render';
import { DOCUMENT_SECTION_FORMS, type DocumentTemplate, type DocumentTemplateVersion } from '../../api/types';
import { DocumentTemplatesScreen } from '../document-templates-screen';

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

// Radix Select scrolls the highlighted item into view on open; happy-dom has no layout engine.
beforeAll(() => {
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
});

/** Expand a section's collapsed Accordion item so its `SectionForm` fields render. */
async function expandSection(keyPattern: RegExp): Promise<void> {
  fireEvent.click(await screen.findByRole('button', { name: keyPattern }));
}

function template(overrides: Partial<DocumentTemplate> = {}): DocumentTemplate {
  return {
    id: 't-1',
    tenantId: 'tnt-1',
    slug: 'discharge_summary',
    name: 'Discharge Summary',
    description: null,
    status: 'PUBLISHED',
    pinnedVersionNumber: 1,
    isDefault: true,
    sourceTemplateSlug: null,
    templateLocked: false,
    version: 1,
    createdAt: '2026-08-01T10:00:00.000Z',
    updatedAt: '2026-08-01T10:00:00.000Z',
    ...overrides,
  };
}

function versionRow(overrides: Partial<DocumentTemplateVersion> = {}): DocumentTemplateVersion {
  return {
    id: 'v-1',
    templateId: 't-1',
    versionNumber: 1,
    shape: {
      schemaVersion: '1.0',
      title: 'Discharge Summary',
      globalInstruction: 'Be concise and faithful to the transcript.',
      sections: [
        { key: 'reason_for_admission', title: 'Reason for Admission', form: 'PROSE', instruction: 'Why the patient was admitted.' },
        { key: 'discharge_medications', title: 'Discharge Medications', form: 'BULLETS' },
      ],
    },
    compiled: { compilerVersion: '1', sectionKeys: ['reason_for_admission', 'discharge_medications'] },
    compilerVersion: '1',
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

const pathOf = (call: RecordedCall) => new URL(call.url, 'http://test.local').pathname;

function baseHandler(call: RecordedCall): Response | undefined {
  const path = pathOf(call);
  if (path === '/api/auth/session') return Response.json(session());
  if (path.includes('/users/me/settings')) return call.method === 'GET' ? Response.json([]) : Response.json({ ok: true });
  return undefined;
}

function stubScreen(custom: FetchHandler = () => undefined): RecordedCall[] {
  return stubFetch((call) => custom(call) ?? baseHandler(call));
}

/** The read paths a loaded catalog needs: list + detail (with ETag) + versions. */
function catalogHandler(templates: DocumentTemplate[], versions: DocumentTemplateVersion[], detail = templates[0]): FetchHandler {
  return (call) => {
    const path = pathOf(call);
    if (path === '/api/hope/admin/document-templates' && call.method === 'GET') return Response.json(templates);
    if (path === '/api/hope/admin/document-templates/t-1' && call.method === 'GET') return Response.json(detail, { headers: { etag: '"1"' } });
    if (path === '/api/hope/admin/document-templates/t-1/versions') return Response.json(versions);
    return undefined;
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  document.documentElement.classList.remove('dark');
  cleanup();
});

describe('DocumentTemplatesScreen', () => {
  it('asks an elevated session without a working tenant to pick one (no data queries fired)', async () => {
    const calls = stubScreen((call) => {
      if (pathOf(call) === '/api/auth/session') return Response.json(session({ workingTenantId: null }));
      return undefined;
    });
    renderWithProviders(<DocumentTemplatesScreen />);

    expect(await screen.findByText('Select a working tenant')).toBeDefined();
    expect(calls.every((call) => !call.url.includes('/admin/document-templates'))).toBe(true);
  });

  // --- The empty state, which is the whole point of a fail-open resolver ----

  it('reads an unconfigured tenant as a NORMAL state — names the platform fallback, never an error', async () => {
    stubScreen(catalogHandler([], []));
    renderWithProviders(<DocumentTemplatesScreen />);

    expect(await screen.findByRole('heading', { level: 1, name: 'Document Templates' })).toBeDefined();
    expect(await screen.findByText('No document templates yet')).toBeDefined();
    // The banner says what IS being generated today, and that nothing is broken.
    expect(await screen.findByText('Generating the platform SOAP Note shape')).toBeDefined();
    expect(screen.getByText(/has not authored a document template yet/)).toBeDefined();
    // Not an error surface, for assistive technology either: the shared `Alert`
    // primitive hardcodes the ASSERTIVE `role="alert"`, which would interrupt a
    // screen-reader user on every visit to announce an ordinary state. The
    // banner overrides it to the polite `status` — so there must be no `alert`
    // anywhere on a healthy, merely-unconfigured screen.
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('status').textContent).toContain('Generating the platform SOAP Note shape');
  });

  it('explains the silent trap: a template PINNED but left DRAFT is still not served', async () => {
    const draft = template({ status: 'DRAFT', pinnedVersionNumber: 3 });
    stubScreen(catalogHandler([draft], [versionRow()], draft));
    renderWithProviders(<DocumentTemplatesScreen />);

    expect(await screen.findByText('Generating the platform SOAP Note shape')).toBeDefined();
    expect(screen.getByText(/status is DRAFT, so it is not served/)).toBeDefined();
  });

  it('explains a catalog with templates but no default — resolution is by isDefault only', async () => {
    const notDefault = template({ isDefault: false });
    stubScreen(catalogHandler([notDefault], [versionRow()], notDefault));
    renderWithProviders(<DocumentTemplatesScreen />);

    expect(await screen.findByText('Generating the platform SOAP Note shape')).toBeDefined();
    expect(screen.getByText(/is marked as the default/)).toBeDefined();
  });

  it('confirms the served template and version when one actually resolves', async () => {
    stubScreen(catalogHandler([template()], [versionRow()]));
    renderWithProviders(<DocumentTemplatesScreen />);

    expect(await screen.findByText(/Generating “Discharge Summary” \(v1\)/)).toBeDefined();
  });

  // --- Authoring -----------------------------------------------------------

  it('lists a template and opens its detail drawer on the Shape tab by default', async () => {
    stubScreen(catalogHandler([template()], [versionRow()]));
    renderWithProviders(<DocumentTemplatesScreen />);

    fireEvent.click(await screen.findByText('Discharge Summary'));

    const drawer = await screen.findByRole('dialog');
    expect(await within(drawer).findByRole('tab', { name: /Shape/ })).toBeDefined();
    // Sections seed from the latest published version, collapsed, in order.
    expect(await within(drawer).findByText('reason_for_admission')).toBeDefined();
    expect(within(drawer).getByText('discharge_medications')).toBeDefined();
  });

  it('enforces the section-form allow-list with a CLOSED select — only the three platform forms, never free text', async () => {
    stubScreen(catalogHandler([template()], [versionRow()]));
    renderWithProviders(<DocumentTemplatesScreen />);

    fireEvent.click(await screen.findByText('Discharge Summary'));
    await expandSection(/reason_for_admission/);

    const trigger = await screen.findByRole('combobox', { name: /Form/ });
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: 'mouse' });
    const options = await screen.findAllByRole('option');
    expect(options.map((option) => option.textContent)).toEqual([...DOCUMENT_SECTION_FORMS]);
  });

  it('reorders sections with keyboard-reachable buttons and publishes the NEW order (order is contract, not formatting)', async () => {
    const calls = stubScreen((call) => {
      if (pathOf(call) === '/api/hope/admin/document-templates/t-1/publish' && call.method === 'POST') {
        return Response.json(template({ pinnedVersionNumber: 2 }));
      }
      return catalogHandler([template()], [versionRow()])(call);
    });
    renderWithProviders(<DocumentTemplatesScreen />, { searchParams: '?template=t-1&dttab=shape' });

    await expandSection(/discharge_medications/);
    // A single-pointer, keyboard-native alternative to dragging (WCAG 2.5.7).
    fireEvent.click(await screen.findByRole('button', { name: /Move Discharge Medications up/ }));

    fireEvent.click(screen.getByRole('button', { name: 'Publish' }));

    await waitFor(() => expect(calls.some((call) => call.method === 'POST' && pathOf(call).endsWith('/publish'))).toBe(true));
    const publishCall = calls.find((call) => call.method === 'POST' && pathOf(call).endsWith('/publish'));
    const shape = (publishCall?.body as { shape: { sections: { key: string }[] } }).shape;
    expect(shape.sections.map((section) => section.key)).toEqual(['discharge_medications', 'reason_for_admission']);
  });

  it('leaves a new section OPTIONAL by default — D-21: a required section cannot represent "not discussed"', async () => {
    const calls = stubScreen((call) => {
      if (pathOf(call) === '/api/hope/admin/document-templates/t-1/publish' && call.method === 'POST') {
        return Response.json(template({ pinnedVersionNumber: 2 }));
      }
      return catalogHandler([template()], [versionRow()])(call);
    });
    renderWithProviders(<DocumentTemplatesScreen />, { searchParams: '?template=t-1&dttab=shape' });

    fireEvent.click(await screen.findByRole('button', { name: /Add section/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Publish' }));

    await waitFor(() => expect(calls.some((call) => call.method === 'POST' && pathOf(call).endsWith('/publish'))).toBe(true));
    const publishCall = calls.find((call) => call.method === 'POST' && pathOf(call).endsWith('/publish'));
    const shape = (publishCall?.body as { shape: { sections: { required?: boolean }[] } }).shape;
    expect(shape.sections[2].required).toBeUndefined();
  });

  it('surfaces the server-reported structural `problems`, not a generic error', async () => {
    stubScreen((call) => {
      if (pathOf(call) === '/api/hope/admin/document-templates/t-1/publish' && call.method === 'POST') {
        return Response.json(
          {
            statusCode: 400,
            message: 'The document template shape is not publishable.',
            problems: ['shape.sections[1].key: duplicate key `discharge_medications`'],
          },
          { status: 400 },
        );
      }
      return catalogHandler([template()], [versionRow()])(call);
    });
    renderWithProviders(<DocumentTemplatesScreen />, { searchParams: '?template=t-1&dttab=shape' });

    fireEvent.click(await screen.findByRole('button', { name: 'Publish' }));

    expect(await screen.findByText('The shape is not publishable')).toBeDefined();
    expect(await screen.findByText(/duplicate key `discharge_medications`/)).toBeDefined();
  });

  it('refuses a breaking publish, lists the breaks, and republishes with allowBreakingChange after "Publish anyway"', async () => {
    let acknowledged = false;
    stubScreen((call) => {
      if (pathOf(call) === '/api/hope/admin/document-templates/t-1/publish' && call.method === 'POST') {
        const body = call.body as { allowBreakingChange?: boolean };
        if (body.allowBreakingChange === true) {
          acknowledged = true;
          return Response.json(template({ pinnedVersionNumber: 2 }));
        }
        return Response.json(
          {
            statusCode: 400,
            message: 'This shape breaks readers built against the current version.',
            breakingChanges: ['section `reason_for_admission` removed'],
          },
          { status: 400 },
        );
      }
      return catalogHandler([template()], [versionRow()])(call);
    });
    renderWithProviders(<DocumentTemplatesScreen />, { searchParams: '?template=t-1&dttab=shape' });

    fireEvent.click(await screen.findByRole('button', { name: 'Publish' }));

    expect(await screen.findByText('This change breaks readers built against the current version')).toBeDefined();
    expect(await screen.findByText('section `reason_for_admission` removed')).toBeDefined();

    fireEvent.click(await screen.findByRole('button', { name: 'Publish anyway' }));

    await waitFor(() => expect(acknowledged).toBe(true));
  });

  it('pins the template to an older version from the Versions tab', async () => {
    const pinned = template({ pinnedVersionNumber: 2 });
    const calls = stubScreen((call) => {
      if (pathOf(call) === '/api/hope/admin/document-templates/t-1/pin' && call.method === 'POST') {
        return Response.json(template({ pinnedVersionNumber: 1 }));
      }
      return catalogHandler([pinned], [versionRow(), versionRow({ id: 'v-2', versionNumber: 2 })], pinned)(call);
    });
    renderWithProviders(<DocumentTemplatesScreen />, { searchParams: '?template=t-1&dttab=versions' });

    fireEvent.click(await screen.findByRole('button', { name: 'Pin version 1' }));

    await waitFor(() => expect(calls.some((call) => call.method === 'POST' && pathOf(call).endsWith('/pin'))).toBe(true));
    const pinCall = calls.find((call) => call.method === 'POST' && pathOf(call).endsWith('/pin'));
    expect(pinCall?.body).toEqual({ versionNumber: 1 });
  });

  it('shows the server-computed versionSkew on a non-pinned version, and none on the pinned one', async () => {
    const pinned = template({ pinnedVersionNumber: 2 });
    stubScreen(
      catalogHandler([pinned], [versionRow({ id: 'v-2', versionNumber: 2 }), versionRow({ id: 'v-1', versionNumber: 1, versionSkew: 'BREAKING' })], pinned),
    );
    renderWithProviders(<DocumentTemplatesScreen />, { searchParams: '?template=t-1&dttab=versions' });

    expect(await screen.findByText('Pinned')).toBeDefined();
    expect(await screen.findByText('Breaking drift')).toBeDefined();
  });

  // --- Accessibility -------------------------------------------------------

  it('has no axe violations in the light theme (catalog, then the drawer with a section expanded)', async () => {
    stubScreen(catalogHandler([template()], [versionRow()]));
    const { container } = renderWithProviders(<DocumentTemplatesScreen />);
    await screen.findByText('Discharge Summary');
    expect(await axe(container)).toHaveNoViolations();

    fireEvent.click(screen.getByText('Discharge Summary'));
    await expandSection(/reason_for_admission/);
    // The drawer is portaled outside `container` and the rest of the page goes
    // `aria-hidden` while it is open — scan the dialog itself.
    expect(await axe(await screen.findByRole('dialog'))).toHaveNoViolations();
  });

  it('has no axe violations in the dark theme (catalog, then the drawer with a section expanded)', async () => {
    document.documentElement.classList.add('dark');
    stubScreen(catalogHandler([template()], [versionRow()]));
    const { container } = renderWithProviders(<DocumentTemplatesScreen />);
    await screen.findByText('Discharge Summary');
    expect(await axe(container)).toHaveNoViolations();

    fireEvent.click(screen.getByText('Discharge Summary'));
    await expandSection(/reason_for_admission/);
    expect(await axe(await screen.findByRole('dialog'))).toHaveNoViolations();
  });

  it('has no axe violations on the empty/fallback state, in both themes', async () => {
    stubScreen(catalogHandler([], []));
    const light = renderWithProviders(<DocumentTemplatesScreen />);
    await screen.findByText('No document templates yet');
    expect(await axe(light.container)).toHaveNoViolations();
    cleanup();

    document.documentElement.classList.add('dark');
    stubScreen(catalogHandler([], []));
    const dark = renderWithProviders(<DocumentTemplatesScreen />);
    await screen.findByText('No document templates yet');
    expect(await axe(dark.container)).toHaveNoViolations();
  });
});
