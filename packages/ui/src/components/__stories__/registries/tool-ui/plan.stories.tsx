import type { Meta, StoryObj } from '@storybook/react-vite';

import { Plan } from '../../../registries/tool-ui/plan';

const meta = {
  title: 'Registries/ToolUI/Plan',
  component: Plan,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof Plan>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {
    id: '1',
    title: 'Project Plan',
    todos: [
      { id: '1', label: 'Research', status: 'completed' },
      { id: '2', label: 'Implementation', status: 'in_progress' },
      { id: '3', label: 'Testing', status: 'pending' },
    ],
  },
};
