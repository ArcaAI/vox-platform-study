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
 *
 * TASK-975 lanes A, B, C — three more things that were absent rather than wrong:
 *
 *   4. the panel linked exactly ONE destination (`/api-keys`), so the three REST surfaces that
 *      already existed were reported as "missing" — including from the three workflow early
 *      returns, which rendered an alert and no onward path at all;
 *   5. the socket lane was undocumented everywhere in the console, while shipping in both SDKs;
 *   6. the Postman lane was a correct file dumped as ~200 lines of raw JSON with no manifest.
 */
import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { renderWithProviders } from '@/test/render';
import type { PostmanCollection, PostmanItem } from '@/shared/docs/postman-collection';
import { SOCKET_LANE_RATIONALE, SOCKET_RUNTIME_FLOOR } from '@/shared/docs/socket-snippets';
import { IntegrationPanel } from '../integration-panel';

/** The three developer-portal screens the panel must hand a developer on its way out (lane A). */
const DEVELOPER_HREFS = ['/developer/invoke', '/developer/reference', '/developer/sdk'];

function renderedHrefs(): string[] {
  return screen.getAllByRole('link').map((link) => link.getAttribute('href') ?? '');
}

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

/**
 * TASK-983 lane I — the panel now has TWO levels of tabs: the LANE (Node · Browser · Manual ·
 * Postman) and, inside a lane, the JOB (Batch · Realtime). `getAllByRole('tab')` therefore sees
 * both, so every lane-level assertion scopes itself to the first tablist.
 */
function laneTabNames(): string[] {
  return within(screen.getAllByRole('tablist')[0])
    .getAllByRole('tab')
    .map((tab) => tab.textContent);
}

/** Select the Batch or Realtime view inside whichever lane is open. */
function selectJob(name: 'Batch' | 'Realtime' | 'Blocking' | 'Realtime (SSE)'): void {
  const lists = screen.getAllByRole('tablist');
  const jobList = lists.find((list) => within(list).queryByRole('tab', { name }) !== null);
  if (!jobList) throw new Error(`no job view named ${name}`);
  const trigger = within(jobList).getByRole('tab', { name });
  fireEvent.mouseDown(trigger);
  fireEvent.click(trigger);
}

function codeOf(label: string): string {
  return screen.getByRole('group', { name: label }).textContent ?? '';
}

/**
 * TASK-975 C2 — the raw file now sits behind a COLLAPSED disclosure, so every assertion about its
 * contents opens it first. It stays complete and unabridged once opened: reading it before
 * importing is the only way a developer can see for themselves that no credential travels with it.
 */
