import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';

import { WorkflowToggle, type WorkflowMode } from '../../custom/workflow-toggle';

const meta = {
  title: 'Custom/WorkflowToggle',
  component: WorkflowToggle,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
  decorators: [
    (Story) => (
      <div className="w-[480px]">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof WorkflowToggle>;

export default meta;
type Story = StoryObj<typeof meta>;

export const LocalSelected: Story = {
  args: {
    mode: 'local',
    onChange: (mode) => console.log('Mode:', mode),
  },
};

export const RemoteSelected: Story = {
  args: {
    mode: 'remote',
    onChange: (mode) => console.log('Mode:', mode),
  },
};

export const WithLocalContent: Story = {
  args: {
    mode: 'local',
    onChange: (mode) => console.log('Mode:', mode),
    localContent: (
      <div className="space-y-2 text-sm">
        <p className="font-medium">Local models available:</p>
        <ul className="list-inside list-disc text-muted-foreground">
          <li>Whisper Small (245 MB)</li>
          <li>Whisper Medium (769 MB)</li>
        </ul>
      </div>
    ),
  },
};

export const WithRemoteContent: Story = {
  args: {
    mode: 'remote',
    onChange: (mode) => console.log('Mode:', mode),
    remoteContent: (
      <div className="space-y-2 text-sm">
        <p className="font-medium">Remote pipeline configuration:</p>
        <p className="text-muted-foreground">Connected to tenant pipeline at api.arcaai.com. Processing is handled server-side.</p>
      </div>
    ),
  },
};

function InteractiveDemo() {
  const [mode, setMode] = useState<WorkflowMode>('local');

  return (
    <WorkflowToggle
      mode={mode}
      onChange={setMode}
      localContent={<p className="text-sm text-muted-foreground">Running on-device with WebGPU acceleration.</p>}
      remoteContent={<p className="text-sm text-muted-foreground">Connected to cloud pipeline. Low-latency inference enabled.</p>}
    />
  );
}

export const Interactive: Story = {
  args: {} as any,
  render: () => <InteractiveDemo />,
};
