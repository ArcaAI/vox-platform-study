/**
 * TASK-1036 §3.6 (lane C4) — the Integration tab: how a developer reaches THIS workflow, as five
 * numbered steps (Authenticate → Connect → Send input → Receive output → Handle errors), each with
 * a vox-node, a vox (5.0) and a raw HTTP/SSE/socket snippet.
 *
 * What these cases pin, because none of it is visible to a compiler:
 *  - the steps are an ordered list with real headings, in the order a developer works;
 *  - Connect is filtered by the workflow's EFFECTIVE settings (legacy graphs fall back through
 *    `effectiveSettings`) — a connection the workflow does not enable is listed as off, never
 *    documented with a snippet;
 *  - a draft still shows the snippets, with the slug, under a "Publish this version" banner;
 *  - the Input / Output shapes come from the workflow's context schema, with required and PHI.
 */
import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { renderWithProviders } from '@/test/render';
import { IntegrationTab } from '../integration-tab';

const { definitionState, schemaState } = vi.hoisted(() => ({
  definitionState: { current: {} as Record<string, unknown> },
  schemaState: { current: { definition: null, versionNumber: null, isLoading: false } as Record<string, unknown> },
}));

vi.mock('../../../api/hooks', () => ({
  useWorkflowDefinition: () => definitionState.current,
}));
vi.mock('@/shared/catalog', () => ({
  useContextSchemaDefinition: () => schemaState.current,
}));
vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }) }));

const SCHEMA_DEFINITION = {
  schemaVersion: 1,
  kinds: [
    { key: 'message', label: 'Message', primitive: 'TEXT', phiClass: 'NON_PHI', required: true },
    {
      key: 'patient',
      label: 'Patient',
      primitive: 'STRUCTURED',
      phiClass: 'PHI',
      required: true,
      fields: { type: 'object', required: ['age'], properties: { age: { type: 'integer' } } },
    },
  ],
  outputs: [{ key: 'note', label: 'Note', primitive: 'TEXT' }],
};

interface DefinitionOverrides {
  status?: 'DRAFT' | 'VALIDATED' | 'PUBLISHED' | 'DEPRECATED';
  isActive?: boolean;
  settings?: unknown;
  nodes?: unknown[];
}

function useDefinition(overrides: DefinitionOverrides = {}): void {
  const settings =
    'settings' in overrides
      ? overrides.settings
      : { connections: ['api', 'sse'], sources: [], contextSchema: { contextSchemaId: 'cs-1', versionNumber: null } };
  definitionState.current = {
    isPending: false,
    isError: false,
    error: null,
    data: {
      etag: '"1"',
      data: {
        id: 'def-1',
        slug: 'discharge-summary',
        name: 'Discharge Summary',
        versionNumber: 3,
        status: overrides.status ?? 'PUBLISHED',
        isActive: overrides.isActive ?? true,
        graph: { version: 1, nodes: overrides.nodes ?? [{ id: 'n_trigger', type: 'core.trigger', config: {} }], edges: [], ...(settings === undefined ? {} : { settings }) },
      },
    },
  };
}

function codeOf(label: string): string {
  return screen.getByRole('group', { name: label }).textContent ?? '';
}

function selectLane(name: RegExp | string): void {
  const trigger = screen.getByRole('tab', { name });
  fireEvent.mouseDown(trigger);
  fireEvent.click(trigger);
}

