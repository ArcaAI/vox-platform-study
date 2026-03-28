import type { Meta, StoryObj } from '@storybook/react-vite';

import { ConversationEmptyState } from '../../../registries/ai-elements/conversation';
import { MessageCircleIcon } from 'lucide-react';

const meta = {
  title: 'Registries/AiElements/Conversation',
  component: ConversationEmptyState,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof ConversationEmptyState>;

export default meta;
type Story = StoryObj<typeof meta>;

export const EmptyState: Story = {
  args: {
    title: 'Start a conversation',
    description: 'Send a message to begin chatting with the AI assistant.',
    icon: <MessageCircleIcon className="size-8" />,
  },
};

export const CustomEmptyState: Story = {
  args: {
    title: 'No messages yet',
    description: 'Ask me anything about your codebase.',
  },
};
