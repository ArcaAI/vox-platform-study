/**
 * TASK-1036 C2b — `ComposerCanvas`, the composer's canvas: typed task ports (D-F), mapping labels,
 * connect-time typing with the reason shown (§8.4 item 2), auto-map on connect (D-C/D-D), the
 * OD-18 refusal with "Use first available" (Q1), `+` on an edge and a link dropped on empty
 * canvas opening the add-a-step menu (§8.4 item 7), W1 refusals, and the canvas problem an
 * unbound required input raises (§10.1).
 *
 * The `@arcaai/ui` canvas is replaced with a prop recorder: React Flow cannot run a drag in
 * happy-dom, and what is under test here is what the composer HANDS the canvas and what it does
 * with the callbacks the canvas reports — the canvas itself has its own suite in `packages/ui`.
 */
import { act, fireEvent, screen } from '@testing-library/react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { useEffect, type ReactNode } from 'react';
import { renderWithProviders } from '@/test/render';
import { GraphStoreProvider, useGraphStoreApi } from '../../../store';
import type { GraphStoreEdge, GraphStoreNode } from '../../../store/types';
import { REGISTRY } from '../../../lib/__tests__/registry-fixture';
import { ComposerCanvas } from '../composer-canvas';

type CanvasProps = Record<string, unknown> & {
  nodes: Array<Record<string, unknown> & { id: string }>;
  edges: Array<Record<string, unknown> & { id: string }>;
  onConnect: (connection: Record<string, unknown>) => void;
  isValidConnection: (connection: Record<string, unknown>) => boolean;
  onEdgeInsert: (edgeId: string) => void;
  onConnectEndOnPane: (from: { nodeId: string; handleId: string | null }, position: { x: number; y: number }) => void;
  onDeleteRequest: (nodeId: string) => void;
  onEdgeSelect: (edgeId: string | null) => void;
};
const captured: CanvasProps[] = [];
vi.mock('@arcaai/ui/components/workflow-canvas', () => ({
  WorkflowCanvas: (props: CanvasProps) => {
    captured.push(props);
    return <div data-testid="canvas" />;
  },
}));

vi.mock('../../../api/hooks', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../api/hooks')>();
  return {
    ...actual,
    useAgentOptions: () => ({
      data: [
        { slug: 'asr', name: 'ASR', task: 'SPEECH_TO_TEXT' },
        { slug: 'writer', name: 'Writer', task: 'TEXT_GENERATION' },
      ],
    }),
  };
});

beforeAll(() => {
  Element.prototype.scrollIntoView ??= function scrollIntoView() {};
});

const latest = () => captured.at(-1) as CanvasProps;

function node(id: string, type: string, config: Record<string, unknown> = {}, safetyClasses: string[] = []): GraphStoreNode {
  return { id, type, position: { x: 0, y: 0 }, safetyClasses, config };
}

const holder: { api: ReturnType<typeof useGraphStoreApi> | null } = { api: null };
function Capture({ children }: { children: ReactNode }) {
  const storeApi = useGraphStoreApi();
  useEffect(() => {
    holder.api = storeApi;
  }, [storeApi]);
  return <>{children}</>;
}

function mount(nodes: GraphStoreNode[], edges: GraphStoreEdge[] = []) {
  const view = renderWithProviders(
    <GraphStoreProvider>
      <Capture>
        <ComposerCanvas aria-label="graph" descriptorByType={REGISTRY} />
      </Capture>
    </GraphStoreProvider>,
  );
  act(() => holder.api?.getState().hydrate(nodes, edges));
  return view;
}

const START = node('t', 'core.trigger', { label: 'Start' }, ['mandatory']);
const ASR = node('asr1', 'core.agent', { agentRef: { slug: 'asr' }, label: 'Transcribe' });
const WRITER = node('w', 'core.agent', { agentRef: { slug: 'writer' }, label: 'Draft' });
const WRITER2 = node('w2', 'core.agent', { agentRef: { slug: 'writer' }, label: 'Second draft' });

describe('ComposerCanvas — what the canvas is handed', () => {
  beforeEach(() => {
    captured.length = 0;
  });

  it('draws an agent`s task fields as typed ports and labels a link with its mapping', () => {
    mount(
      [START, ASR, { ...WRITER, config: { ...WRITER.config, inputs: { message: { from: 'nodes.asr1.outputs.transcript' } } } }],
      [{ id: 'e1', source: 'asr1', sourceHandle: 'next', target: 'w', targetHandle: 'after' }],
    );
    const writer = latest().nodes.find((candidate) => candidate.id === 'w');
    expect((writer?.inputPorts as Array<{ id: string; type: string }>).map((port) => `${port.id}:${port.type}`)).toEqual(['in:message:text', 'in:context:json']);
    const edge = latest().edges.find((candidate) => candidate.id === 'e1');
    expect(edge).toMatchObject({ label: 'transcript → message', sourceHandle: 'out:transcript', targetHandle: 'in:message' });
  });

  it('raises a canvas problem for a required input with no source', () => {
    mount([START, ASR], [{ id: 'e1', source: 't', sourceHandle: 'next', target: 'asr1', targetHandle: 'after' }]);
    const asr = latest().nodes.find((candidate) => candidate.id === 'asr1');
    expect(asr?.problem).toMatchObject({ severity: 'ERROR' });
    expect(JSON.stringify(asr?.problem)).toMatch(/audio/);
  });
});

