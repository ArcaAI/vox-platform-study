/**
 * TASK-1036 §10.2 — the Studio Test tab: the owner's debugging surface. "Show the flow, the active
 * node, all execution context and consultation data, all events."
 *
 * The `@arcaai/ui` canvas is a prop recorder (React Flow cannot run in happy-dom): what is under
 * test is what the Test tab HANDS the composer canvas (run states, run warnings) and what the rest
 * of the surface shows as the admin trace streams in. The trace is a fake `EventSource` emitting
 * protocol-v2 envelopes; the recorder hook is replaced (its own suite covers the audio path).
 */
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { useEffect, type ReactNode } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { renderWithProviders } from '@/test/render';
import { GraphStoreProvider, useGraphStoreApi } from '../../../store';
import type { GraphStoreEdge, GraphStoreNode } from '../../../store/types';
import { REGISTRY } from '../../../lib/__tests__/registry-fixture';
import { TestTab, useNodeLastRuns } from '../test-tab';

type CanvasProps = {
  nodes: Array<{ id: string; label: string; runState?: string; runDurationMs?: number; problem?: { severity: string; messages: string[] } }>;
  onSelect?: (nodeId: string | null) => void;
};
const captured: CanvasProps[] = [];
vi.mock('@arcaai/ui/components/workflow-canvas', () => ({
  WorkflowCanvas: (props: CanvasProps) => {
    captured.push(props);
    return (
      <div data-testid="canvas">
        {props.nodes.map((node) => (
          <button key={node.id} type="button" data-run-state={node.runState ?? ''} onClick={() => props.onSelect?.(node.id)}>
            canvas:{node.label}
          </button>
        ))}
      </div>
    );
  },
}));

vi.mock('../../../api/hooks', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../api/hooks')>();
  return {
    ...actual,
    useAgentOptions: () => ({
      data: [
        { slug: 'asr', name: 'ASR', task: 'SPEECH_TO_TEXT', versionNumber: 3 },
        { slug: 'writer', name: 'Writer', task: 'TEXT_GENERATION', versionNumber: 4 },
      ],
    }),
    useWorkflowNodeRegistry: () => ({ data: { nodes: [...REGISTRY.values()], registryChecksum: 'x' }, isLoading: false }),
  };
});

vi.mock('@/shared/auth/hooks', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/shared/auth/hooks')>();
  return { ...actual, useSession: () => ({ data: { effectiveTenantId: 't-1', user: { tenantId: 't-1' } } }) };
});

const recorder = {
  status: 'idle' as 'idle' | 'starting' | 'recording' | 'stopping' | 'error',
  error: null as string | null,
  sessionId: null as string | null,
  levels: [] as number[],
  start: vi.fn(async () => 'stt-9'),
  stop: vi.fn(async () => {}),
};
vi.mock('@/shared/sandbox/api/use-sandbox-recording', () => ({ useSandboxRecording: () => recorder }));

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
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), listener]);
  }
  close(): void {
    this.closed = true;
  }
}

let seq = 0;
function emit(type: string, data: Record<string, unknown>, nodeId?: string, atMs = seq * 1000): void {
  seq += 1;
  const envelope = { seq, runId: 'run-1', type, ts: new Date(Date.parse('2026-10-04T10:00:00.000Z') + atMs).toISOString(), data, ...(nodeId ? { nodeId } : {}) };
  const source = FakeEventSource.instances.at(-1)!;
  act(() => {
    for (const listener of source.listeners.get(type) ?? []) listener({ data: JSON.stringify(envelope) } as MessageEvent);
  });
}

let runBodies: unknown[] = [];
let cancelled = 0;

beforeAll(() => {
  Element.prototype.scrollIntoView ??= function scrollIntoView() {};
});