function openRawCollection(): void {
  fireEvent.click(screen.getByRole('button', { name: /raw collection/i }));
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
    expect(screen.getAllByText(/\?mode=blocking/).length).toBeGreaterThan(0);
    expect(screen.getByRole('group', { name: 'Node.js (@arcaai/vox-node) snippet' }).textContent).toContain("hope.agents.invoke('clinic-summarizer'");
    expect((screen.getByRole('link', { name: /api keys/i }) as HTMLAnchorElement).getAttribute('href')).toBe('/api-keys');
    expect(await axe(screen.getByRole('main'))).toHaveNoViolations();
  });

  it('a speech agent gets the transcriptions route; NER shares the invocations route without the stream note', () => {
    const { unmount } = renderWithProviders(<IntegrationPanel kind="agent" slug="asr" task="SPEECH_TO_TEXT" />);
    expect(screen.getByText('POST /agents/asr/transcriptions')).toBeTruthy();
    unmount();

    renderWithProviders(<IntegrationPanel kind="agent" slug="ner" task="NAMED_ENTITY_RECOGNITION" />);
    expect(screen.getByText('POST /agents/ner/invocations')).toBeTruthy();
    // One-shot: NER gets no Realtime view at all, in any lane.
    expect(screen.queryByRole('tab', { name: 'Realtime (SSE)' })).toBeNull();
  });

  // Lanes C and D were built in parallel against a shared contract, and this is the seam between
  // them: the panel maps NER onto TEXT_GENERATION before handing the task over (they share the
  // route), so the collection builder cannot tell the two apart on `task` alone. Without the
  // explicit flag it emits the `?mode=stream` request that TEXT_GENERATION deserves and NER
  // answers with a 400 — a dead request shipped inside a downloadable file.
  it('a NER agent gets no ?mode=stream REQUEST in its Postman collection, only the warning', () => {
    renderWithProviders(<IntegrationPanel kind="agent" slug="ner" task="NAMED_ENTITY_RECOGNITION" inputSchema={AGENT_INPUT_SCHEMA} />);
    selectTab('Postman');
    openRawCollection();

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
    openRawCollection();
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

  /**
   * TASK-971 FU-1 — found by the runtime pass: the seeded `general-medicine-summarization`
   * REFUSED the panel's own example, because its instruction binds `trigger.context.*` paths that
   * `inputSchema` never declares. The example must carry those too or it is not copy-pasteable.
   */
  it("includes the context an agent's instruction binds, alongside the flat input", () => {
    renderWithProviders(
      <IntegrationPanel
        kind="agent"
        slug="clinic-summarizer"
        task="TEXT_GENERATION"
        inputSchema={AGENT_INPUT_SCHEMA}
        compiledConfig={{
          instruction: {
            variables: {
              language: { path: 'trigger.context.language' },
              safe_age: { path: 'trigger.context.safe_age' },
              headings: { value: 'bound at publish — the caller must not send this' },
            },
          },
        }}
      />,
    );

    const node = codeOf('Node.js (@arcaai/vox-node) snippet');
    // Still flat at the top level — `context` is a sibling of `text`, never an envelope over it.
    expect(node).toContain('"text": "…"');
    expect(node).toContain('"context"');
    expect(node).toContain('"language": "…"');
    expect(node).toContain('"safe_age": "…"');
    expect(node).not.toContain('headings');
    expect(node).not.toMatch(/"input"\s*:/);
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
  /**
   * TASK-983 lane I — `HTTP` and `Socket` became ONE **Manual** lane. Splitting them by transport
   * made a developer read two tabs to discover that one held the whole answer; the axis that
   * matters is the JOB, which is now the secondary control inside each lane.
   */
  it('offers Node, Browser, Manual and Postman, with Node first', () => {
    renderWithProviders(<IntegrationPanel kind="agent" slug="clinic-summarizer" task="TEXT_GENERATION" inputSchema={AGENT_INPUT_SCHEMA} />);

    expect(laneTabNames()).toEqual(['Node', 'Browser', 'Manual', 'Postman']);
    expect(screen.getByRole('tab', { name: 'Node' }).getAttribute('data-state')).toBe('active');
    expect(screen.queryByRole('tab', { name: 'HTTP' })).toBeNull();
    expect(screen.queryByRole('tab', { name: 'Socket' })).toBeNull();
  });

  it('each lane splits by JOB, and a speech agent opens on the job it exists for', () => {
    const { unmount } = renderWithProviders(<IntegrationPanel kind="agent" slug="clinic-summarizer" task="TEXT_GENERATION" inputSchema={AGENT_INPUT_SCHEMA} />);
    // Text generation answers one body by default, so Blocking leads.
    expect(screen.getByRole('tab', { name: 'Blocking' }).getAttribute('data-state')).toBe('active');
    expect(screen.getByRole('tab', { name: 'Realtime (SSE)' })).toBeTruthy();
    unmount();

    // A speech-to-text agent exists FOR live audio, so Realtime opens selected.
    renderWithProviders(<IntegrationPanel kind="agent" slug="asr" task="SPEECH_TO_TEXT" />);
    expect(screen.getByRole('tab', { name: 'Realtime' }).getAttribute('data-state')).toBe('active');
    expect(screen.getByRole('tab', { name: 'Batch' })).toBeTruthy();
  });

  it('every lane names the exact scope its requests need, and where a scoped key comes from', () => {
    renderWithProviders(<IntegrationPanel kind="agent" slug="clinic-summarizer" task="TEXT_GENERATION" inputSchema={AGENT_INPUT_SCHEMA} />);
    for (const lane of ['Node', 'Browser', 'Manual']) {
      selectTab(lane);
      const notes = screen.getAllByText(/Scopes this lane needs:/);
      expect(notes.length, lane).toBeGreaterThan(0);
      expect(notes[0].textContent, lane).toContain('agent:invocation:write');
      expect(notes[0].parentElement?.textContent, lane).toContain('/api-keys');
    }
  });

  /**
   * The scope crossing that produced a 403 in a live walkthrough: the batch job is started on one
   * scope family and followed on another, and nothing said so.
   */
  it('the batch lane of a speech agent names BOTH scope families', () => {
    renderWithProviders(<IntegrationPanel kind="agent" slug="asr" task="SPEECH_TO_TEXT" />);
    selectTab('Manual');
    selectJob('Batch');
    const note = screen.getAllByText(/Scopes this lane needs:/)[0];
    expect(note.textContent).toContain('stt:transcription:write');
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
    // Named twice on this lane now: once in the scope note above the request, once in the
    // key-minting advice below it. Both are deliberate.
    expect(screen.getAllByText(/agent:invocation:write/).length).toBeGreaterThan(0);
  });

  /**
   * TASK-975 B4 AMENDS this test rather than replacing it. The absence framing was never wrong —
   * there is no `invoke()` by slug for realtime speech — but leaving it at prose meant the one
   * non-invocable task WITH a real browser path was the lane with no code in it. Every original
   * assertion still stands below; what changed is that the named path now arrives as a snippet.
   */
  it('the browser lane for SPEECH_TO_TEXT keeps the absence framing AND now carries the capture snippet', () => {
    renderWithProviders(<IntegrationPanel kind="agent" slug="asr" task="SPEECH_TO_TEXT" />);
    selectTab('Browser');

    expect(screen.getByText(/no browser path by slug/i)).toBeTruthy();
    // Scoped to the NOTE itself: `audio.start` now appears twice on this lane — once in the
    // sentence that explains the absence, and once in the snippet that sentence names. The
    // original assertion was about the sentence, and still is.
    const absence = screen.getAllByRole('note').find((note) => /no browser path by slug/i.test(note.textContent ?? ''));
    expect(absence?.textContent).toContain('audio.start({ agentSlug })');
    expect(absence?.textContent).toContain('audio/transcription-jobs/transcribe');
    expect(screen.queryAllByRole('group')).toHaveLength(1);
  });

  it('the browser lane for TEXT_TO_SPEECH states the absence and names the voice-selected route — no snippet', () => {
    renderWithProviders(<IntegrationPanel kind="agent" slug="voice" task="TEXT_TO_SPEECH" />);
    selectTab('Browser');

    expect(screen.queryAllByRole('group')).toHaveLength(0);
    expect(screen.getByText(/no browser path by slug/i)).toBeTruthy();
    expect(screen.getByText(/speech\/synthesize/)).toBeTruthy();
    expect(screen.getByText(/useTtsPlayback/)).toBeTruthy();
  });

  it('the Manual lane is curl against the api/v1 prefix, blocking in one view and the stream in the other', () => {
    renderWithProviders(<IntegrationPanel kind="agent" slug="clinic-summarizer" task="TEXT_GENERATION" inputSchema={AGENT_INPUT_SCHEMA} />);
    selectTab('Manual');

    const curl = codeOf('curl snippet');
    expect(curl).toContain('/api/v1/agents/clinic-summarizer/invocations');
    expect(curl).toContain('X-API-Key');
    expect(curl).toContain('"tone": "clinical"');
    expect(curl).not.toMatch(/"input"\s*:/);
    // The tenant binds to the credential; sending it too is the mistake this line prevents.
    expect(screen.getByText(/X-Tenant-Id/)).toBeTruthy();

    selectJob('Realtime (SSE)');
    const streamed = codeOf('Streamed invocation without an SDK (curl -N) snippet');
    expect(streamed).toContain('?mode=stream');
    // -N is not decoration: without it curl buffers the stream and the call reads as hung.
    expect(streamed).toContain('curl -N');
    expect(codeOf('Streamed invocation without an SDK (fetch) snippet')).toContain('response.body');
    expect(screen.getByText(/does not resume/i)).toBeTruthy();
  });

  it('the Manual lane of a speech agent carries the whole batch job — multipart in, transcript out', () => {
    renderWithProviders(<IntegrationPanel kind="agent" slug="asr" task="SPEECH_TO_TEXT" />);
    selectTab('Manual');
    selectJob('Batch');

    const curl = codeOf('Batch transcription without an SDK (curl) snippet');
    expect(curl).toContain('-F "file=@consultation.wav;type=audio/wav"');
    expect(curl).toContain('/api/v1/audio/transcription-jobs/transcribe');
    expect(curl).toContain('curl -N');
    expect(codeOf('Batch transcription without an SDK (fetch) snippet')).toContain('FormData');
    // The route the console used to print FIRST takes an id, not a file.
    expect(screen.getAllByText(/two different routes/i).length).toBeGreaterThan(0);
  });

  it('the Manual lane of a speech agent keeps the realtime socket contract', () => {
    renderWithProviders(<IntegrationPanel kind="agent" slug="asr" task="SPEECH_TO_TEXT" />);
    selectTab('Manual');
    // Realtime leads for this task, so no job switch is needed.
    expect(screen.getByText(/Without the SDK — the contract, step by step/)).toBeTruthy();
    expect(codeOf('Realtime STT without an SDK (fetch + WebSocket) snippet')).toContain('new WebSocket(');
  });

  it('NER offers no stream example in ANY lane', () => {
    renderWithProviders(<IntegrationPanel kind="agent" slug="ner" task="NAMED_ENTITY_RECOGNITION" />);

    expect(codeOf('Node.js (@arcaai/vox-node) snippet')).not.toContain('mode=stream');
    selectTab('Browser');
    expect(codeOf('Browser (@arcaai/vox) snippet')).not.toContain('stream(');
    selectTab('Manual');
    expect(codeOf('curl snippet')).not.toContain('mode=stream');
    // And no Realtime view to switch to.
    expect(screen.queryByRole('tab', { name: 'Realtime (SSE)' })).toBeNull();
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
    expect(codeOf('Node.js (@arcaai/vox-node) snippet')).toContain('discharge-summary');
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

  it('the Manual lane starts async, polls the run, and follows the SSE stream', async () => {
    stubSchemaFetch();
    renderWithProviders(<IntegrationPanel kind="workflow" slug="discharge-summary" />);

    await screen.findByText('POST /workflows/discharge-summary/runs');
    selectTab('Manual');
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
    openRawCollection();

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
    openRawCollection();
    const collection = JSON.parse(codeOf('Postman collection JSON')) as { item: Array<{ request: { body?: { raw: string } } }> };
    expect(collection.item[0]?.request.body?.raw).toContain('"input"');
    expect(collection.item[0]?.request.body?.raw).toContain('"dischargeDate"');
  });
});

// ---------------------------------------------------------------------------
// TASK-975 lane A — the two halves of the integration story link to each other
// ---------------------------------------------------------------------------

describe('IntegrationPanel — the developer portal is one link away', () => {
  it('an agent panel links all three developer screens beside the API-keys link', () => {
    renderWithProviders(<IntegrationPanel kind="agent" slug="clinic-summarizer" task="TEXT_GENERATION" inputSchema={AGENT_INPUT_SCHEMA} />);

    expect(renderedHrefs()).toEqual(expect.arrayContaining([...DEVELOPER_HREFS, '/api-keys']));
  });

  it('a workflow panel links them too', async () => {
    stubSchemaFetch();
    renderWithProviders(<IntegrationPanel kind="workflow" slug="discharge-summary" />);

    await screen.findByText('POST /workflows/discharge-summary/runs');
    expect(renderedHrefs()).toEqual(expect.arrayContaining([...DEVELOPER_HREFS, '/api-keys']));
  });

  /**
   * The sharpest half of lane A. These three states used to render an Alert and NOTHING else, so
   * the developer with the least idea what to do next — told their workflow is not exposable, or
   * not active, or not exposed — was the one handed no onward path at all.
   */
  it('not active: the alert is not the whole answer', () => {
    stubSchemaFetch();
    renderWithProviders(<IntegrationPanel kind="workflow" slug="discharge-summary" isActive={false} />);

    expect(screen.getByText(/published, not active/i)).toBeTruthy();
    expect(renderedHrefs()).toEqual(expect.arrayContaining(DEVELOPER_HREFS));
  });

  it('not exposable: the alert is not the whole answer', () => {
    stubSchemaFetch();
    renderWithProviders(<IntegrationPanel kind="workflow" slug="discharge-summary" exposable={false} paletteKey="stt" />);

    expect(screen.getByText(/not exposable/i)).toBeTruthy();
    expect(renderedHrefs()).toEqual(expect.arrayContaining(DEVELOPER_HREFS));
  });

  it('a 404 from the run contract: the alert is not the whole answer', async () => {
    stubSchemaFetch(404);
    renderWithProviders(<IntegrationPanel kind="workflow" slug="discharge-summary" />);

    await screen.findByText(/workflow exposure/i);
    expect(renderedHrefs()).toEqual(expect.arrayContaining(DEVELOPER_HREFS));
  });
});

// ---------------------------------------------------------------------------
// TASK-975 lane B — the socket lane
// ---------------------------------------------------------------------------

describe('IntegrationPanel — the Socket lane', () => {
  /**
   * TASK-983 lane I — the workflow half takes the SAME consolidation as the agent half: a panel
   * with four lanes on one entity and five on the other would teach the transport split all over
   * again. The socket material did not move out of the product; it moved to where a developer
   * already is — the SDK options sit beside the SDK calls, and the no-SDK handshake sits in
   * Manual with the rest of the no-SDK material.
   */
  it('the workflow panel offers the same four lanes as an agent', async () => {
    stubSchemaFetch();
    renderWithProviders(<IntegrationPanel kind="workflow" slug="discharge-summary" />);

    await screen.findByText('POST /workflows/discharge-summary/runs');
    expect(laneTabNames()).toEqual(['Node', 'Browser', 'Manual', 'Postman']);
    expect(screen.queryByRole('tab', { name: 'Socket' })).toBeNull();
  });

  it('names transport: socket beside the SDK calls, and the RUN-SCOPED ticket in the Manual lane', async () => {
    stubSchemaFetch();
    renderWithProviders(<IntegrationPanel kind="workflow" slug="discharge-summary" />);

    await screen.findByText('POST /workflows/discharge-summary/runs');

    // `transport` is an OPTION on the methods already shown in the Node lane, never a new method.
    expect(codeOf('Socket (@arcaai/vox-node) snippet')).toContain("transport: 'socket'");
    selectTab('Browser');
    expect(codeOf('Socket (@arcaai/vox) snippet')).toContain("useWorkflowRun({ transport: 'socket' })");

    selectTab('Manual');
    // The RUN-SCOPED route, not the JWT-only POST /auth/stream-ticket: this one takes an API key
    // and derives the scope server-side.
    const shell = codeOf('Socket handshake (websocat) snippet');
    expect(shell).toContain('/runs/$RUN_ID/stream-ticket');
    expect(shell).toContain('websocat');
  });

  it('states the runtime floor and that SSE is the only lane that resumes', async () => {
    stubSchemaFetch();
    renderWithProviders(<IntegrationPanel kind="workflow" slug="discharge-summary" />);

    await screen.findByText('POST /workflows/discharge-summary/runs');
    selectTab('Manual');

    const lane = screen.getAllByRole('tabpanel')[0].textContent ?? '';
    // Rendered from the shared constants, never paraphrased: the SSE tab and this one must not
    // give a developer two different explanations of the same choice.
    expect(lane).toContain(SOCKET_LANE_RATIONALE);
    expect(lane).toContain(SOCKET_RUNTIME_FLOOR);
    // …and the two FACTS, asserted independently of the constants' current wording.
    expect(lane).toMatch(/only lane that resumes/i);
    expect(lane).toMatch(/Node 22\+/);
  });

  it("an STT agent's Browser lane carries a real capture snippet, and its Realtime views drive hope.stt", () => {
    renderWithProviders(<IntegrationPanel kind="agent" slug="asr" task="SPEECH_TO_TEXT" />);

    // Realtime is what a speech-to-text agent is FOR, so the Realtime VIEW opens selected inside
    // every lane; the lanes themselves are the same four as everywhere else. The header names the
    // realtime session route before the batch route for the same reason.
    expect(laneTabNames()).toEqual(['Node', 'Browser', 'Manual', 'Postman']);
    expect(screen.getByRole('tab', { name: 'Realtime' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByText(/POST \/audio\/transcription-jobs\/stream\/session/)).toBeTruthy();
    expect(screen.getAllByText(/\/ws\/stt\/stream/).length).toBeGreaterThan(0);

    selectTab('Browser');
    const browser = codeOf('Browser (@arcaai/vox) snippet');
    // Realtime STT is a CAPTURE session, not an invocation — which is exactly why there is no
    // `invoke()` for it, and exactly why the panel can still print working code.
    expect(browser).toContain("audio.start({ agentSlug: 'asr' })");
    expect(browser).toContain('useArcaAudio');

    selectTab('Manual');
    // The manual path is the whole Manual lane now: the routes, the handshake, every frame, and
    // two no-SDK samples — a developer without the SDK sets the socket up from this lane alone.
    expect(screen.getByText('Without the SDK — the contract, step by step')).toBeTruthy();
    expect(screen.getByRole('table', { name: /every frame on the realtime STT socket/i })).toBeTruthy();
    for (const type of ['ready', 'transcript', 'stop', 'resume', 'resumed', 'resume_failed', 'close']) {
      expect(screen.getAllByText(type, { selector: 'td' }).length, type).toBeGreaterThan(0);
    }
    const shell = codeOf('Realtime STT without an SDK (curl + websocat) snippet');
    expect(shell).toContain('/audio/transcription-jobs/stream/session');
    expect(shell).toContain('websocat');
    const raw = codeOf('Realtime STT without an SDK (fetch + WebSocket) snippet');
    expect(raw).toContain('new WebSocket(');
    expect(raw).not.toContain('@arcaai/');
    // The runtime floor applies wherever a socket is offered.
    expect(screen.getAllByRole('tabpanel')[0].textContent ?? '').toContain(SOCKET_RUNTIME_FLOOR);

    selectTab('Node');
    const node = codeOf('Realtime STT (@arcaai/vox-node) snippet');
    expect(node).toContain("hope.stt.createStreamSession({ agentSlug: 'asr' })");
    expect(node).toContain("socket.on('transcript'");
  });

  /**
   * The absence note for TTS is the load-bearing one: `@arcaai/vox` genuinely has no agent-slug
   * path for synthesis, and inventing one would be the worst failure this panel can have — it
   * carries the authority of the product.
   */
  it('a TTS agent still gets prose, no snippet, and no Realtime view', () => {
    renderWithProviders(<IntegrationPanel kind="agent" slug="voice" task="TEXT_TO_SPEECH" />);

    expect(laneTabNames()).toEqual(['Node', 'Browser', 'Manual', 'Postman']);
    expect(screen.queryByRole('tab', { name: /^Realtime/ })).toBeNull();
    selectTab('Browser');
    expect(screen.queryAllByRole('group')).toHaveLength(0);
    expect(screen.getByText(/no browser path by slug/i)).toBeTruthy();
  });

  /**
   * REGRESSION GUARD. `socket` was filtered out of the `?mode=` badges and the Postman modes long
   * before this ticket, and that was always RIGHT: socket is a LANE, not a delivery mode —
   * `POST /workflows/{slug}/runs?mode=socket` is not a route. The defect was never the filter; it
   * was filtering the mode and then never documenting the lane. Both halves are pinned here so a
   * future reader cannot "fix" one by breaking the other.
   */
  it('socket is a lane, not a ?mode= value: a tab, never a badge and never a request', async () => {
    stubSchemaFetch(); // `modes` deliberately includes `socket`
    renderWithProviders(<IntegrationPanel kind="workflow" slug="discharge-summary" />);

    await screen.findByText('POST /workflows/discharge-summary/runs');
    // Never a badge and never a request. The socket material lives in the Node, Browser and
    // Manual lanes beside the transport it is an option on — it was never a `?mode=` value.
    expect(screen.queryByText('socket')).toBeNull();

    selectTab('Postman');
    openRawCollection();
    const collection = collectionOf();
    expect(collection.item.flatMap((entry) => entry.request.url.query ?? []).filter((q) => q.key === 'mode' && q.value === 'socket')).toHaveLength(0);
    expect(JSON.stringify(collection)).not.toContain('mode=socket');
  });
});

// ---------------------------------------------------------------------------
// TASK-975 lane C — the Postman lane becomes legible
// ---------------------------------------------------------------------------

describe('IntegrationPanel — the Postman manifest', () => {
  it('renders one row per request, derived from the same item array', async () => {
    stubSchemaFetch();
    renderWithProviders(<IntegrationPanel kind="workflow" slug="discharge-summary" />);

    await screen.findByText('POST /workflows/discharge-summary/runs');
    selectTab('Postman');

    const manifest = screen.getByRole('list', { name: /requests/i });
    openRawCollection();
    const collection = collectionOf();

    const rows = within(manifest).getAllByRole('listitem');
    expect(rows).toHaveLength(collection.item.length);
    // Name AND the method + path it will fire — the point is to learn what is inside the file
    // without reading 200 lines of JSON.
    collection.item.forEach((item, index) => {
      const row = rows[index]?.textContent ?? '';
      expect(row).toContain(item.name);
      expect(row).toContain(item.request.method);
    });
    expect(rows[0]?.textContent).toContain('/api/v1/workflows/discharge-summary/runs?mode=async');
    // Unchanged by the new presentation: the file still ships no credential.
    expect(collection.variable.find((entry) => entry.key === 'apiKey')?.value).toBe('');
  });

  it('keeps the raw file behind a disclosure — collapsed, and complete when opened', () => {
    renderWithProviders(<IntegrationPanel kind="agent" slug="clinic-summarizer" task="TEXT_GENERATION" inputSchema={AGENT_INPUT_SCHEMA} />);
    selectTab('Postman');

    expect(screen.queryByRole('group', { name: 'Postman collection JSON' })).toBeNull();
    openRawCollection();
    expect(collectionOf().info.schema).toContain('collection/v2.1.0');
    expect(collectionOf().item.length).toBeGreaterThan(0);
  });

  it('names the import walkthrough and the base URL the downloaded file will carry', () => {
    renderWithProviders(<IntegrationPanel kind="agent" slug="clinic-summarizer" task="TEXT_GENERATION" inputSchema={AGENT_INPUT_SCHEMA} />);
    selectTab('Postman');

    const walkthrough = screen.getByRole('link', { name: /import walkthrough/i }) as HTMLAnchorElement;
    expect(walkthrough.getAttribute('href')).toBe('/developer/invoke');

    openRawCollection();
    const baseUrl = collectionOf().variable.find((entry) => entry.key === 'baseUrl')?.value ?? '';
    expect(baseUrl).toBeTruthy();
    expect(screen.getByText(baseUrl)).toBeTruthy();
  });

  /**
   * TASK-975 C4 — the Postman lane injected the console's real gateway origin while the HTTP lane
   * two tabs away printed `https://your-gateway.example.com`. Two answers to one question made a
   * developer comparing them doubt both.
   */
  it('the curl lane and the collection agree on the base URL', () => {
    renderWithProviders(<IntegrationPanel kind="agent" slug="clinic-summarizer" task="TEXT_GENERATION" inputSchema={AGENT_INPUT_SCHEMA} />);

    selectTab('Manual');
    const curl = codeOf('curl snippet');

    selectTab('Postman');
    openRawCollection();
    const baseUrl = collectionOf().variable.find((entry) => entry.key === 'baseUrl')?.value ?? '';

    expect(baseUrl).toBeTruthy();
    expect(curl).toContain(`export HOPE_API_URL=${JSON.stringify(baseUrl)}`);
    expect(curl).not.toContain('your-gateway.example.com');
  });

  it('a workflow curl lane agrees with its collection too', async () => {
    stubSchemaFetch();
    renderWithProviders(<IntegrationPanel kind="workflow" slug="discharge-summary" />);

    await screen.findByText('POST /workflows/discharge-summary/runs');
    selectTab('Manual');
    const curl = codeOf('curl snippet');

    selectTab('Postman');
    openRawCollection();
    const baseUrl = collectionOf().variable.find((entry) => entry.key === 'baseUrl')?.value ?? '';

    expect(curl).toContain(`export HOPE_API_URL=${JSON.stringify(baseUrl)}`);
    expect(curl).not.toContain('your-gateway.example.com');
  });
});

// ---------------------------------------------------------------------------
// TASK-975 T10 — the now five-tab panel
// ---------------------------------------------------------------------------

describe('IntegrationPanel — accessibility of the five-lane panel', () => {
  it('has no axe violations on the Manual lane', async () => {
    stubSchemaFetch();
    renderWithProviders(
      <main>
        <IntegrationPanel kind="workflow" slug="discharge-summary" />
      </main>,
    );

    await screen.findByText('POST /workflows/discharge-summary/runs');
    selectTab('Manual');
    expect(await axe(screen.getByRole('main'))).toHaveNoViolations();
  });

  it('has no axe violations on the Postman lane, collapsed and expanded', async () => {
    stubSchemaFetch();
    renderWithProviders(
      <main>
        <IntegrationPanel kind="workflow" slug="discharge-summary" />
      </main>,
    );

    await screen.findByText('POST /workflows/discharge-summary/runs');
    selectTab('Postman');
    expect(await axe(screen.getByRole('main'))).toHaveNoViolations();
    openRawCollection();
    expect(await axe(screen.getByRole('main'))).toHaveNoViolations();
  });

  it('has no axe violations on a workflow early return, which now carries links', async () => {
    renderWithProviders(
      <main>
        <IntegrationPanel kind="workflow" slug="discharge-summary" exposable={false} paletteKey="stt" />
      </main>,
    );

    expect(await axe(screen.getByRole('main'))).toHaveNoViolations();
  });
});

// ---------------------------------------------------------------------------
// TASK-983 lane I — the two jobs, in every lane
// ---------------------------------------------------------------------------

describe('IntegrationPanel — batch and realtime are both complete', () => {
  it("the Node lane's batch view walks the whole job, not just the request that starts it", () => {
    renderWithProviders(<IntegrationPanel kind="agent" slug="asr" task="SPEECH_TO_TEXT" />);
    selectTab('Node');
    selectJob('Batch');

    const code = codeOf('Batch transcription (@arcaai/vox-node) snippet');
    expect(code).toContain("hope.agents.transcribe('asr'");
    // The 201 is the start of the job, not the end of the integration — and the methods that
    // follow it are on the AGENTS plane. `hope.jobs.*` addresses `consultations/jobs/{id}` and
    // 404s on a transcription job id, which is exactly the mistake this assertion prevents.
    expect(code).toMatch(/hope\.agents\.(waitForTranscription|subscribeTranscription)/);
    expect(code).not.toMatch(/hope\.jobs\.\w+\(/);
    expect(code).toContain('resultText');
  });

  it('the batch steps are the same four in every lane that shows them', () => {
    renderWithProviders(<IntegrationPanel kind="agent" slug="asr" task="SPEECH_TO_TEXT" />);
    for (const lane of ['Node', 'Manual']) {
      selectTab(lane);
      selectJob('Batch');
      const panel = screen.getAllByRole('tabpanel').map((node) => node.textContent ?? '').join(' ');
      expect(panel, lane).toContain('Upload the audio and start the job');
      expect(panel, lane).toContain('Read the transcript');
    }
  });

  it('the batch job frame table names every frame the stream carries', () => {
    renderWithProviders(<IntegrationPanel kind="agent" slug="asr" task="SPEECH_TO_TEXT" />);
    selectTab('Manual');
    selectJob('Batch');

    const table = screen.getByRole('table', { name: /batch transcription job/i });
    for (const type of ['status', 'progress', 'chunk', 'transcript', 'error']) {
      expect(within(table).getAllByText(type, { selector: 'td' }).length, type).toBeGreaterThan(0);
    }
  });

  it('a streamed invocation states its frames, its heartbeat and that it does not resume', () => {
    renderWithProviders(<IntegrationPanel kind="agent" slug="clinic-summarizer" task="TEXT_GENERATION" inputSchema={AGENT_INPUT_SCHEMA} />);
    selectTab('Manual');
    selectJob('Realtime (SSE)');

    const table = screen.getByRole('table', { name: /streamed invocation/i });
    for (const event of ['meta', 'chunk', 'done', 'error']) {
      expect(within(table).getAllByText(event, { selector: 'td' }).length, event).toBeGreaterThan(0);
    }
    const panel = screen.getAllByRole('tabpanel').map((node) => node.textContent ?? '').join(' ');
    expect(panel).toMatch(/:keepalive/);
    expect(panel).toMatch(/does not resume/i);
  });

  /** The honest absence: an invocation has no job id to poll, and nobody should invent one. */
  it('says the agent plane has no job mode, on the blocking view where a developer looks for one', () => {
    renderWithProviders(<IntegrationPanel kind="agent" slug="clinic-summarizer" task="TEXT_GENERATION" inputSchema={AGENT_INPUT_SCHEMA} />);
    expect(screen.getAllByText(/no job mode on the agent plane/i).length).toBeGreaterThan(0);
    selectTab('Manual');
    expect(screen.getAllByText(/no job mode on the agent plane/i).length).toBeGreaterThan(0);
  });

  /**
   * A live run of this exact walkthrough was refused with a 400 per prompt placeholder, one call
   * at a time, because the example carried none of them. When `GET /agents/{slug}` reports them,
   * the rendered body carries every name at once.
   */
  it('prompt variables the instruction binds are filled into the example when the summary reports them', () => {
    renderWithProviders(
      <IntegrationPanel
        kind="agent"
        slug="clinic-summarizer"
        task="TEXT_GENERATION"
        inputSchema={AGENT_INPUT_SCHEMA}
        requiredVariables={['language', 'safe_age', 'visit_type']}
      />,
    );

    const node = codeOf('Node.js (@arcaai/vox-node) snippet');
    for (const name of ['language', 'safe_age', 'visit_type']) {
      expect(node, name).toContain(name);
    }
    expect(screen.getByText(/binds 3 variables/i)).toBeTruthy();
  });

  it('without them the panel warns rather than pretending the schema is the whole contract', () => {
    renderWithProviders(<IntegrationPanel kind="agent" slug="clinic-summarizer" task="TEXT_GENERATION" inputSchema={AGENT_INPUT_SCHEMA} />);
    expect(screen.getByText(/may bind variables its/i)).toBeTruthy();
  });

  it('has no axe violations on a speech agent, in either job view', async () => {
    renderWithProviders(
      <main>
        <IntegrationPanel kind="agent" slug="asr" task="SPEECH_TO_TEXT" />
      </main>,
    );
    selectTab('Manual');
    expect(await axe(screen.getByRole('main'))).toHaveNoViolations();
    selectJob('Batch');
    expect(await axe(screen.getByRole('main'))).toHaveNoViolations();
  });
});
