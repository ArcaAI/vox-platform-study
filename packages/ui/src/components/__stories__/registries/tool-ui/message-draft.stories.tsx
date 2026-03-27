import type { Meta, StoryObj } from '@storybook/react-vite';

import { MessageDraft } from '../../../registries/tool-ui/message-draft';

const meta = {
  title: 'Registries/ToolUI/MessageDraft',
  component: MessageDraft,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof MessageDraft>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {} as any,
  render: () => <MessageDraft id="1" channel="email" to={['user@example.com']} subject="Hello" body="This is a draft message." />,
};
