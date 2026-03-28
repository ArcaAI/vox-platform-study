import type { Meta, StoryObj } from '@storybook/react-vite';

import { Reasoning, ReasoningContent, ReasoningTrigger } from '../../../registries/prompt-kit/reasoning';

const meta = {
  title: 'Registries/PromptKit/Reasoning',
  component: Reasoning,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof Reasoning>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {} as any,
  render: () => (
    <Reasoning>
      <ReasoningTrigger>Show reasoning</ReasoningTrigger>
      <ReasoningContent>This is the reasoning content that explains the step-by-step thought process behind the answer.</ReasoningContent>
    </Reasoning>
  ),
};
