/**
 * TASK-965 — `IntegrationPanel`, the console-shared "how developers reach this" surface for a
 * published agent or workflow. Everything derives from the lineage (slug, task/palette, active
 * flag), never from a publish response, so it can be rendered at any later time.
 *
 * TASK-971 lanes B + C — the panel now carries FOUR lanes (Node · Browser · HTTP · Postman) and
 * an example body derived from the lineage's OWN input schema. The assertions below exist to pin
 * the three things that were silently wrong or absent before, and that no compiler can catch:
 *
 *   1. the agent body is FLAT and the workflow body is ENVELOPED — getting it backwards was a
 *      400 on every call, and the panel is where a developer reads the contract;
 *   2. two browser cells do not exist (`SPEECH_TO_TEXT`, `TEXT_TO_SPEECH` by slug), so they are
 *      rendered as absences naming the real path — never as an invented snippet;
 *   3. NER shares the invocations route but is one-shot, so no lane may offer it a stream.
 */
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { renderWithProviders } from '@/test/render';
import type { PostmanCollection, PostmanItem } from '@/shared/docs/postman-collection';
import { IntegrationPanel } from '../integration-panel';

/** The agent's own declared input — the example body in every lane must come from HERE. */
const AGENT_INPUT_SCHEMA = {
  type: 'object',
  required: ['text', 'tone'],
  properties: {
    text: { type: 'string' },
    tone: { type: 'string', enum: ['clinical', 'plain'] },
  },
};

/** `GET workflows/{slug}/schema` — `modes` AND the `components` pair the panel used to discard. */
function stubSchemaFetch(status = 200): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async () =>
    status === 200
      ? Response.json({
          slug: 'discharge-summary',
          versionNumber: 3,
          modes: ['async', 'blocking', 'stream', 'socket'],
          components: {
            Workflow_discharge_summary_Input: {
              type: 'object',
              required: ['dischargeDate'],
              properties: { dischargeDate: { type: 'string' }, ward: { type: 'string' } },
            },
          },
        })
      : Response.json({ message: 'Not found.' }, { status }),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** Radix activates a tab on mousedown; the click keeps the interaction honest for the a11y tree. */
function selectTab(name: string): void {
  const trigger = screen.getByRole('tab', { name });
  fireEvent.mouseDown(trigger);
  fireEvent.click(trigger);
}

function codeOf(label: string): string {
  return screen.getByRole('group', { name: label }).textContent ?? '';
}

/** The rendered Postman tab, parsed — assertions about REQUESTS must not be substring matches. */
function collectionOf(): PostmanCollection {
  return JSON.parse(codeOf('Postman collection JSON')) as PostmanCollection;
}

function streamRequestsIn(collection: PostmanCollection): PostmanItem[] {
  return collection.item.filter((entry) => (entry.request.url.query ?? []).some((q) => q.key === 'mode' && q.value === 'stream'));
}

afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
});

