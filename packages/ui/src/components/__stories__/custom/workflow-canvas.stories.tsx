import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { WorkflowCanvas } from '../../workflow-canvas/workflow-canvas';
import type { WorkflowCanvasEdge, WorkflowCanvasNode } from '../../workflow-canvas/types';

const NODES: WorkflowCanvasNode[] = [
  { id: 'ingest', type: 'stt.ingest', label: 'Ingest audio', position: { x: 0, y: 0 }, safetyClasses: ['mandatory'] },
  { id: 'redact', type: 'phi.redact', label: 'Redact PHI', position: { x: 260, y: -60 }, safetyClasses: ['mandatory', 'phiBearing'] },
  {
    id: 'summarize',
    type: 'text.summarize',
    label: 'Summarize',
    position: { x: 260, y: 100 },
    problem: { severity: 'ERROR', messages: ['Missing required field: prompt template'] },
  },
  { id: 'finalize', type: 'harness.finalize', label: 'Finalize', position: { x: 520, y: 20 } },
];

const EDGES: WorkflowCanvasEdge[] = [
  { id: 'ingest-redact', source: 'ingest', target: 'redact' },
  { id: 'ingest-summarize', source: 'ingest', target: 'summarize' },
  { id: 'redact-finalize', source: 'redact', target: 'finalize' },
  { id: 'summarize-finalize', source: 'summarize', target: 'finalize' },
];

const meta = {
  title: 'Custom/WorkflowCanvas',
  component: WorkflowCanvas,
  parameters: { layout: 'fullscreen' },
  tags: ['autodocs'],
  decorators: [
    (Story) => (
      <div className="h-[520px] w-full">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof WorkflowCanvas>;

export default meta;
type Story = StoryObj<typeof meta>;

function Editable() {
  const [nodes, setNodes] = useState(NODES);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  return (
    <WorkflowCanvas
      nodes={nodes}
      edges={EDGES}
      selectedNodeId={selectedNodeId}
      aria-label="Summarization workflow canvas"
      onNodesChange={setNodes}
      onSelect={setSelectedNodeId}
      onDeleteRequest={(nodeId) => setNodes((current) => current.filter((node) => node.id !== nodeId))}
    />
  );
}

/** Default draft: two mandatory nodes pre-placed and non-deletable, one node with a blocking validation problem. */
export const Default: Story = {
  args: { nodes: NODES, edges: EDGES, 'aria-label': 'Summarization workflow canvas' },
  render: () => <Editable />,
};

/** Same graph rendered read-only — no remove affordance, no drag/connect. Used for published/pinned versions and future run overlay. */
export const ReadOnly: Story = {
  args: { nodes: NODES, edges: EDGES, readOnly: true, 'aria-label': 'Summarization workflow canvas (read-only)' },
  render: (args) => <WorkflowCanvas {...args} />,
};

/** Empty graph — the state before the registry's mandatory nodes are placed, or an empty registry ( not landed). */
export const Empty: Story = {
  args: { nodes: [], edges: [], 'aria-label': 'Empty workflow canvas' },
  render: (args) => <WorkflowCanvas {...args} />,
};
