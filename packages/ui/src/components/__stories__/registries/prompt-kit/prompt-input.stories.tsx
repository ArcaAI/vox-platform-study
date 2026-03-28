import type { Meta, StoryObj } from '@storybook/react-vite';

import { PromptInput, PromptInputAction, PromptInputActions, PromptInputTextarea } from '../../../registries/prompt-kit/prompt-input';
import { Send } from 'lucide-react';

const meta = {
  title: 'Registries/PromptKit/PromptInput',
  component: PromptInput,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof PromptInput>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {} as any,
  render: () => (
    <PromptInput className="w-96">
      <PromptInputTextarea placeholder="Type your message..." />
      <PromptInputActions>
        <PromptInputAction tooltip="Send">
          <button type="button" className="rounded p-1.5 hover:bg-muted">
            <Send className="size-4" />
          </button>
        </PromptInputAction>
      </PromptInputActions>
    </PromptInput>
  ),
};
