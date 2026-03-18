import type { Meta, StoryObj } from '@storybook/react-vite'

import {
  Message,
  MessageContent,
  MessageResponse,
  MessageActions,
  MessageAction,
} from '../../../registries/ai-elements/message'
import { CopyIcon, ThumbsDownIcon, ThumbsUpIcon } from 'lucide-react'

const meta = {
  title: 'Registries/AiElements/Message',
  component: Message,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof Message>

export default meta
type Story = StoryObj<typeof meta>

export const UserMessage: Story = {
  args: {} as any,
  render: () => (
    <div className="w-[500px]">
      <Message from="user">
        <MessageContent>How do I use React hooks?</MessageContent>
      </Message>
    </div>
  ),
}

export const AssistantMessage: Story = {
  args: {} as any,
  render: () => (
    <div className="w-[500px]">
      <Message from="assistant">
        <MessageContent>
          <MessageResponse>
            React hooks let you use state and other React features in function
            components. The most common hooks are `useState` and `useEffect`.
          </MessageResponse>
        </MessageContent>
        <MessageActions>
          <MessageAction tooltip="Copy">
            <CopyIcon className="size-4" />
          </MessageAction>
          <MessageAction tooltip="Like">
            <ThumbsUpIcon className="size-4" />
          </MessageAction>
          <MessageAction tooltip="Dislike">
            <ThumbsDownIcon className="size-4" />
          </MessageAction>
        </MessageActions>
      </Message>
    </div>
  ),
}