describe('ComposerCanvas — connecting', () => {
  beforeEach(() => {
    captured.length = 0;
  });

  it('auto-maps on connect: an ordering link plus the binding (D-C)', () => {
    mount([START, ASR, WRITER]);
    act(() => latest().onConnect({ source: 'asr1', sourceHandle: 'out:transcript', target: 'w', targetHandle: 'in:message' }));
    expect(holder.api?.getState().edges).toEqual([expect.objectContaining({ source: 'asr1', sourceHandle: 'next', target: 'w', targetHandle: 'after' })]);
    expect(holder.api?.getState().nodes.find((candidate) => candidate.id === 'w')?.config.inputs).toEqual({ message: { from: 'nodes.asr1.outputs.transcript' } });
  });

  it('refuses an incompatible pair while dragging and says why', () => {
    mount([START, ASR, WRITER]);
    let valid = true;
    act(() => {
      valid = latest().isValidConnection({ source: 'w', sourceHandle: 'out:text', target: 'asr1', targetHandle: 'in:audio' });
    });
    expect(valid).toBe(false);
    expect(screen.getByRole('status').textContent).toMatch(/audio/);
  });

  it('refuses a second producer into a single-value input and offers “Use first available” (OD-18, Q1)', () => {
    mount([START, WRITER, WRITER2, node('w3', 'core.agent', { agentRef: { slug: 'writer' }, label: 'Final', inputs: { message: { from: 'nodes.w.outputs.text' } } })], [
      { id: 'e1', source: 'w', sourceHandle: 'next', target: 'w3', targetHandle: 'after' },
    ]);
    act(() => latest().onConnect({ source: 'w2', sourceHandle: 'out:text', target: 'w3', targetHandle: 'in:message' }));
    expect(holder.api?.getState().edges).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Use first available' }));
    expect(holder.api?.getState().edges).toHaveLength(2);
    expect(holder.api?.getState().nodes.find((candidate) => candidate.id === 'w3')?.config.inputs).toEqual({
      message: { firstOf: ['nodes.w.outputs.text', 'nodes.w2.outputs.text'] },
    });
  });

  it('refuses deleting Start, saying why (W1)', () => {
    mount([START, ASR]);
    act(() => latest().onDeleteRequest('t'));
    expect(holder.api?.getState().nodes).toHaveLength(2);
    expect(screen.getByRole('status').textContent).toMatch(/can’t be deleted/);
  });

  it('selecting a link selects it in the store (the edge inspector)', () => {
    mount([START, ASR], [{ id: 'e1', source: 't', sourceHandle: 'next', target: 'asr1', targetHandle: 'after' }]);
    act(() => latest().onEdgeSelect('e1'));
    expect(holder.api?.getState().selectedEdgeId).toBe('e1');
  });
});

describe('ComposerCanvas — adding steps', () => {
  beforeEach(() => {
    captured.length = 0;
  });

  it('`+` on a link inserts the chosen step and re-wires both sides with auto-map', () => {
    mount([ASR, WRITER], [{ id: 'e1', source: 'asr1', sourceHandle: 'next', target: 'w', targetHandle: 'after' }]);
    act(() => latest().onEdgeInsert('e1'));
    fireEvent.click(screen.getByRole('option', { name: /merge/i }));
    const state = holder.api?.getState();
    const merge = state?.nodes.find((candidate) => candidate.type === 'core.data');
    expect(merge?.config.label).toBe('Merge');
    expect(state?.edges.map((edge) => `${edge.source}->${edge.target}`).sort()).toEqual([`asr1->${merge?.id}`, `${merge?.id}->w`].sort());
    expect(merge?.config.inputs).toEqual({ in: { from: 'nodes.asr1.outputs.transcript' } });
  });

  it('a link dropped on empty canvas opens the menu; the chosen step is added there and connected', () => {
    mount([START, ASR]);
    act(() => latest().onConnectEndOnPane({ nodeId: 'asr1', handleId: 'out:transcript' }, { x: 400, y: 120 }));
    fireEvent.click(screen.getByRole('option', { name: /^output\b/i }));
    const state = holder.api?.getState();
    const added = state?.nodes.find((candidate) => candidate.type === 'core.output');
    expect(added?.position).toEqual({ x: 400, y: 120 });
    expect(state?.edges.some((edge) => edge.source === 'asr1' && edge.target === added?.id)).toBe(true);
  });

  it('“Add a step” is the keyboard path to the same menu', () => {
    mount([START]);
    fireEvent.click(screen.getByRole('button', { name: /add a step/i }));
    expect(screen.getByRole('dialog', { name: /add a step/i })).toBeTruthy();
  });
});
