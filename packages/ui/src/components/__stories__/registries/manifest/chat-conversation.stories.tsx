import type { Meta, StoryObj } from '@storybook/react-vite';

import { ChatConversation } from '../../../registries/manifest/chat-conversation';

const meta = {
  title: 'Registries/Manifest/ChatConversation',
  component: ChatConversation,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof ChatConversation>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => <ChatConversation />,
};
