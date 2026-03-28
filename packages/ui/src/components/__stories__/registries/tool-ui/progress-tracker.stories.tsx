import type { Meta, StoryObj } from '@storybook/react-vite';

import { ProgressTracker } from '../../../registries/tool-ui/progress-tracker';

const meta = {
  title: 'Registries/ToolUI/ProgressTracker',
  component: ProgressTracker,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof ProgressTracker>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {
    id: '1',
    steps: [
      { id: '1', label: 'Download', status: 'completed' },
      { id: '2', label: 'Install', status: 'in-progress' },
      { id: '3', label: 'Configure', status: 'pending' },
    ],
  },
};
