import type { Meta, StoryObj } from '@storybook/react-vite'

import {
  ChatContainerContent,
  ChatContainerRoot,
  ChatContainerScrollAnchor,
} from '../../../registries/prompt-kit/chat-container'

const meta = {
  title: 'Registries/PromptKit/ChatContainer',
  component: ChatContainerRoot,
  parameters: { layout: 'padded' },
  tags: ['autodocs'],
} satisfies Meta<typeof ChatContainerRoot>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  args: {} as any,
  render: () => (
    <ChatContainerRoot className="h-64 border rounded-lg">
      <ChatContainerContent>
        <div className="p-4 text-sm">User: Hello, how are you?</div>
        <div className="p-4 text-sm">Assistant: I am doing well, thank you!</div>
        <div className="p-4 text-sm">User: What can you help me with?</div>
        <ChatContainerScrollAnchor />
      </ChatContainerContent>
    </ChatContainerRoot>
  ),
}
