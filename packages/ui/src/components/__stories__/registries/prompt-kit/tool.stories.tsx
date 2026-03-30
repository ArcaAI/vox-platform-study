import type { Meta, StoryObj } from '@storybook/react-vite';

import { Tool } from '../../../registries/prompt-kit/tool';

const meta = {
  title: 'Registries/PromptKit/Tool',
  component: Tool,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof Tool>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {
    toolPart: {
      type: 'search',
      state: 'output-available',
      input: { query: 'machine learning' },
      output: { results: ['Result 1', 'Result 2', 'Result 3'] },
    },
  },
};
