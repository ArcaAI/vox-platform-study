import type { Meta, StoryObj } from '@storybook/react-vite'

import {
  Message,
  MessageAction,
  MessageActions,
  MessageAvatar,
  MessageContent,
} from '../../../registries/prompt-kit/message'
import { Copy, ThumbsDown, ThumbsUp } from 'lucide-react'

const meta = {
  title: 'Registries/PromptKit/Message',
  component: Message,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof Message>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  args: {} as any,
  render: () => (
    <Message>
      <MessageAvatar src="https://github.com/shadcn.png" alt="User" />
      <MessageContent>Hello! This is a sample message content.</MessageContent>
    </Message>
  ),
}

export const WithActions: Story = {
  args: {} as any,
  render: () => (
    <Message>
      <MessageAvatar src="https://github.com/shadcn.png" alt="Assistant" />
      <div className="flex flex-col gap-2">
        <MessageContent>Here is the response with action buttons.</MessageContent>
        <MessageActions>
          <MessageAction tooltip="Copy">
            <button type="button" className="rounded p-1 hover:bg-muted">
              <Copy className="size-4" />
            </button>
          </MessageAction>
          <MessageAction tooltip="Helpful">
            <button type="button" className="rounded p-1 hover:bg-muted">
              <ThumbsUp className="size-4" />
            </button>
          </MessageAction>
          <MessageAction tooltip="Not helpful">
            <button type="button" className="rounded p-1 hover:bg-muted">
              <ThumbsDown className="size-4" />
            </button>
          </MessageAction>
        </MessageActions>
      </div>
    </Message>
  ),
}
