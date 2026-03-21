import type { Meta, StoryObj } from '@storybook/react-vite'

import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from '../../elevenlabs/conversation'
import { Message, MessageContent, MessageAvatar } from '../../elevenlabs/message'

const meta: Meta<typeof Conversation> = {
  title: 'ElevenLabs/Conversation',
  component: Conversation,
  parameters: {
    layout: 'fullscreen',
  },
  tags: ['autodocs'],
}

export default meta
type Story = StoryObj<typeof Conversation>

export const EmptyState: Story = {
  render: () => (
    <div className="h-[400px]">
      <Conversation>
        <ConversationContent>
          <ConversationEmptyState />
        </ConversationContent>
      </Conversation>
    </div>
  ),
}

export const CustomEmptyState: Story = {
  render: () => (
    <div className="h-[400px]">
      <Conversation>
        <ConversationContent>
          <ConversationEmptyState
            title="Welcome!"
            description="Ask me anything to get started."
          />
        </ConversationContent>
      </Conversation>
    </div>
  ),
}

export const WithMessages: Story = {
  render: () => (
    <div className="h-[400px]">
      <Conversation>
        <ConversationContent>
          <Message from="user">
            <MessageAvatar src="https://github.com/shadcn.png" name="User" />
            <MessageContent>Hello! Can you help me?</MessageContent>
          </Message>
          <Message from="assistant">
            <MessageAvatar src="https://github.com/vercel.png" name="AI" />
            <MessageContent>
              Of course! I am here to help. What do you need assistance with?
            </MessageContent>
          </Message>
          <Message from="user">
            <MessageAvatar src="https://github.com/shadcn.png" name="User" />
            <MessageContent>
              I need help understanding how to use the ElevenLabs API.
            </MessageContent>
          </Message>
          <Message from="assistant">
            <MessageAvatar src="https://github.com/vercel.png" name="AI" />
            <MessageContent>
              The ElevenLabs API allows you to generate speech from text, clone
              voices, and build conversational AI agents. Would you like me to
              walk you through the basics?
            </MessageContent>
          </Message>
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>
    </div>
  ),
}

export const ManyMessages: Story = {
  render: () => (
    <div className="h-[400px]">
      <Conversation>
        <ConversationContent>
          {Array.from({ length: 20 }).map((_, i) => (
            <Message key={i} from={i % 2 === 0 ? 'user' : 'assistant'}>
              <MessageContent>
                {i % 2 === 0
                  ? `User message ${Math.floor(i / 2) + 1}`
                  : `Assistant response ${Math.floor(i / 2) + 1}. This is a longer response to demonstrate scrolling behavior.`}
              </MessageContent>
            </Message>
          ))}
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>
    </div>
  ),
}