beforeEach(() => {
  captured.length = 0;
  FakeEventSource.instances = [];
  seq = 0;
  runBodies = [];
  cancelled = 0;
  recorder.status = 'idle';
  recorder.sessionId = null;
  recorder.levels = [];
  recorder.start.mockClear();
  recorder.stop.mockClear();
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(input), 'http://test.local').pathname;
      const method = init?.method ?? 'GET';
      if (method === 'POST' && path === '/api/hope/admin/workflow-definitions/def-1/sandbox-runs') {
        runBodies.push(JSON.parse(String(init?.body)));
        return Response.json({ runId: 'run-1', status: 'started', statusUrl: 'x', streamUrl: 'x' }, { status: 202 });
      }
      if (method === 'POST' && path === '/api/hope/admin/workflow-definitions/def-1/sandbox-runs/run-1/cancel') {
        cancelled += 1;
        return Response.json({ runId: 'run-1', status: 'CANCELED' });
      }
      if (method === 'POST' && path === '/api/auth/stream-ticket') return Response.json({ ticket: 'tkt', expiresAt: Date.now() + 30_000, scope: 'x' });
      return Response.json([]);
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function node(id: string, type: string, config: Record<string, unknown> = {}): GraphStoreNode {
  return { id, type, position: { x: 0, y: 0 }, safetyClasses: [], config };
}

const NODES = [
  node('t', 'core.trigger', { label: 'Start' }),
  node('asr1', 'core.agent', { agentRef: { slug: 'asr', versionNumber: 3 }, label: 'Transcribe' }),
  node('w', 'core.agent', { agentRef: { slug: 'writer', versionNumber: 4 }, label: 'Draft note', inputs: { message: { from: 'nodes.asr1.outputs.transcript' } } }),
];
const EDGES: GraphStoreEdge[] = [
  { id: 'e1', source: 't', sourceHandle: 'next', target: 'asr1', targetHandle: 'after' },
  { id: 'e2', source: 'asr1', sourceHandle: 'next', target: 'w', targetHandle: 'after' },
];
const DEFAULT_IO = {
  kinds: [
    { key: 'message', label: 'Message', primitive: 'TEXT', phiClass: 'PHI' },
    { key: 'documents', label: 'Documents', primitive: 'DOCUMENT', constraints: { mimeTypes: ['application/pdf'] } },
  ],
};

const holder: { api: ReturnType<typeof useGraphStoreApi> | null } = { api: null };
function Capture({ children }: { children: ReactNode }) {
  const api = useGraphStoreApi();
  useEffect(() => {
    holder.api = api;
  }, [api]);
  return <>{children}</>;
}

const lastRuns: Array<ReturnType<typeof useNodeLastRuns>> = [];
function LastRunProbe() {
  lastRuns.push(useNodeLastRuns('def-1'));
  return null;
}

function mount() {
  const view = renderWithProviders(
    <GraphStoreProvider>
      <Capture>
        <TestTab definitionId="def-1" />
        <LastRunProbe />
      </Capture>
    </GraphStoreProvider>,
  );
  act(() => holder.api?.getState().hydrate(NODES, EDGES, { connections: ['api'], sources: [], contextSchema: { inline: DEFAULT_IO } }));
  return view;
}

const latestCanvas = () => captured.at(-1)!;
const statusBar = () => document.querySelector('[data-slot="test-status-bar"]') as HTMLElement;
const canvasNode = (id: string) => latestCanvas().nodes.find((candidate) => candidate.id === id);

async function startRun(message = 'Chest pain since Tuesday.') {
  fireEvent.change(screen.getByLabelText('Message'), { target: { value: message } });
  fireEvent.click(screen.getByRole('button', { name: 'Run test' }));
  await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
}

function playScenario() {
  emit('run.started', { kind: 'workflow', slug: 'scribe', versionNumber: 7 });
  emit('input.validated', { valid: true, problems: [], schema: { slug: 'default_io', versionNumber: 2 } });
  emit('node.started', { kind: 'core.agent', label: 'Transcribe', attempt: 1 }, 'asr1');
  emit('transcript.final', { text: 'Chest pain since Tuesday.' }, 'asr1');
  emit('node.completed', { status: 'COMPLETED', durationMs: 1200 }, 'asr1');
  emit('output.data', { field: 'transcript', value: 'Chest pain since Tuesday.', visibility: 'admin' }, 'asr1');
  emit('node.started', { kind: 'core.agent', label: 'Draft note', attempt: 1 }, 'w');
  emit(
    'data.bound',
    {
      inputs: [
        { input: 'message', source: { kind: 'from', path: 'nodes.asr1.outputs.transcript' }, value: 'Chest pain since Tuesday.', phiClass: 'PHI' },
        { input: 'history', source: { kind: 'from', path: 'consultation.history' }, empty: true },
      ],
    },
    'w',
  );
  emit('binding.warning', { input: 'history', code: 'OPTIONAL_EMPTY', message: 'Rendered empty.' }, 'w');
  emit('consultation.read', { consultationId: 'c-1', snapshot: 'node-start', fields: [{ path: 'consultation.patient.age', phiClass: 'PHI', value: 54 }] }, 'w');
  emit('model.request', { provider: 'lmstudio', model: 'gemma', attempt: 1, fallback: false, stream: true }, 'w');
  emit('output.text.delta', { field: 'text', text: 'S: chest pain.' }, 'w');
}

function finishScenario() {
  emit('node.completed', { status: 'COMPLETED', durationMs: 3400, tokens: { in: 300, out: 40 } }, 'w');
  emit('output.data', { field: 'text', value: 'S: chest pain.', visibility: 'admin' }, 'w');
  emit('run.completed', { status: 'COMPLETED', durationMs: 5000, tokens: { in: 300, out: 40 } });
}

describe('TestTab — before a run', () => {
  it('shows the flow, only the inputs this workflow can use (each with its reason), and the empty states', async () => {
    mount();
    expect(screen.getByRole('heading', { name: 'Flow' })).toBeTruthy();
    expect(latestCanvas().nodes.map((candidate) => candidate.runState)).toEqual([undefined, undefined, undefined]);
    expect(screen.getByText('Shown because the Input shape accepts a message.')).toBeTruthy();
    expect(screen.getByRole('switch', { name: 'Record from the microphone' })).toBeTruthy();
    expect(screen.getByText('Shown because “Transcribe” is a speech-to-text step.')).toBeTruthy();
    const attach = screen.getByRole('button', { name: 'Attach files' });
    expect(attach.hasAttribute('disabled')).toBe(true);
    expect(screen.getByText(/Shown because the Input shape accepts Documents/)).toBeTruthy();
    expect(screen.getByText(/Press Run test to start/)).toBeTruthy();
    expect(within(statusBar()).getByText('Not started')).toBeTruthy();
  });

  it('has no axe violations', async () => {
    const { container } = mount();
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe('TestTab — a live run', () => {
  it('starts the sandbox run with the typed message and follows the admin trace', async () => {
    mount();
    await startRun();
    expect(runBodies).toEqual([{ input: { message: 'Chest pain since Tuesday.' } }]);
    const url = new URL(FakeEventSource.instances[0]!.url);
    expect(url.pathname).toBe('/api/v1/admin/workflow-runs/run-1/trace/stream');
    expect(url.searchParams.get('protocol')).toBe('2');

    playScenario();
    expect(canvasNode('t')?.runState).toBe('pending');
    expect(canvasNode('asr1')).toMatchObject({ runState: 'ok', runDurationMs: 1200 });
    expect(canvasNode('w')?.runState).toBe('running');
    expect(canvasNode('w')?.problem?.messages.join(' ')).toMatch(/This run: 1 warning/);
    expect(within(statusBar()).getByText('Running')).toBeTruthy();
    expect(within(statusBar()).getByText('run-1')).toBeTruthy();
  });

  it('shows the active step’s inputs as field ← source = value, including optional rendered-empty inputs, and its live output', async () => {
    mount();
    await startRun();
    playScenario();
    const step = screen.getByRole('region', { name: /Step/ });
    expect(within(step).getByText('Draft note')).toBeTruthy();
    expect(within(step).getByText('nodes.asr1.outputs.transcript')).toBeTruthy();
    expect(within(step).getAllByText('“Chest pain since Tuesday.”').length).toBeGreaterThan(0);
    expect(within(step).getByText('optional, rendered empty')).toBeTruthy();
    expect(within(step).getByText('“S: chest pain.”')).toBeTruthy();
    expect(within(step).getByText(/writer · v4/)).toBeTruthy();

    // Clicking another step on the flow selects it.
    fireEvent.click(screen.getByRole('button', { name: 'canvas:Transcribe' }));
    expect(within(screen.getByRole('region', { name: /Step/ })).getByText('Transcribe')).toBeTruthy();
  });

  it('lists every event with filters and counts, and searches', async () => {
    mount();
    await startRun();
    playScenario();
    const events = screen.getByRole('region', { name: /Events/ });
    expect(within(events).getAllByRole('button', { name: /^#\d+/ })).toHaveLength(12);
    fireEvent.click(within(events).getByRole('button', { name: 'Warnings · 1' }));
    expect(within(events).getAllByRole('button', { name: /^#\d+/ })).toHaveLength(1);
    expect(within(events).getByText('history: Rendered empty.')).toBeTruthy();
    fireEvent.click(within(events).getByRole('button', { name: 'Warnings · 1' }));
    fireEvent.change(within(events).getByLabelText('Search events'), { target: { value: 'gemma' } });
    expect(within(events).getAllByRole('button', { name: /^#\d+/ })).toHaveLength(1);
  });

  it('time-travels to a clicked event: flow, step and context show that moment until Back to live', async () => {
    mount();
    await startRun();
    playScenario();
    const events = screen.getByRole('region', { name: /Events/ });
    fireEvent.click(within(events).getByRole('button', { name: /^#3 / }));
    expect(screen.getByText(/Showing the state at event #3/)).toBeTruthy();
    expect(canvasNode('asr1')?.runState).toBe('running');
    expect(canvasNode('w')?.runState).toBe('pending');
    expect(within(events).getByText(/"type": "node.started"/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Back to live' }));
    expect(screen.queryByText(/Showing the state at event #3/)).toBeNull();
    expect(canvasNode('w')?.runState).toBe('running');
  });

  it('pauses the view and steps through events one at a time', async () => {
    mount();
    await startRun();
    emit('run.started', { kind: 'workflow', slug: 'scribe', versionNumber: 7 });
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
    emit('node.started', { kind: 'core.agent', label: 'Transcribe', attempt: 1 }, 'asr1');
    expect(canvasNode('asr1')?.runState).toBe('pending');
    fireEvent.click(screen.getByRole('button', { name: 'Step' }));
    expect(canvasNode('asr1')?.runState).toBe('running');
  });

  it('shows the execution context: session items, consultation fields with who read them, and run variables', async () => {
    mount();
    await startRun();
    playScenario();
    const context = screen.getByRole('region', { name: /Execution context/ });
    expect(within(context).getByText('Chest pain since Tuesday.')).toBeTruthy();
    expect(within(context).getByText('AI')).toBeTruthy();

    fireEvent.mouseDown(within(context).getByRole('tab', { name: 'Consultation' }));
    fireEvent.click(within(context).getByRole('tab', { name: 'Consultation' }));
    await waitFor(() => expect(within(context).getByText('consultation.patient.age')).toBeTruthy());
    expect(within(context).getByText(/read by Draft note at \+/)).toBeTruthy();
    expect(within(context).getByText('54')).toBeTruthy();
  });

  it('hides PHI values in one click', async () => {
    mount();
    await startRun();
    playScenario();
    expect(screen.getByText(/Viewing PHI is logged/)).toBeTruthy();
    fireEvent.click(screen.getByRole('switch', { name: 'Hide PHI' }));
    const step = screen.getByRole('region', { name: /Step/ });
    expect(within(step).queryByText('“Chest pain since Tuesday.”')).toBeNull();
    expect(within(step).getAllByText('•••').length).toBeGreaterThan(0);
  });

  it('remembers the completed run for the inspector’s Last run tab', async () => {
    mount();
    await startRun();
    playScenario();
    finishScenario();
    expect(within(statusBar()).getByText('Completed')).toBeTruthy();
    expect(within(statusBar()).getByText(/300 in · 40 out/)).toBeTruthy();
    await waitFor(() => expect(lastRuns.at(-1)?.w).toMatchObject({ status: 'SUCCEEDED', durationMs: 3400, outputs: { text: 'S: chest pain.' } }));
    expect(lastRuns.at(-1)?.w?.inputs).toEqual({ message: 'Chest pain since Tuesday.', history: '' });
  });

  it('stops a live run and resets the surface', async () => {
    mount();
    await startRun();
    emit('run.started', { kind: 'workflow', slug: 'scribe', versionNumber: 7 });
    fireEvent.click(screen.getByRole('button', { name: 'Stop run' }));
    await waitFor(() => expect(cancelled).toBe(1));
    fireEvent.click(screen.getByRole('button', { name: 'Reset' }));
    await waitFor(() => expect(screen.getByText(/Press Run test to start/)).toBeTruthy());
  });
});

describe('TestTab — recording', () => {
  it('opens the recording session first and binds the run to it', async () => {
    mount();
    fireEvent.click(screen.getByRole('switch', { name: 'Record from the microphone' }));
    fireEvent.click(screen.getByRole('button', { name: 'Run test' }));
    await waitFor(() => expect(runBodies).toHaveLength(1));
    expect(recorder.start).toHaveBeenCalledWith({ agentSlug: 'asr', tenantId: 't-1' });
    expect(runBodies[0]).toEqual({ recording: { sttSessionId: 'stt-9' } });
  });
});
