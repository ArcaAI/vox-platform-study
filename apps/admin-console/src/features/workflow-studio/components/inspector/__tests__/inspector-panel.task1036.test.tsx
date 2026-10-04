/**
 * TASK-1036 C2b — the inspector, composing:
 *
 *  - tabs are Config · Problems · Last run; the Run tab moved to the Studio's Test tab (C2a);
 *  - the agent picker (lane C5's signature) pins a version: `onChange(slug, versionNumber?)`
 *    writes `agentRef.versionNumber` and clears it when the picker passes none;
 *  - inside the editor's store: the step name, the Inputs panel (no raw `inputs` / prompt-variable
 *    JSON), Start/End say they can't be deleted (W1), and a selected LINK opens the edge view.
 */
import { act, fireEvent, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { NODE_CONFIG_SCHEMAS } from '@arcaai/workflow-contract';
import { renderWithProviders } from '@/test/render';
import { GraphStoreProvider, useGraphStoreApi } from '../../../store';
import type { GraphStoreEdge, GraphStoreNode } from '../../../store/types';
import { InspectorPanel } from '../inspector-panel';

const pickerProps: Array<Record<string, unknown>> = [];
vi.mock('../agent-picker-field', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../agent-picker-field')>();
  return {
    ...actual,
    AgentPickerField: (props: Record<string, unknown>) => {
      pickerProps.push(props);
      return <div data-testid="agent-picker" />;
    },
  };
});

vi.mock('../../../api/hooks', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../api/hooks')>();
  return {
    ...actual,
    useAgentOptions: () => ({
      data: [
        { slug: 'asr', name: 'ASR', task: 'SPEECH_TO_TEXT' },
        { slug: 'writer', name: 'Writer', task: 'TEXT_GENERATION', instruction: { variables: { tone: { value: 'warm' } } } },
      ],
    }),
  };
});

function node(id: string, type: string, config: Record<string, unknown> = {}): GraphStoreNode {
  return { id, type, position: { x: 0, y: 0 }, safetyClasses: [], config };
}

const NODES = [node('t', 'core.trigger', { label: 'Start' }), node('a', 'core.agent', { agentRef: { slug: 'asr' }, label: 'Transcribe' }), node('w', 'core.agent', { agentRef: { slug: 'writer' }, label: 'Draft' })];
const EDGES: GraphStoreEdge[] = [
  { id: 'e1', source: 't', sourceHandle: 'next', target: 'a', targetHandle: 'after' },
  { id: 'e2', source: 'a', sourceHandle: 'next', target: 'w', targetHandle: 'after' },
];

let api: ReturnType<typeof useGraphStoreApi> | null = null;
function Capture({ children }: { children: ReactNode }) {
  api = useGraphStoreApi();
  return <>{children}</>;
}

function renderInStore(ui: ReactNode) {
  return renderWithProviders(
    <GraphStoreProvider>
      <Capture>{ui}</Capture>
    </GraphStoreProvider>,
  );
}

describe('InspectorPanel — tabs (TASK-1036)', () => {
  it('offers Config, Problems and Last run — no Run tab', () => {
    renderWithProviders(<InspectorPanel tab="config" onTabChange={vi.fn()} node={null} configSchema={undefined} problems={[]} onConfigChange={vi.fn()} />);
    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['Config', 'Problems', 'Last run']);
  });

  it('shows the node`s last run in the Last run tab', () => {
    renderWithProviders(
      <InspectorPanel
        tab="lastRun"
        onTabChange={vi.fn()}
        node={NODES[1] as GraphStoreNode}
        configSchema={NODE_CONFIG_SCHEMAS['core.agent']}
        problems={[]}
        onConfigChange={vi.fn()}
        lastRunByNode={{ a: { status: 'SUCCEEDED', durationMs: 1200, inputs: {}, outputs: { transcript: 'hi' } } }}
      />,
    );
    expect(screen.getByText('1.2 s')).toBeTruthy();
  });
});

describe('InspectorPanel — agent version pin (lane C5 picker contract)', () => {
  it('passes the pinned version and writes slug + version, clearing the pin when none is given', () => {
    const onConfigChange = vi.fn();
    pickerProps.length = 0;
    renderWithProviders(
      <InspectorPanel
        tab="config"
        onTabChange={vi.fn()}
        node={node('w', 'core.agent', { agentRef: { slug: 'writer', versionNumber: 3 } })}
        configSchema={NODE_CONFIG_SCHEMAS['core.agent']}
        problems={[]}
        onConfigChange={onConfigChange}
      />,
    );
    const props = pickerProps.at(-1) as { versionNumber?: number; onChange: (slug: string, version?: number) => void };
    expect(props.versionNumber).toBe(3);
    act(() => props.onChange('soap', 4));
    expect(onConfigChange).toHaveBeenLastCalledWith(expect.objectContaining({ agentRef: { slug: 'soap', versionNumber: 4 } }));
    act(() => props.onChange('soap'));
    expect(onConfigChange).toHaveBeenLastCalledWith(expect.objectContaining({ agentRef: { slug: 'soap' } }));
  });
});

describe('InspectorPanel — composing inside the editor store', () => {
  function Mounted({ nodeId }: { nodeId: string | null }) {
    return (
      <InspectorPanel
        tab="config"
        onTabChange={vi.fn()}
        node={nodeId ? (NODES.find((candidate) => candidate.id === nodeId) ?? null) : null}
        configSchema={nodeId ? NODE_CONFIG_SCHEMAS[NODES.find((candidate) => candidate.id === nodeId)?.type ?? ''] : undefined}
        problems={[]}
        onConfigChange={vi.fn()}
      />
    );
  }

  it('renders the step name and the Inputs panel, never the raw `inputs` / prompt-variable JSON', () => {
    renderInStore(<Mounted nodeId="w" />);
    act(() => api?.getState().hydrate(NODES, EDGES));
    expect(screen.getByRole('textbox', { name: /step name/i })).toBeTruthy();
    const inputs = screen.getByRole('region', { name: /inputs/i });
    expect(within(inputs).getByText('message')).toBeTruthy();
    expect(within(inputs).getByText('tone')).toBeTruthy();
    expect(screen.queryByRole('textbox', { name: /^inputs/i })).toBeNull();
  });

  it('tells the author Start and End can`t be deleted (W1)', () => {
    renderInStore(<Mounted nodeId="t" />);
    act(() => api?.getState().hydrate(NODES, EDGES));
    expect(screen.getByText(/part of every workflow and can’t be deleted/)).toBeTruthy();
  });

  it('opens the link view for a selected edge, and deletes it through the store', () => {
    renderInStore(<Mounted nodeId={null} />);
    act(() => {
      api?.getState().hydrate(NODES, EDGES);
      api?.getState().selectEdge('e2');
    });
    expect(screen.getByRole('region', { name: 'Link' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /delete this link/i }));
    expect(api?.getState().edges.map((edge) => edge.id)).toEqual(['e1']);
  });
});
