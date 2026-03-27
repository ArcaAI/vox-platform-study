import type { Meta, StoryObj } from '@storybook/react-vite';

import { ChatContainerContent, ChatContainerRoot, ChatContainerScrollAnchor } from '../../../registries/prompt-kit/chat-container';
import { ScrollButton } from '../../../registries/prompt-kit/scroll-button';

const meta = {
  title: 'Registries/PromptKit/ScrollButton',
  component: ScrollButton,
  parameters: { layout: 'padded' },
  tags: ['autodocs'],
} satisfies Meta<typeof ScrollButton>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => (
    <div className="relative h-64 w-80">
      <ChatContainerRoot className="h-full border rounded-lg">
        <ChatContainerContent>
          <div className="p-4 text-sm">Message 1</div>
          <div className="p-4 text-sm">Message 2</div>
          <div className="p-4 text-sm">Message 3</div>
          <div className="p-4 text-sm">Message 4</div>
          <div className="p-4 text-sm">Message 5</div>
          <ChatContainerScrollAnchor />
        </ChatContainerContent>
      </ChatContainerRoot>
      <div className="absolute bottom-4 right-4">
        <ScrollButton />
      </div>
    </div>
  ),
};
