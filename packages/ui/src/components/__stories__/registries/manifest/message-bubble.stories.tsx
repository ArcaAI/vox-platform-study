import type { Meta, StoryObj } from '@storybook/react-vite';

import { MessageBubble } from '../../../registries/manifest/message-bubble';

const meta = {
  title: 'Registries/Manifest/MessageBubble',
  component: MessageBubble,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof MessageBubble>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => <MessageBubble />,
};