beforeEach(() => {
  useDefinition();
  schemaState.current = { definition: SCHEMA_DEFINITION, versionNumber: 2, isLoading: false };
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('IntegrationTab — states', () => {
  it('shows skeletons, never a spinner or "Loading…", while the definition loads', () => {
    definitionState.current = { isPending: true, isError: false, error: null, data: undefined };
    const { container } = renderWithProviders(<IntegrationTab definitionId="def-1" />);
    expect(container.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(0);
    expect(screen.queryByText(/loading/i)).toBeNull();
  });

  it('says so when the definition cannot be read, instead of rendering a guide for nothing', () => {
    definitionState.current = { isPending: false, isError: true, error: new Error('boom'), data: undefined };
    renderWithProviders(<IntegrationTab definitionId="def-1" />);
    expect(screen.getByRole('alert').textContent).toMatch(/couldn.t read/i);
    expect(screen.queryByRole('list')).toBeNull();
  });
});

describe('IntegrationTab — the five steps', () => {
  it('is an ordered list of five numbered steps, each with its own heading, in order', () => {
    renderWithProviders(<IntegrationTab definitionId="def-1" />);
    const steps = screen.getByRole('list', { name: /integration steps/i });
    expect(steps.tagName).toBe('OL');
    const headings = within(steps).getAllByRole('heading', { level: 3 });
    expect(headings.map((heading) => heading.textContent)).toEqual([
      '1. Authenticate',
      '2. Connect',
      '3. Send input',
      '4. Receive output',
      '5. Handle errors',
    ]);
  });

  it('names the endpoint with a copy control', () => {
    renderWithProviders(<IntegrationTab definitionId="def-1" />);
    expect(screen.getByText('POST /workflows/discharge-summary/runs')).toBeTruthy();
    expect(screen.getByRole('button', { name: /copy the run endpoint/i })).toBeTruthy();
  });

  it('opens on vox-node and prints the RunHandle flow in the steps', () => {
    renderWithProviders(<IntegrationTab definitionId="def-1" />);
    expect(screen.getByRole('tab', { name: /vox-node/i }).getAttribute('aria-selected')).toBe('true');
    const send = codeOf('Send input — vox-node snippet');
    expect(send).toContain("hope.workflows.run('discharge-summary'");
    expect(send).toContain('idempotencyKey');
    const receive = codeOf('Receive output — vox-node snippet');
    expect(receive).toContain('run.text()');
    expect(receive).toContain('await run.result()');
  });

  it('the vox lane is the 5.0 browser API, and says so', () => {
    renderWithProviders(<IntegrationTab definitionId="def-1" />);
    selectLane(/vox \(browser\)/i);
    const send = codeOf('Send input — vox 5.0 (browser) snippet');
    expect(send).toContain("useRun({ workflow: 'discharge-summary' })");
    expect(screen.getAllByText(/vox 5\.0/i).length).toBeGreaterThan(0);
  });

  it('the raw lane is curl with run protocol v2, a resume cursor and the result route', () => {
    renderWithProviders(<IntegrationTab definitionId="def-1" />);
    selectLane(/raw/i);
    const send = codeOf('Send input — raw HTTP snippet');
    expect(send).toContain('/api/v1/workflows/discharge-summary/runs');
    expect(send).toContain('"input"');
    const receive = codeOf('Receive output — raw HTTP snippet');
    expect(receive).toContain('x-hope-run-protocol: 2');
    expect(receive).toContain('Last-Event-ID');
    expect(receive).toContain('/runs/$RUN_ID/result');
  });

  it('every step carries a snippet in the selected lane, for all three lanes', () => {
    renderWithProviders(<IntegrationTab definitionId="def-1" />);
    for (const lane of [/vox-node/i, /vox \(browser\)/i, /raw/i]) {
      selectLane(lane);
      const steps = screen.getByRole('list', { name: /integration steps/i });
      const items = within(steps).getAllByRole('listitem').filter((item) => item.parentElement === steps);
      expect(items).toHaveLength(5);
      for (const item of items) expect(within(item).getAllByRole('group').length, `${item.textContent?.slice(0, 20)} / ${String(lane)}`).toBeGreaterThan(0);
    }
  });

  it('names the exact scopes in the Authenticate step', () => {
    renderWithProviders(<IntegrationTab definitionId="def-1" />);
    const authenticate = screen.getByRole('heading', { name: '1. Authenticate' }).closest('li')!;
    expect(authenticate.textContent).toContain('workflow:run:write');
    expect(authenticate.textContent).toContain('workflow:run:read');
    expect(authenticate.textContent).toMatch(/X-Tenant-Id/);
  });
});

describe('IntegrationTab — lifecycle', () => {
  it('a published, active version has no banner', () => {
    renderWithProviders(<IntegrationTab definitionId="def-1" />);
    expect(screen.queryByText(/publish this version/i)).toBeNull();
  });

  it('a draft says to publish for a live endpoint — and still shows the snippets with the slug', () => {
    useDefinition({ status: 'DRAFT', isActive: false });
    renderWithProviders(<IntegrationTab definitionId="def-1" />);
    expect(screen.getByText(/publish this version to get a live endpoint/i)).toBeTruthy();
    expect(codeOf('Send input — vox-node snippet')).toContain("hope.workflows.run('discharge-summary'");
  });

  it('a validated (unpublished) version is treated as a draft', () => {
    useDefinition({ status: 'VALIDATED', isActive: false });
    renderWithProviders(<IntegrationTab definitionId="def-1" />);
    expect(screen.getByText(/publish this version to get a live endpoint/i)).toBeTruthy();
  });

  it('published but not active: the endpoint keeps resolving the ACTIVE version', () => {
    useDefinition({ status: 'PUBLISHED', isActive: false });
    renderWithProviders(<IntegrationTab definitionId="def-1" />);
    expect(screen.getByText(/published, not active/i)).toBeTruthy();
    expect(screen.queryByText(/publish this version/i)).toBeNull();
  });

  it('a deprecated version says its endpoint no longer serves', () => {
    useDefinition({ status: 'DEPRECATED', isActive: false });
    renderWithProviders(<IntegrationTab definitionId="def-1" />);
    expect(screen.getByText(/this version is deprecated/i)).toBeTruthy();
  });
});

describe('IntegrationTab — Connect follows the effective settings', () => {
  function connectionItem(name: RegExp): HTMLElement {
    const connect = screen.getByRole('heading', { name: '2. Connect' }).closest('li')!;
    return within(connect).getByText(name).closest('li')!;
  }

  it('lists all four connections and marks which this workflow enables', () => {
    useDefinition({ settings: { connections: ['api', 'sse'], sources: [] } });
    renderWithProviders(<IntegrationTab definitionId="def-1" />);
    expect(within(connectionItem(/^API$/)).getByText('Enabled')).toBeTruthy();
    expect(within(connectionItem(/Live stream \(SSE\)/)).getByText('Enabled')).toBeTruthy();
    expect(within(connectionItem(/^Socket$/)).getByText(/off in settings/i)).toBeTruthy();
    expect(within(connectionItem(/^Webhook$/)).getByText(/off in settings/i)).toBeTruthy();
  });

  it('documents only the enabled connections: no socket snippet when the socket is off', () => {
    useDefinition({ settings: { connections: ['api', 'sse'], sources: [] } });
    renderWithProviders(<IntegrationTab definitionId="def-1" />);
    selectLane(/raw/i);
    expect(screen.queryByRole('group', { name: 'Connect (socket) — raw HTTP snippet' })).toBeNull();
    expect(screen.getByRole('group', { name: 'Connect (SSE) — raw HTTP snippet' })).toBeTruthy();
    expect(screen.getByRole('group', { name: 'Connect (API) — raw HTTP snippet' })).toBeTruthy();
  });

  it('a socket workflow gets the ticket + websocat snippet with ?protocol=2', () => {
    useDefinition({ settings: { connections: ['api', 'socket'], sources: [] } });
    renderWithProviders(<IntegrationTab definitionId="def-1" />);
    selectLane(/raw/i);
    const socket = codeOf('Connect (socket) — raw HTTP snippet');
    expect(socket).toContain('websocat');
    expect(socket).toContain('protocol=2');
  });

  it('falls back to the legacy trigger kinds and output protocols when the graph has no settings', () => {
    useDefinition({
      settings: undefined,
      nodes: [
        { id: 'n_trigger', type: 'core.trigger', config: { kinds: ['api'] } },
        { id: 'n_out', type: 'core.output', config: { protocols: ['http', 'http-sse'] } },
      ],
    });
    renderWithProviders(<IntegrationTab definitionId="def-1" />);
    expect(within(connectionItem(/^API$/)).getByText('Enabled')).toBeTruthy();
    expect(within(connectionItem(/Live stream \(SSE\)/)).getByText('Enabled')).toBeTruthy();
    expect(within(connectionItem(/^Socket$/)).getByText(/off in settings/i)).toBeTruthy();
  });

  it('a workflow with no connection says nobody can call it yet', () => {
    useDefinition({ settings: { connections: [], sources: ['consultation'] } });
    renderWithProviders(<IntegrationTab definitionId="def-1" />);
    expect(screen.getAllByText(/no connection is enabled/i).length).toBeGreaterThan(0);
  });
});

describe('IntegrationTab — Input and Output shapes', () => {
  it('renders the input shape from the context schema with required and PHI', () => {
    renderWithProviders(<IntegrationTab definitionId="def-1" />);
    const table = screen.getByRole('table', { name: /input shape/i });
    const rows = within(table).getAllByRole('row').slice(1);
    const byField = Object.fromEntries(rows.map((row) => [within(row).getAllByRole('cell')[0].textContent, row]));
    expect(within(byField['patient.age']).getByText('Required')).toBeTruthy();
    expect(within(byField['patient.age']).getByText('PHI')).toBeTruthy();
    expect(within(byField['message']).queryByText('PHI')).toBeNull();
    expect(within(byField['message']).getByText('TEXT')).toBeTruthy();
  });

  it('renders the output shape', () => {
    renderWithProviders(<IntegrationTab definitionId="def-1" />);
    const table = screen.getByRole('table', { name: /output shape/i });
    expect(within(table).getByText('note')).toBeTruthy();
  });

  it('the example input in the Send step is built from the REQUIRED kinds of the shape', () => {
    renderWithProviders(<IntegrationTab definitionId="def-1" />);
    const send = codeOf('Send input — vox-node snippet');
    expect(send).toContain('"message": "…"');
    expect(send).toContain('"age": 0');
  });

  it('no schema: says the shape is not declared, rather than printing an empty table', () => {
    schemaState.current = { definition: null, versionNumber: null, isLoading: false };
    useDefinition({ settings: { connections: ['api'], sources: [] } });
    renderWithProviders(<IntegrationTab definitionId="def-1" />);
    expect(screen.getAllByText(/not declared/i).length).toBeGreaterThan(0);
    expect(screen.queryByRole('table', { name: /input shape/i })).toBeNull();
  });

  it('an inline schema in the settings is read without fetching anything', () => {
    schemaState.current = { definition: null, versionNumber: null, isLoading: false };
    useDefinition({
      settings: { connections: ['api'], sources: [], contextSchema: { inline: { type: 'object', required: ['note'], properties: { note: { type: 'string' } } } } },
    });
    renderWithProviders(<IntegrationTab definitionId="def-1" />);
    const table = screen.getByRole('table', { name: /input shape/i });
    expect(within(table).getByText('note')).toBeTruthy();
  });

  it('stream audio in goes up a socket (PCM16), and attachments are referenced by mediaId', () => {
    schemaState.current = {
      definition: {
        kinds: [
          { key: 'audio', label: 'Audio', primitive: 'STREAM_AUDIO', phiClass: 'PHI' },
          { key: 'scan', label: 'Scan', primitive: 'DOCUMENT', phiClass: 'PHI' },
        ],
        outputs: [],
      },
      versionNumber: 1,
      isLoading: false,
    };
    useDefinition({ settings: { connections: ['api', 'socket'], sources: [], contextSchema: { contextSchemaId: 'cs-1', versionNumber: null } } });
    renderWithProviders(<IntegrationTab definitionId="def-1" />);
    const send = screen.getByRole('heading', { name: '3. Send input' }).closest('li')!;
    expect(send.textContent).toMatch(/PCM16/);
    expect(send.textContent).toMatch(/mediaId/);
    expect(codeOf('Send input — vox-node snippet')).toContain('hope.stt');
  });
});

describe('IntegrationTab — accessibility', () => {
  it('has no axe violations on the default lane', async () => {
    renderWithProviders(
      <main>
        <IntegrationTab definitionId="def-1" />
      </main>,
    );
    expect(await axe(screen.getByRole('main'))).toHaveNoViolations();
  });

  it('has no axe violations on the raw lane of a draft', async () => {
    useDefinition({ status: 'DRAFT', isActive: false, settings: { connections: ['api', 'sse', 'socket'], sources: [] } });
    renderWithProviders(
      <main>
        <IntegrationTab definitionId="def-1" />
      </main>,
    );
    selectLane(/raw/i);
    expect(await axe(screen.getByRole('main'))).toHaveNoViolations();
  });
});
