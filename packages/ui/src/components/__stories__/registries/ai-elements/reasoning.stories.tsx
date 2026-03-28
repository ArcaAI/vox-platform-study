import type { Meta, StoryObj } from '@storybook/react-vite';

import { Reasoning, ReasoningTrigger, ReasoningContent } from '../../../registries/ai-elements/reasoning';

const meta = {
  title: 'Registries/AiElements/Reasoning',
  component: Reasoning,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof Reasoning>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {} as any,
  render: () => (
    <div className="w-[500px]">
      <Reasoning defaultOpen>
        <ReasoningTrigger />
        <ReasoningContent>
          The user is asking about React hooks. Let me think about the best way to explain useEffect and its dependency array...
        </ReasoningContent>
      </Reasoning>
    </div>
  ),
};

export const Streaming: Story = {
  args: {} as any,
  render: () => (
    <div className="w-[500px]">
      <Reasoning isStreaming defaultOpen>
        <ReasoningTrigger />
        <ReasoningContent>Analyzing the codebase structure...</ReasoningContent>
      </Reasoning>
    </div>
  ),
};

export const WithDuration: Story = {
  args: {} as any,
  render: () => (
    <div className="w-[500px]">
      <Reasoning duration={12} defaultOpen>
        <ReasoningTrigger />
        <ReasoningContent>
          After careful analysis, the optimal approach involves restructuring the data layer to use a normalized state pattern.
        </ReasoningContent>
      </Reasoning>
    </div>
  ),
};
