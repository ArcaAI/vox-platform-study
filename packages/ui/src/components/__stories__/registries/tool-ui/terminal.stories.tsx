import type { Meta, StoryObj } from '@storybook/react-vite';

import { Terminal } from '../../../registries/tool-ui/terminal';

const meta = {
  title: 'Registries/ToolUI/Terminal',
  component: Terminal,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof Terminal>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {
    id: '1',
    command: 'npm install',
    stdout: 'added 150 packages in 3s',
    exitCode: 0,
  },
};