describe('IntegrationPanel — agent', () => {
  it('renders the task-shaped endpoint, the vox-node snippet and the API-keys link', async () => {
    // Hosted in a landmark, as the drawer/dialog hosts it in the app — axe's `region` rule
    // otherwise flags the bare document body, not the panel.
    renderWithProviders(
      <main>
        <IntegrationPanel kind="agent" slug="clinic-summarizer" task="TEXT_GENERATION" versionNumber={2} isActive />
      </main>,
    );

    expect(screen.getByText('POST /agents/clinic-summarizer/invocations')).toBeTruthy();
    expect(screen.getByText(/\?mode=blocking/)).toBeTruthy();
    expect(screen.getByRole('group', { name: /vox-node/i }).textContent).toContain("hope.agents.invoke('clinic-summarizer'");
    expect((screen.getByRole('link', { name: /api keys/i }) as HTMLAnchorElement).getAttribute('href')).toBe('/api-keys');
    expect(await axe(screen.getByRole('main'))).toHaveNoViolations();
  });

  it('a speech agent gets the transcriptions route; NER shares the invocations route without the stream note', () => {
    const { unmount } = renderWithProviders(<IntegrationPanel kind="agent" slug="asr" task="SPEECH_TO_TEXT" />);
    expect(screen.getByText('POST /agents/asr/transcriptions')).toBeTruthy();
    unmount();

    renderWithProviders(<IntegrationPanel kind="agent" slug="ner" task="NAMED_ENTITY_RECOGNITION" />);
    expect(screen.getByText('POST /agents/ner/invocations')).toBeTruthy();
    expect(screen.queryByText(/\?mode=stream/)).toBeNull();
  });

  // Lanes C and D were built in parallel against a shared contract, and this is the seam between
  // them: the panel maps NER onto TEXT_GENERATION before handing the task over (they share the
  // route), so the collection builder cannot tell the two apart on `task` alone. Without the
  // explicit flag it emits the `?mode=stream` request that TEXT_GENERATION deserves and NER
  // answers with a 400 — a dead request shipped inside a downloadable file.
  it('a NER agent gets no ?mode=stream REQUEST in its Postman collection, only the warning', () => {
    renderWithProviders(<IntegrationPanel kind="agent" slug="ner" task="NAMED_ENTITY_RECOGNITION" inputSchema={AGENT_INPUT_SCHEMA} />);
    selectTab('Postman');

    const collection = collectionOf();
    expect(streamRequestsIn(collection)).toHaveLength(0);
    expect(collection.item.map((entry) => entry.request.url.raw)).toEqual(['{{baseUrl}}/api/v1/agents/ner/invocations']);
    // Asserted on the parsed REQUESTS above rather than on the raw text, because the surviving
    // blocking request explains the rule in prose — "`?mode=stream` … answers 400
    // `MODE_UNSUPPORTED`" — and a substring match cannot tell a live request from a warning
    // against one. It should still say so.
    expect(JSON.stringify(collection)).toContain('MODE_UNSUPPORTED');
  });

  it('a TEXT_GENERATION agent still gets one', () => {
    renderWithProviders(<IntegrationPanel kind="agent" slug="clinic-summarizer" task="TEXT_GENERATION" inputSchema={AGENT_INPUT_SCHEMA} />);
    selectTab('Postman');
    expect(streamRequestsIn(collectionOf())).toHaveLength(1);
  });

  it('says the endpoint resolves the ACTIVE version when this one is not it', () => {
    renderWithProviders(<IntegrationPanel kind="agent" slug="clinic-summarizer" task="TEXT_GENERATION" versionNumber={3} isActive={false} />);
    expect(screen.getByText(/published, not active/i)).toBeTruthy();
    expect(screen.getByText('POST /agents/clinic-summarizer/invocations')).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// TASK-971 lane B — the example body comes from the lineage's own schema
// ---------------------------------------------------------------------------

describe('IntegrationPanel — the example body is derived, not invented', () => {
  it('an agent body is FLAT and carries the schema-derived fields', () => {
    renderWithProviders(<IntegrationPanel kind="agent" slug="clinic-summarizer" task="TEXT_GENERATION" inputSchema={AGENT_INPUT_SCHEMA} />);

    const node = codeOf('Node.js (@arcaai/vox-node) snippet');
    expect(node).toContain('"tone": "clinical"');
    expect(node).toContain('"text": "…"');
    // Flat: the `{ input: … }` envelope belongs to the workflow plane and is a 400 here.
    expect(node).not.toMatch(/"input"\s*:/);
    expect(node).not.toMatch(/\binput:\s*\{/);
  });

  it('falls back to the documented flat minimum when the agent declares no usable schema', () => {
    renderWithProviders(<IntegrationPanel kind="agent" slug="clinic-summarizer" task="TEXT_GENERATION" inputSchema={null} />);
    expect(codeOf('Node.js (@arcaai/vox-node) snippet')).toContain('"text"');
  });

  it('a workflow body is ENVELOPED and carries the fields from components[Workflow_<slug>_Input]', async () => {
    stubSchemaFetch();
    renderWithProviders(<IntegrationPanel kind="workflow" slug="discharge-summary" />);

    await screen.findByText('POST /workflows/discharge-summary/runs');
    const node = codeOf('Node.js (@arcaai/vox-node) snippet');
    expect(node).toContain('input:');
    expect(node).toContain('"dischargeDate": "…"');
    // `required` narrows: `ward` is declared but optional, so the minimal body omits it.
    expect(node).not.toContain('ward');
  });
});

// ---------------------------------------------------------------------------
// TASK-971 lane C — four lanes
// ---------------------------------------------------------------------------

describe('IntegrationPanel — the four lanes', () => {
  it('offers Node, Browser, HTTP and Postman, with Node first', () => {
    renderWithProviders(<IntegrationPanel kind="agent" slug="clinic-summarizer" task="TEXT_GENERATION" inputSchema={AGENT_INPUT_SCHEMA} />);

    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['Node', 'Browser', 'HTTP', 'Postman']);
    expect(screen.getByRole('tab', { name: 'Node' }).getAttribute('data-state')).toBe('active');
  });

  it('the browser lane defaults to a session JWT and states the API-key exposure beneath it', () => {
    renderWithProviders(<IntegrationPanel kind="agent" slug="clinic-summarizer" task="TEXT_GENERATION" inputSchema={AGENT_INPUT_SCHEMA} />);
    selectTab('Browser');

    const primary = codeOf('Browser (@arcaai/vox) snippet');
    expect(primary).toContain('accessToken');
    expect(primary).toContain('useAgentInvocation');
    // `/api/v1` is part of the browser SDK's baseUrl; omitting it 404s every call.
    expect(primary).toContain('/api/v1');
    expect(codeOf('Browser (@arcaai/vox) API-key variant')).toContain('apiKey');
    expect(screen.getByText(/readable by anyone/i)).toBeTruthy();
    expect(screen.getByText(/agent:invocation:write/)).toBeTruthy();
  });

  it('the browser lane for SPEECH_TO_TEXT states the absence and names the real path — no snippet', () => {
    renderWithProviders(<IntegrationPanel kind="agent" slug="asr" task="SPEECH_TO_TEXT" />);
    selectTab('Browser');

    expect(screen.queryAllByRole('group')).toHaveLength(0);
    expect(screen.getByText(/no browser path by slug/i)).toBeTruthy();
    expect(screen.getByText(/audio\.start/)).toBeTruthy();
    expect(screen.getByText(/audio\/transcription-jobs\/transcribe/)).toBeTruthy();
  });

  it('the browser lane for TEXT_TO_SPEECH states the absence and names the voice-selected route — no snippet', () => {
    renderWithProviders(<IntegrationPanel kind="agent" slug="voice" task="TEXT_TO_SPEECH" />);
    selectTab('Browser');

    expect(screen.queryAllByRole('group')).toHaveLength(0);
    expect(screen.getByText(/no browser path by slug/i)).toBeTruthy();
    expect(screen.getByText(/speech\/synthesize/)).toBeTruthy();
    expect(screen.getByText(/useTtsPlayback/)).toBeTruthy();
  });

  it('the HTTP lane is curl against the api/v1 prefix, and shows the stream call for text generation', () => {
    renderWithProviders(<IntegrationPanel kind="agent" slug="clinic-summarizer" task="TEXT_GENERATION" inputSchema={AGENT_INPUT_SCHEMA} />);
    selectTab('HTTP');

    const curl = codeOf('curl snippet');
    expect(curl).toContain('/api/v1/agents/clinic-summarizer/invocations');
    expect(curl).toContain('X-API-Key');
    expect(curl).toContain('"tone": "clinical"');
    expect(curl).toContain('?mode=stream');
    expect(curl).not.toMatch(/"input"\s*:/);
    // The tenant binds to the credential; sending it too is the mistake this line prevents.
    expect(screen.getByText(/X-Tenant-Id/)).toBeTruthy();
  });

  it('NER offers no stream example in ANY lane', () => {
    renderWithProviders(<IntegrationPanel kind="agent" slug="ner" task="NAMED_ENTITY_RECOGNITION" />);

    expect(codeOf('Node.js (@arcaai/vox-node) snippet')).not.toContain('mode=stream');
    selectTab('Browser');
    expect(codeOf('Browser (@arcaai/vox) snippet')).not.toContain('stream(');
    selectTab('HTTP');
    expect(codeOf('curl snippet')).not.toContain('mode=stream');
  });

  it('the agent panel says the body is flat, and never claims an envelope', () => {
    renderWithProviders(<IntegrationPanel kind="agent" slug="clinic-summarizer" task="TEXT_GENERATION" inputSchema={AGENT_INPUT_SCHEMA} />);
    expect(screen.getByText(/the body is flat/i)).toBeTruthy();
  });
});

describe('IntegrationPanel — workflow', () => {
  it('reads the run contract: endpoint, the ?mode= set without socket, the snippet and the link', async () => {
    stubSchemaFetch();
    renderWithProviders(<IntegrationPanel kind="workflow" slug="discharge-summary" />);

    expect(await screen.findByText('POST /workflows/discharge-summary/runs')).toBeTruthy();
    expect(screen.getByText('async')).toBeTruthy();
    expect(screen.getByText('stream')).toBeTruthy();
    expect(screen.queryByText('socket')).toBeNull();
    expect(screen.getByRole('group', { name: /vox-node/i }).textContent).toContain('discharge-summary');
    expect((screen.getByRole('link', { name: /api keys/i }) as HTMLAnchorElement).getAttribute('href')).toBe('/api-keys');
  });

  it('not active: explains and never fetches', () => {
    const fetchMock = stubSchemaFetch();
    renderWithProviders(<IntegrationPanel kind="workflow" slug="discharge-summary" isActive={false} />);
    expect(screen.getByText(/published, not active/i)).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a non-exposable palette: names the palette rule and never fetches', () => {
    const fetchMock = stubSchemaFetch();
    renderWithProviders(<IntegrationPanel kind="workflow" slug="discharge-summary" exposable={false} paletteKey="stt" />);
    expect(screen.getByText(/not exposable/i)).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a 404 names the exposure gate rather than a retry', async () => {
    stubSchemaFetch(404);
    renderWithProviders(<IntegrationPanel kind="workflow" slug="discharge-summary" />);
    expect(await screen.findByText(/workflow exposure/i)).toBeTruthy();
  });

  it('shows a skeleton, not a spinner, while the run contract is resolving', () => {
    stubSchemaFetch();
    const { container } = renderWithProviders(<IntegrationPanel kind="workflow" slug="discharge-summary" />);
    expect(container.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(0);
  });

  it('says the body is enveloped AND that a user JWT needs the ability an API key does not', async () => {
    stubSchemaFetch();
    renderWithProviders(
      <main>
        <IntegrationPanel kind="workflow" slug="discharge-summary" />
      </main>,
    );

    await screen.findByText('POST /workflows/discharge-summary/runs');
    expect(screen.getByText(/the body is enveloped/i)).toBeTruthy();
    expect(screen.getByText(/create:WorkflowRun/)).toBeTruthy();
    expect(await axe(screen.getByRole('main'))).toHaveNoViolations();
  });

  it('the browser lane starts a run async and WATCHES it — never ?mode=', async () => {
    stubSchemaFetch();
    renderWithProviders(<IntegrationPanel kind="workflow" slug="discharge-summary" />);

    await screen.findByText('POST /workflows/discharge-summary/runs');
    selectTab('Browser');
    const browser = codeOf('Browser (@arcaai/vox) snippet');
    expect(browser).toContain('useWorkflowRun');
    expect(browser).toContain('start(');
    expect(browser).toContain('watch(');
    expect(browser).not.toContain('mode=');
  });

  it('the HTTP lane starts async, polls the run, and follows the SSE stream', async () => {
    stubSchemaFetch();
    renderWithProviders(<IntegrationPanel kind="workflow" slug="discharge-summary" />);

    await screen.findByText('POST /workflows/discharge-summary/runs');
    selectTab('HTTP');
    const curl = codeOf('curl snippet');
    expect(curl).toContain('/api/v1/workflows/discharge-summary/runs');
    expect(curl).toContain('"input"');
    expect(curl).toContain('runId');
    expect(curl).toContain('/stream');
  });
});

// ---------------------------------------------------------------------------
// TASK-971 lane C / D boundary — the Postman tab
// ---------------------------------------------------------------------------

describe('IntegrationPanel — the Postman lane', () => {
  let downloadName: string | null = null;

  beforeEach(() => {
    downloadName = null;
    (URL as unknown as { createObjectURL: unknown }).createObjectURL = vi.fn(() => 'blob:collection');
    (URL as unknown as { revokeObjectURL: unknown }).revokeObjectURL = vi.fn();
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function click(this: HTMLAnchorElement) {
      downloadName = this.download;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete (URL as unknown as { createObjectURL?: unknown }).createObjectURL;
    delete (URL as unknown as { revokeObjectURL?: unknown }).revokeObjectURL;
  });

  it('renders an importable collection that embeds NO credential', () => {
    renderWithProviders(<IntegrationPanel kind="agent" slug="clinic-summarizer" task="TEXT_GENERATION" inputSchema={AGENT_INPUT_SCHEMA} />);
    selectTab('Postman');

    const collection = JSON.parse(codeOf('Postman collection JSON')) as {
      info: { schema: string };
      variable: Array<{ key: string; value: string }>;
      item: Array<{ request: { body?: { raw: string } } }>;
    };

    expect(collection.info.schema).toContain('collection/v2.1.0');
    // The console knows the operator's session, never a tenant API key — and a downloaded file
    // ends up in chat threads and tickets. The variable ships EMPTY, always.
    expect(collection.variable.find((entry) => entry.key === 'apiKey')?.value).toBe('');
    expect(collection.variable.find((entry) => entry.key === 'baseUrl')?.value).toBeTruthy();
    expect(collection.item.length).toBeGreaterThan(0);
    expect(collection.item[0]?.request.body?.raw).toContain('"tone": "clinical"');
  });

  it('downloads the collection as a named .json file', () => {
    renderWithProviders(<IntegrationPanel kind="agent" slug="clinic-summarizer" task="TEXT_GENERATION" inputSchema={AGENT_INPUT_SCHEMA} />);
    selectTab('Postman');
    fireEvent.click(screen.getByRole('button', { name: /download the postman collection/i }));

    expect(downloadName).toBe('hope-clinic-summarizer.postman_collection.json');
    expect(URL.createObjectURL).toHaveBeenCalled();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:collection');
  });

  it('a workflow collection carries the run envelope, not a flat body', async () => {
    stubSchemaFetch();
    renderWithProviders(<IntegrationPanel kind="workflow" slug="discharge-summary" />);

    await screen.findByText('POST /workflows/discharge-summary/runs');
    selectTab('Postman');
    const collection = JSON.parse(codeOf('Postman collection JSON')) as { item: Array<{ request: { body?: { raw: string } } }> };
    expect(collection.item[0]?.request.body?.raw).toContain('"input"');
    expect(collection.item[0]?.request.body?.raw).toContain('"dischargeDate"');
  });
});
