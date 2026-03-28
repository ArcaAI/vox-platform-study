import type { Meta, StoryObj } from '@storybook/react-vite';

import {
  ChainOfThought,
  ChainOfThoughtContent,
  ChainOfThoughtItem,
  ChainOfThoughtStep,
  ChainOfThoughtTrigger,
} from '../../../registries/prompt-kit/chain-of-thought';

const meta = {
  title: 'Registries/PromptKit/ChainOfThought',
  component: ChainOfThought,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof ChainOfThought>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {} as any,
  render: () => (
    <ChainOfThought>
      <ChainOfThoughtStep>
        <ChainOfThoughtItem>
          <ChainOfThoughtTrigger>First step</ChainOfThoughtTrigger>
          <ChainOfThoughtContent>Content for the first reasoning step.</ChainOfThoughtContent>
        </ChainOfThoughtItem>
      </ChainOfThoughtStep>
      <ChainOfThoughtStep>
        <ChainOfThoughtItem>
          <ChainOfThoughtTrigger>Second step</ChainOfThoughtTrigger>
          <ChainOfThoughtContent>Content for the second reasoning step.</ChainOfThoughtContent>
        </ChainOfThoughtItem>
      </ChainOfThoughtStep>
    </ChainOfThought>
  ),
};
