import type { Meta, StoryObj } from '@storybook/react-vite'

import { ConversationBar } from '../../elevenlabs/conversation-bar'

const meta: Meta<typeof ConversationBar> = {
  title: 'ElevenLabs/ConversationBar',
  component: ConversationBar,
  parameters: {
    layout: 'centered',
  },
  tags: ['autodocs'],
  argTypes: {
    agentId: {
      control: 'text',
      description: 'ElevenLabs Agent ID',
    },
  },
}

export default meta
type Story = StoryObj<typeof ConversationBar>

export const Default: Story = {
  args: {
    agentId: 'demo-agent-id',
  },
  render: (args) => (
    <div className="w-[500px]">
      <ConversationBar {...args} />
    </div>
  ),
}

export const WithCallbacks: Story = {
  args: {
    agentId: 'demo-agent-id',
    onConnect: () => console.log('Connected'),
    onDisconnect: () => console.log('Disconnected'),
    onMessage: (msg) => console.log('Message:', msg),
    onError: (err) => console.error('Error:', err),
  },
  render: (args) => (
    <div className="w-[500px]">
      <ConversationBar {...args} />
    </div>
  ),
}

export const FullWidth: Story = {
  args: {
    agentId: 'demo-agent-id',
  },
  render: (args) => (
    <div className="w-full max-w-2xl">
      <ConversationBar {...args} />
    </div>
  ),
}
